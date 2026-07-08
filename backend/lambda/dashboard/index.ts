import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { BedrockAgentClient, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3Client = new S3Client({});
const bedrockAgent = new BedrockAgentClient({});

// Config from environment (set by the CDK construct from shared-resource references)
const CHAT_LOGS_TABLE = process.env.CHAT_LOGS_TABLE!;
const ANALYTICS_LOGS_TABLE = process.env.ANALYTICS_LOGS_TABLE!;
const DOCUMENT_BUCKET = process.env.DOCUMENT_BUCKET!;
const KB_BUCKET = process.env.KB_BUCKET!;
const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID!;
const DATA_SOURCE_ID = process.env.DATA_SOURCE_ID!;

// Allowed content types for upload
const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.ms-excel',
];

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB (advisory hint returned to the client)

// ─────────────────────────────────────────────────────────────────────────────
// Auth & Helpers
// ─────────────────────────────────────────────────────────────────────────────

function respond(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

/**
 * Validates that the caller belongs to the 'admin' Cognito group.
 * Returns null if authorized, or an error response if not.
 */
function validateAdmin(event: APIGatewayProxyEvent): APIGatewayProxyResult | null {
  const claims = event.requestContext?.authorizer?.claims;
  if (!claims) {
    return respond(401, { message: 'Unauthorized: No authentication claims found' });
  }

  const groups: string | string[] = claims['cognito:groups'] || '';
  const groupList = Array.isArray(groups) ? groups : groups.split(',').map((g: string) => g.trim());

  if (!groupList.includes('admin')) {
    return respond(403, { message: 'Forbidden: Admin group membership required' });
  }

  return null;
}

/**
 * Validates an S3 key is safe — must start with the allowed prefix, no traversal.
 */
function validateS3Key(key: string, allowedPrefix: string): boolean {
  if (!key) return false;
  if (key.includes('..')) return false;
  if (!key.startsWith(allowedPrefix)) return false;
  if (/[\x00-\x1f]/.test(key)) return false;
  return true;
}

/**
 * Sanitize a filename — strip path separators, limit length.
 */
function sanitizeFileName(fileName: string): string {
  let safe = fileName.replace(/[/\\]/g, '_').replace(/\.\./g, '');
  if (safe.length > 200) safe = safe.substring(0, 200);
  if (!safe || safe === '_') return '';
  return safe;
}

/**
 * Starts a Bedrock KB ingestion job so the vector store reflects the current
 * contents of the KB bucket (removes deleted documents). Best-effort: only one
 * job runs per data source at a time, so a conflict is logged, not surfaced.
 */
async function syncKnowledgeBase(): Promise<void> {
  try {
    await bedrockAgent.send(new StartIngestionJobCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      dataSourceId: DATA_SOURCE_ID,
    }));
  } catch (err) {
    console.error('Failed to start KB ingestion after document change:', err);
  }
}

/**
 * Paginated scan with an optional time filter to bound the returned data.
 * NOTE: a FilterExpression still reads the whole table — for true scale this
 * should become a timestamp-ranged query on a GSI (tracked separately).
 */
