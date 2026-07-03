import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3Client = new S3Client({ region: 'us-east-1' });

// These point to the EXISTING chatbot tables — read-only access
// Read at function call time (not module load) to support local testing
function getChatLogsTable() { return process.env.CHAT_LOGS_TABLE!; }
function getAnalyticsLogsTable() { return process.env.ANALYTICS_LOGS_TABLE!; }
const DOCUMENT_BUCKET = 'gcc-document-store';
const KB_BUCKET = 'gcc-knowledge-base-data';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function respond(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

/**
 * Paginated scan — fetches ALL items from a DynamoDB table.
 * Handles the 1MB per-scan limit by following LastEvaluatedKey.
 * This guarantees 100% accurate metrics with zero data loss.
 */
async function scanAllItems(tableName: string): Promise<Record<string, any>[]> {
  const allItems: Record<string, any>[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;

  do {
    const result = await ddbDocClient.send(new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey: lastEvaluatedKey,
    }));
    allItems.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return allItems;
}

/**
 * Query by partition key — efficient for AnalyticsLogs table.
 */
async function queryByEventType(eventType: string): Promise<Record<string, any>[]> {
  const allItems: Record<string, any>[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;

  do {
    const result = await ddbDocClient.send(new QueryCommand({
      TableName: getAnalyticsLogsTable(),
      KeyConditionExpression: 'eventType = :et',
      ExpressionAttributeValues: { ':et': eventType },
      ExclusiveStartKey: lastEvaluatedKey,
    }));
    allItems.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return allItems;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /summary
// Complete overview metrics computed from ALL records
// ─────────────────────────────────────────────────────────────────────────────

async function getSummary(): Promise<APIGatewayProxyResult> {
  const [chatItems, escalationItems, docItems] = await Promise.all([
    scanAllItems(getChatLogsTable()),
    queryByEventType('escalation'),
    queryByEventType('document_processing'),
  ]);

  const totalChats = chatItems.length;
  const uniqueSessions = new Set(chatItems.map(i => i.sessionId)).size;
  const uniqueUsers = new Set(chatItems.map(i => i.userId).filter(Boolean)).size;

  // Confidence — only valid numeric values
  const confidences = chatItems
    .map(i => i.confidence as number)
    .filter(c => typeof c === 'number' && !isNaN(c));
  const avgConfidence = confidences.length > 0
    ? confidences.reduce((s, c) => s + c, 0) / confidences.length
    : 0;

  // Escalation rate
  const totalEscalations = escalationItems.length;
  const escalationRate = totalChats > 0
    ? (totalEscalations / totalChats) * 100
    : 0;

  // Feedback (if any items have feedback field)
  const withFeedback = chatItems.filter(i => i.feedback === 'positive' || i.feedback === 'negative');
  const positiveCount = withFeedback.filter(i => i.feedback === 'positive').length;
  const negativeCount = withFeedback.filter(i => i.feedback === 'negative').length;
  const satisfactionRate = withFeedback.length > 0
    ? (positiveCount / withFeedback.length) * 100
    : 0;

  // Average session length (time between first and last message in a session)
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
  const sessionDurations = Object.values(sessionTimes)
    .filter(s => s.count > 1)
    .map(s => s.last - s.first);
  const avgSessionMs = sessionDurations.length > 0
    ? sessionDurations.reduce((s, d) => s + d, 0) / sessionDurations.length
    : 0;
  const avgSessionMinutes = Math.floor(avgSessionMs / 60000);
  const avgSessionSeconds = Math.floor((avgSessionMs % 60000) / 1000);

  return respond(200, {
    totalChats,
    totalSessions: uniqueSessions,
    totalUsers: uniqueUsers,
    avgConfidence: Math.round(avgConfidence * 10000) / 10000,
    avgSessionLength: `${avgSessionMinutes}m ${avgSessionSeconds}s`,
    avgSessionMs,
    totalEscalations,
    escalationRate: Math.round(escalationRate * 100) / 100,
    totalDocuments: docItems.length,
    satisfactionRate: Math.round(satisfactionRate * 100) / 100,
    positiveCount,
    negativeCount,
    totalFeedback: withFeedback.length,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /conversations?period=day|week|month
// Conversation volume over time
// ─────────────────────────────────────────────────────────────────────────────

async function getConversations(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const period = (event.queryStringParameters?.period as 'day' | 'week' | 'month') || 'day';
  const chatItems = await scanAllItems(getChatLogsTable());

  const counts: Record<string, number> = {};

  for (const item of chatItems) {
    const timestamp = item.timestamp as string;
    if (!timestamp) continue;
    const date = new Date(timestamp);

    let dateKey: string;
    switch (period) {
      case 'day':
        dateKey = timestamp.slice(0, 10);
        break;
      case 'week': {
        const day = date.getDay();
        const diff = date.getDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(date);
        monday.setDate(diff);
        dateKey = monday.toISOString().slice(0, 10);
        break;
      }
      case 'month':
        dateKey = timestamp.slice(0, 7);
        break;
    }
    counts[dateKey] = (counts[dateKey] || 0) + 1;
  }

  const data = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  return respond(200, { period, data, total: chatItems.length });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /faq?limit=20
// Frequently asked questions — grouped and ranked by occurrence
// ─────────────────────────────────────────────────────────────────────────────

async function getFaq(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const limit = parseInt(event.queryStringParameters?.limit || '20', 10);
  const chatItems = await scanAllItems(getChatLogsTable());

  // Normalize and group questions
  const groups: Record<string, {
    question: string;
    count: number;
    confidenceSum: number;
    escalatedCount: number;
    lastAsked: string;
  }> = {};

  for (const item of chatItems) {
    const q = (item.question as string || '').trim();
    if (!q) continue;

    const key = q.toLowerCase();
    if (!groups[key]) {
      groups[key] = { question: q, count: 0, confidenceSum: 0, escalatedCount: 0, lastAsked: '' };
    }
    groups[key].count++;
    if (typeof item.confidence === 'number') groups[key].confidenceSum += item.confidence;
    if (item.escalated) groups[key].escalatedCount++;
    if (item.timestamp > groups[key].lastAsked) groups[key].lastAsked = item.timestamp;
  }

  const faqList = Object.values(groups)
    .map(g => ({
      question: g.question,
      count: g.count,
      avgConfidence: g.count > 0 ? Math.round((g.confidenceSum / g.count) * 10000) / 10000 : 0,
      escalatedCount: g.escalatedCount,
      lastAsked: g.lastAsked,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return respond(200, { faq: faqList, totalUnique: Object.keys(groups).length });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /confidence?period=day|week|month
// Confidence score distribution and trends
// ─────────────────────────────────────────────────────────────────────────────

async function getConfidence(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const period = (event.queryStringParameters?.period as 'day' | 'week' | 'month') || 'day';
  const chatItems = await scanAllItems(getChatLogsTable());

  const validItems = chatItems.filter(
    i => typeof i.confidence === 'number' && !isNaN(i.confidence)
  );

  // Distribution buckets
  const distribution = { veryLow: 0, low: 0, medium: 0, high: 0, veryHigh: 0 };
  for (const item of validItems) {
    const c = item.confidence as number;
    if (c < 0.2) distribution.veryLow++;
    else if (c < 0.4) distribution.low++;
    else if (c < 0.6) distribution.medium++;
    else if (c < 0.8) distribution.high++;
    else distribution.veryHigh++;
  }

  // Trend over time
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
    .map(([date, d]) => ({
      date,
      avgConfidence: Math.round((d.sum / d.count) * 10000) / 10000,
      count: d.count,
    }));

  // Stats
  const all = validItems.map(i => i.confidence as number);
  const sorted = [...all].sort((a, b) => a - b);
  const avg = all.length > 0 ? all.reduce((s, c) => s + c, 0) / all.length : 0;

  return respond(200, {
    distribution,
    trend: trendData,
    stats: {
      total: all.length,
      average: Math.round(avg * 10000) / 10000,
      median: sorted.length > 0 ? Math.round(sorted[Math.floor(sorted.length / 2)] * 10000) / 10000 : 0,
      min: sorted.length > 0 ? Math.round(sorted[0] * 10000) / 10000 : 0,
      max: sorted.length > 0 ? Math.round(sorted[sorted.length - 1] * 10000) / 10000 : 0,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /escalations
// All escalation events with details
// ─────────────────────────────────────────────────────────────────────────────

async function getEscalations(): Promise<APIGatewayProxyResult> {
  const items = await queryByEventType('escalation');

  // Group by reason
  const grouped: Record<string, { count: number; lastOccurred: string; avgConfidence: number; confSum: number }> = {};
  for (const item of items) {
    const reason = (item.reason as string) || (item.metadata?.reason as string) || 'unknown';
    const ts = item.timestamp as string;
    const conf = (item.metadata?.confidence as number) || 0;

    if (!grouped[reason]) grouped[reason] = { count: 0, lastOccurred: '', avgConfidence: 0, confSum: 0 };
    grouped[reason].count++;
    grouped[reason].confSum += conf;
    if (ts > grouped[reason].lastOccurred) grouped[reason].lastOccurred = ts;
  }

  const escalations = Object.entries(grouped)
    .map(([reason, d]) => ({
      reason,
      count: d.count,
      lastOccurred: d.lastOccurred,
      avgConfidence: d.count > 0 ? Math.round((d.confSum / d.count) * 10000) / 10000 : 0,
    }))
    .sort((a, b) => b.count - a.count);

  return respond(200, { escalations, total: items.length });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /negative-feedback?limit=50&offset=0
// Conversations that received negative feedback — for admin review
// ─────────────────────────────────────────────────────────────────────────────

async function getNegativeFeedback(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const limit = parseInt(event.queryStringParameters?.limit || '50', 10);
  const offset = parseInt(event.queryStringParameters?.offset || '0', 10);

  const chatItems = await scanAllItems(getChatLogsTable());

  const negativeItems = chatItems
    .filter(i => i.feedback === 'negative')
    .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  const total = negativeItems.length;
  const paginated = negativeItems.slice(offset, offset + limit);

  const conversations = paginated.map(item => ({
    sessionId: item.sessionId,
    timestamp: item.timestamp,
    userId: item.userId,
    question: item.question,
    answer: item.answer,
    confidence: typeof item.confidence === 'number' ? Math.round(item.confidence * 10000) / 10000 : 0,
    sources: item.sources || [],
    escalated: item.escalated || false,
  }));

  return respond(200, { total, offset, limit, conversations });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /documents
// Document processing history — fetches actual files from S3
// ─────────────────────────────────────────────────────────────────────────────

async function getDocuments(): Promise<APIGatewayProxyResult> {
  // List actual files in the document store S3 bucket
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /documents/download?key=uploads/filename.pdf
// Generate a pre-signed download URL for a document
// ─────────────────────────────────────────────────────────────────────────────

async function getDocumentDownloadUrl(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const key = event.queryStringParameters?.key;
  if (!key) return respond(400, { message: 'key parameter is required' });

  const url = await getSignedUrl(s3Client, new GetObjectCommand({
    Bucket: DOCUMENT_BUCKET,
    Key: key,
  }), { expiresIn: 300 }); // 5 min expiry

  return respond(200, { url, key });
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /documents?key=uploads/filename.pdf
// Delete a document from S3
// ─────────────────────────────────────────────────────────────────────────────

async function deleteDocument(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const key = event.queryStringParameters?.key;
  if (!key) return respond(400, { message: 'key parameter is required' });

  await s3Client.send(new DeleteObjectCommand({
    Bucket: DOCUMENT_BUCKET,
    Key: key,
  }));

  // Also try to delete from KB bucket
  const kbKey = `documents/${key.replace('uploads/', '')}`;
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: KB_BUCKET, Key: kbKey }));
  } catch { /* ignore if not in KB bucket */ }

  return respond(200, { status: 'deleted', key });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /documents/upload
// Generate a pre-signed upload URL for a new document
// ─────────────────────────────────────────────────────────────────────────────

async function getUploadUrl(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  const { fileName, contentType } = body;
  if (!fileName) return respond(400, { message: 'fileName is required' });

  const key = `uploads/${fileName}`;
  const url = await getSignedUrl(s3Client, new PutObjectCommand({
    Bucket: DOCUMENT_BUCKET,
    Key: key,
    ContentType: contentType || 'application/pdf',
  }), { expiresIn: 300 });

  return respond(200, { url, key });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /faq/all?limit=30&offset=0
// Full paginated FAQ list for "View All" popup
// ─────────────────────────────────────────────────────────────────────────────

async function getFaqAll(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const limit = parseInt(event.queryStringParameters?.limit || '30', 10);
  const offset = parseInt(event.queryStringParameters?.offset || '0', 10);
  const chatItems = await scanAllItems(getChatLogsTable());

  const groups: Record<string, {
    question: string; count: number; confidenceSum: number; escalatedCount: number; lastAsked: string;
  }> = {};

  for (const item of chatItems) {
    const q = (item.question as string || '').trim();
    if (!q) continue;
    const key = q.toLowerCase();
    if (!groups[key]) {
      groups[key] = { question: q, count: 0, confidenceSum: 0, escalatedCount: 0, lastAsked: '' };
    }
    groups[key].count++;
    if (typeof item.confidence === 'number') groups[key].confidenceSum += item.confidence;
    if (item.escalated) groups[key].escalatedCount++;
    if (item.timestamp > groups[key].lastAsked) groups[key].lastAsked = item.timestamp;
  }

  const allFaq = Object.values(groups)
    .map(g => ({
      question: g.question,
      count: g.count,
      avgConfidence: g.count > 0 ? Math.round((g.confidenceSum / g.count) * 10000) / 10000 : 0,
      escalatedCount: g.escalatedCount,
      lastAsked: g.lastAsked,
    }))
    .sort((a, b) => b.count - a.count);

  const total = allFaq.length;
  const paginated = allFaq.slice(offset, offset + limit);

  return respond(200, { faq: paginated, total, offset, limit });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Handler
// ─────────────────────────────────────────────────────────────────────────────

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Dashboard API:', event.httpMethod, event.path);

  if (event.httpMethod === 'OPTIONS') {
    return respond(200, {});
  }

  // TODO: Add Cognito auth validation here when ready
  // For now, open access during development

  const path = event.path;

  try {
    if (path.endsWith('/summary')) return await getSummary();
    if (path.endsWith('/conversations')) return await getConversations(event);
    if (path.endsWith('/faq/all')) return await getFaqAll(event);
    if (path.endsWith('/faq')) return await getFaq(event);
    if (path.endsWith('/confidence')) return await getConfidence(event);
    if (path.endsWith('/escalations')) return await getEscalations();
    if (path.endsWith('/negative-feedback')) return await getNegativeFeedback(event);
    if (path.endsWith('/documents/download')) return await getDocumentDownloadUrl(event);
    if (path.endsWith('/documents/upload') && event.httpMethod === 'POST') return await getUploadUrl(event);
    if (path.endsWith('/documents') && event.httpMethod === 'DELETE') return await deleteDocument(event);
    if (path.endsWith('/documents')) return await getDocuments();

    return respond(404, { message: `Route not found: ${path}` });
  } catch (error) {
    console.error('Dashboard API error:', error);
    return respond(500, { message: error instanceof Error ? error.message : 'Internal error' });
  }
};