async function scanWithTimeFilter(tableName: string, daysBack?: number): Promise<Record<string, any>[]> {
  const allItems: Record<string, any>[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;

  let filterExpression: string | undefined;
  let expressionValues: Record<string, any> | undefined;
  if (daysBack) {
    const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString();
    filterExpression = '#ts >= :cutoff';
    expressionValues = { ':cutoff': cutoff };
  }

  do {
    const params: any = { TableName: tableName, ExclusiveStartKey: lastEvaluatedKey };
    if (filterExpression) {
      params.FilterExpression = filterExpression;
      params.ExpressionAttributeValues = expressionValues;
      params.ExpressionAttributeNames = { '#ts': 'timestamp' };
    }
    const result = await ddbDocClient.send(new ScanCommand(params));
    allItems.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return allItems;
}

/**
 * Query by partition key on the AnalyticsLogs table.
 */
async function queryByEventType(eventType: string): Promise<Record<string, any>[]> {
  const allItems: Record<string, any>[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;

  do {
    const result = await ddbDocClient.send(new QueryCommand({
      TableName: ANALYTICS_LOGS_TABLE,
      KeyConditionExpression: 'eventType = :et',
      ExpressionAttributeValues: { ':et': eventType },
      ExclusiveStartKey: lastEvaluatedKey,
    }));
    allItems.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return allItems;
}

/**
 * Shared FAQ aggregation — normalizes and groups questions by frequency.
 */
function aggregateFaq(chatItems: Record<string, any>[]): {
  question: string; count: number; avgConfidence: number; escalatedCount: number; lastAsked: string;
}[] {
  const groups: Record<string, {
    question: string; count: number; confidenceSum: number; escalatedCount: number; lastAsked: string;
  }> = {};

  for (const item of chatItems) {
    const q = (item.question as string || '').trim();
    if (!q) continue;
    const key = q.toLowerCase().replace(/\s+/g, ' ').replace(/[?.!]+$/, '');
    if (!groups[key]) {
      groups[key] = { question: q, count: 0, confidenceSum: 0, escalatedCount: 0, lastAsked: '' };
    }
    groups[key].count++;
    if (typeof item.confidence === 'number') groups[key].confidenceSum += item.confidence;
    if (item.escalated) groups[key].escalatedCount++;
    if (item.timestamp > groups[key].lastAsked) groups[key].lastAsked = item.timestamp;
  }

  return Object.values(groups)
    .map(g => ({
      question: g.question,
      count: g.count,
      avgConfidence: g.count > 0 ? Math.round((g.confidenceSum / g.count) * 10000) / 10000 : 0,
      escalatedCount: g.escalatedCount,
      lastAsked: g.lastAsked,
    }))
    .sort((a, b) => b.count - a.count);
}

// ─────────────────────────────────────────────────────────────────────────────
// Route handlers
// ─────────────────────────────────────────────────────────────────────────────

// GET /dashboard/summary
async function getSummary(): Promise<APIGatewayProxyResult> {
  const [chatItems, escalationItems, docItems] = await Promise.all([
    scanWithTimeFilter(CHAT_LOGS_TABLE, 90),
    queryByEventType('escalation'),
    queryByEventType('document_processing'),
  ]);

  const totalChats = chatItems.length;
  const uniqueSessions = new Set(chatItems.map(i => i.sessionId)).size;
  const uniqueUsers = new Set(chatItems.map(i => i.userId).filter(Boolean)).size;

  const confidences = chatItems
    .map(i => i.confidence as number)
    .filter(c => typeof c === 'number' && !isNaN(c));
  const avgConfidence = confidences.length > 0
    ? confidences.reduce((s, c) => s + c, 0) / confidences.length
    : 0;

  const totalEscalations = escalationItems.length;
  const escalationRate = totalChats > 0 ? (totalEscalations / totalChats) * 100 : 0;

  const withFeedback = chatItems.filter(i => i.feedback === 'positive' || i.feedback === 'negative');
  const positiveCount = withFeedback.filter(i => i.feedback === 'positive').length;
  const negativeCount = withFeedback.filter(i => i.feedback === 'negative').length;
  const satisfactionRate = withFeedback.length > 0 ? (positiveCount / withFeedback.length) * 100 : 0;

  const sessionTimes: Record<string, { first: number; last: number; count: number }> = {};
  for (const item of chatItems) {
    const sid = item.sessionId;
    const ts = new Date(item.timestamp).getTime();
    if (!sessionTimes[sid]) {
      sessionTimes[sid] = { first: ts, last: ts, count: 1 };
    } else {
      sessionTimes[sid].first = Math.min(sessionTimes[sid].first, ts);
      sessionTimes[sid].last = Math.max(sessionTimes[sid].last, ts);
      sessionTimes[sid].count++;
    }
  }
  const durations = Object.values(sessionTimes).filter(s => s.count > 1).map(s => s.last - s.first);
  const avgMs = durations.length > 0 ? durations.reduce((s, d) => s + d, 0) / durations.length : 0;

  return respond(200, {
    totalChats,
    totalSessions: uniqueSessions,
    totalUsers: uniqueUsers,
    avgConfidence: Math.round(avgConfidence * 10000) / 10000,
    avgSessionLength: `${Math.floor(avgMs / 60000)}m ${Math.floor((avgMs % 60000) / 1000)}s`,
    avgSessionMs: avgMs,
    totalEscalations,
    escalationRate: Math.round(escalationRate * 100) / 100,
    totalDocuments: docItems.length,
    satisfactionRate: Math.round(satisfactionRate * 100) / 100,
    positiveCount,
    negativeCount,
    totalFeedback: withFeedback.length,
    feedbackNote: withFeedback.length === 0 ? 'Feedback tracking pending chatbot integration' : undefined,
  });
}

// GET /dashboard/conversations?period=day|week|month
async function getConversations(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const period = (event.queryStringParameters?.period as 'day' | 'week' | 'month') || 'day';
  const chatItems = await scanWithTimeFilter(CHAT_LOGS_TABLE, 90);

  const counts: Record<string, number> = {};
  for (const item of chatItems) {
    const timestamp = item.timestamp as string;
    if (!timestamp) continue;
    const date = new Date(timestamp);
    let dateKey: string;
    switch (period) {
      case 'day': dateKey = timestamp.slice(0, 10); break;
      case 'week': {
        const day = date.getDay();
        const diff = date.getDate() - day + (day === 0 ? -6 : 1);
        const mon = new Date(date); mon.setDate(diff);
        dateKey = mon.toISOString().slice(0, 10); break;
      }
      case 'month': dateKey = timestamp.slice(0, 7); break;
    }
    counts[dateKey] = (counts[dateKey] || 0) + 1;
  }

  const data = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  return respond(200, { period, data, total: chatItems.length });
}

// GET /dashboard/faq?limit=5
async function getFaq(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const limit = Math.min(parseInt(event.queryStringParameters?.limit || '5', 10), 100);
  const chatItems = await scanWithTimeFilter(CHAT_LOGS_TABLE, 30);
  const allFaq = aggregateFaq(chatItems);
  return respond(200, { faq: allFaq.slice(0, limit), totalUnique: allFaq.length });
}

// GET /dashboard/faq/all?limit=30&offset=0
async function getFaqAll(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const limit = Math.min(parseInt(event.queryStringParameters?.limit || '30', 10), 100);
  const offset = parseInt(event.queryStringParameters?.offset || '0', 10);
  const chatItems = await scanWithTimeFilter(CHAT_LOGS_TABLE, 90);
  const allFaq = aggregateFaq(chatItems);
  return respond(200, { faq: allFaq.slice(offset, offset + limit), total: allFaq.length, offset, limit });
}

// GET /dashboard/confidence?period=day|week|month
async function getConfidence(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const period = (event.queryStringParameters?.period as 'day' | 'week' | 'month') || 'day';
  const chatItems = await scanWithTimeFilter(CHAT_LOGS_TABLE, 90);
  const validItems = chatItems.filter(i => typeof i.confidence === 'number' && !isNaN(i.confidence));

  const distribution = { veryLow: 0, low: 0, medium: 0, high: 0, veryHigh: 0 };
  for (const item of validItems) {
    const c = item.confidence as number;
    if (c < 0.2) distribution.veryLow++;
    else if (c < 0.4) distribution.low++;
    else if (c < 0.6) distribution.medium++;
    else if (c < 0.8) distribution.high++;
    else distribution.veryHigh++;
  }

  const trend: Record<string, { sum: number; count: number }> = {};
  for (const item of validItems) {
    const ts = item.timestamp as string;
    if (!ts) continue;
    const date = new Date(ts);
    let dateKey: string;
    switch (period) {
      case 'day': dateKey = ts.slice(0, 10); break;
      case 'week': {
        const day = date.getDay();
        const diff = date.getDate() - day + (day === 0 ? -6 : 1);
        const mon = new Date(date); mon.setDate(diff);
        dateKey = mon.toISOString().slice(0, 10); break;
      }
      case 'month': dateKey = ts.slice(0, 7); break;
    }
    if (!trend[dateKey]) trend[dateKey] = { sum: 0, count: 0 };
    trend[dateKey].sum += item.confidence as number;
    trend[dateKey].count++;
  }

  const trendData = Object.entries(trend)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({ date, avgConfidence: Math.round((d.sum / d.count) * 10000) / 10000, count: d.count }));

  const all = validItems.map(i => i.confidence as number);
  const sorted = [...all].sort((a, b) => a - b);
  const avg = all.length > 0 ? all.reduce((s, c) => s + c, 0) / all.length : 0;

  return respond(200, {
    distribution, trend: trendData,
    stats: {
      total: all.length,
      average: Math.round(avg * 10000) / 10000,
      median: sorted.length > 0 ? Math.round(sorted[Math.floor(sorted.length / 2)] * 10000) / 10000 : 0,
      min: sorted.length > 0 ? Math.round(sorted[0] * 10000) / 10000 : 0,
      max: sorted.length > 0 ? Math.round(sorted[sorted.length - 1] * 10000) / 10000 : 0,
    },
  });
}

// GET /dashboard/escalations
async function getEscalations(): Promise<APIGatewayProxyResult> {
  const items = await queryByEventType('escalation');
  const grouped: Record<string, { count: number; lastOccurred: string; confSum: number }> = {};
  for (const item of items) {
    const reason = (item.reason as string) || (item.metadata?.reason as string) || 'unknown';
    const ts = item.timestamp as string;
    const conf = (item.metadata?.confidence as number) || 0;
    if (!grouped[reason]) grouped[reason] = { count: 0, lastOccurred: '', confSum: 0 };
    grouped[reason].count++;
    grouped[reason].confSum += conf;
    if (ts > grouped[reason].lastOccurred) grouped[reason].lastOccurred = ts;
  }
  const escalations = Object.entries(grouped)
    .map(([reason, d]) => ({
      reason, count: d.count, lastOccurred: d.lastOccurred,
      avgConfidence: d.count > 0 ? Math.round((d.confSum / d.count) * 10000) / 10000 : 0,
    }))
    .sort((a, b) => b.count - a.count);
  return respond(200, { escalations, total: items.length });
}

// GET /dashboard/negative-feedback?limit=50&offset=0
async function getNegativeFeedback(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const limit = Math.min(parseInt(event.queryStringParameters?.limit || '50', 10), 200);
  const offset = parseInt(event.queryStringParameters?.offset || '0', 10);
  const chatItems = await scanWithTimeFilter(CHAT_LOGS_TABLE, 90);

  const negativeItems = chatItems
    .filter(i => i.feedback === 'negative')
    .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  const total = negativeItems.length;
  const paginated = negativeItems.slice(offset, offset + limit);

  return respond(200, {
    total, offset, limit,
    conversations: paginated.map(item => ({
      sessionId: item.sessionId,
      timestamp: item.timestamp,
      userId: item.userId,
      question: item.question,
      answer: item.answer,
      confidence: typeof item.confidence === 'number' ? Math.round(item.confidence * 10000) / 10000 : 0,
      sources: item.sources || [],
      escalated: item.escalated || false,
    })),
    note: total === 0 ? 'Feedback tracking pending chatbot integration — no feedback data exists yet' : undefined,
  });
}

// GET /dashboard/documents — list files from S3
async function getDocuments(): Promise<APIGatewayProxyResult> {
  const listResult = await s3Client.send(new ListObjectsV2Command({
    Bucket: DOCUMENT_BUCKET,
    Prefix: 'uploads/',
  }));

  const documents = (listResult.Contents || [])
    .filter(obj => obj.Key && obj.Key !== 'uploads/')
    .map(obj => ({
      key: obj.Key!,
      fileName: obj.Key!.replace('uploads/', ''),
      fileSize: obj.Size || 0,
      lastModified: obj.LastModified?.toISOString() || '',
    }))
    .sort((a, b) => b.lastModified.localeCompare(a.lastModified));

  return respond(200, { documents, total: documents.length });
}

// GET /dashboard/documents/download?key=uploads/filename.pdf
async function getDocumentDownloadUrl(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const key = event.queryStringParameters?.key;
  if (!key) return respond(400, { message: 'key parameter is required' });
  if (!validateS3Key(key, 'uploads/')) return respond(403, { message: 'Invalid document key' });

  const url = await getSignedUrl(s3Client, new GetObjectCommand({
    Bucket: DOCUMENT_BUCKET,
    Key: key,
  }), { expiresIn: 300 });

  return respond(200, { url, key });
}

// DELETE /dashboard/documents?key=uploads/filename.pdf
async function deleteDocument(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const key = event.queryStringParameters?.key;
  if (!key) return respond(400, { message: 'key parameter is required' });
  if (!validateS3Key(key, 'uploads/')) return respond(403, { message: 'Invalid document key' });

  await s3Client.send(new DeleteObjectCommand({ Bucket: DOCUMENT_BUCKET, Key: key }));

  // Remove the copy from the KB bucket so it stops being ingested
  const kbKey = `documents/${key.replace('uploads/', '')}`;
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: KB_BUCKET, Key: kbKey }));
  } catch (err) {
    console.log('KB bucket delete skipped:', kbKey);
  }

  // Re-sync the knowledge base so the deleted document's vectors are removed and
  // it stops appearing in chat answers.
  await syncKnowledgeBase();

  return respond(200, { status: 'deleted', key });
}

// POST /dashboard/documents/upload
async function getUploadUrl(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { message: 'Request body must be valid JSON' });
  }
  const fileName = body.fileName as string | undefined;
  const contentType = body.contentType as string | undefined;

  if (!fileName) return respond(400, { message: 'fileName is required' });

  const safeName = sanitizeFileName(fileName);
  if (!safeName) return respond(400, { message: 'Invalid fileName' });

  const ct = contentType || 'application/pdf';
  if (!ALLOWED_CONTENT_TYPES.includes(ct)) {
    return respond(400, { message: `Content type not allowed. Allowed: ${ALLOWED_CONTENT_TYPES.join(', ')}` });
  }

  const key = `uploads/${safeName}`;

  // Presigned PUT for the browser to upload directly to S3.
  // NOTE: a strict server-side size cap requires a presigned POST with a
  // content-length-range condition (would change the client upload flow);
  // tracked as a follow-up. MAX_FILE_SIZE_BYTES is returned as a client hint.
  const url = await getSignedUrl(s3Client, new PutObjectCommand({
    Bucket: DOCUMENT_BUCKET,
    Key: key,
    ContentType: ct,
  }), { expiresIn: 300 });

  return respond(200, { url, key, maxSizeBytes: MAX_FILE_SIZE_BYTES });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route map — explicit method + path dispatch
// ─────────────────────────────────────────────────────────────────────────────

type RouteHandler = (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;

const routes: Record<string, Record<string, RouteHandler>> = {
  GET: {
    '/dashboard/summary': getSummary,
    '/dashboard/conversations': getConversations,
    '/dashboard/faq': getFaq,
    '/dashboard/faq/all': getFaqAll,
    '/dashboard/confidence': getConfidence,
    '/dashboard/escalations': getEscalations,
    '/dashboard/negative-feedback': getNegativeFeedback,
    '/dashboard/documents': getDocuments,
    '/dashboard/documents/download': getDocumentDownloadUrl,
  },
  POST: {
    '/dashboard/documents/upload': getUploadUrl,
  },
  DELETE: {
    '/dashboard/documents': deleteDocument,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Dashboard API:', event.httpMethod, event.path);

  if (event.httpMethod === 'OPTIONS') {
    return respond(204, '');
  }

  const authError = validateAdmin(event);
  if (authError) return authError;

  const methodRoutes = routes[event.httpMethod];
  if (!methodRoutes) {
    return respond(405, { message: `Method not allowed: ${event.httpMethod}` });
  }

  const routeHandler = methodRoutes[event.path];
  if (!routeHandler) {
    return respond(404, { message: `Route not found: ${event.httpMethod} ${event.path}` });
  }

  try {
    return await routeHandler(event);
  } catch (error) {
    console.error('Dashboard API error:', error);
    return respond(500, { message: 'Internal server error' });
  }
};
