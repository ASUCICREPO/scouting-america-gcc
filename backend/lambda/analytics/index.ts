import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CHAT_LOGS_TABLE = process.env.CHAT_LOGS_TABLE!;
const ANALYTICS_LOGS_TABLE = process.env.ANALYTICS_LOGS_TABLE!;

/**
 * Validate that the caller belongs to the 'admin' Cognito group.
 */
function validateAdmin(event: APIGatewayProxyEvent): boolean {
  const claims = event.requestContext.authorizer?.claims;
  if (!claims) return false;

  const groups: string = claims['cognito:groups'] || '';
  return groups.split(',').includes('admin');
}

/**
 * Build a standard API Gateway proxy response with CORS headers.
 */
function respond(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

/**
 * GET /admin/analytics/usage
 * Aggregate chat log counts by date for the given period.
 */
async function getUsage(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const period = (event.queryStringParameters?.period as 'day' | 'week' | 'month') || 'week';

  const result = await ddbDocClient.send(
    new ScanCommand({ TableName: CHAT_LOGS_TABLE }),
  );

  const items = result.Items || [];
  const counts: Record<string, number> = {};

  for (const item of items) {
    const timestamp = item.timestamp as string;
    if (!timestamp) continue;

    let dateKey: string;
    const date = new Date(timestamp);

    switch (period) {
      case 'day':
        dateKey = timestamp.slice(0, 10); // YYYY-MM-DD
        break;
      case 'week': {
        // ISO week: use Monday of the week
        const day = date.getDay();
        const diff = date.getDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(date);
        monday.setDate(diff);
        dateKey = monday.toISOString().slice(0, 10);
        break;
      }
      case 'month':
        dateKey = timestamp.slice(0, 7); // YYYY-MM
        break;
      default:
        dateKey = timestamp.slice(0, 10);
    }

    counts[dateKey] = (counts[dateKey] || 0) + 1;
  }

  const data = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  return respond(200, { period, data });
}

/**
 * GET /admin/analytics/categories
 * Group chat logs by category and calculate percentages.
 */
async function getCategories(): Promise<APIGatewayProxyResult> {
  const result = await ddbDocClient.send(
    new ScanCommand({ TableName: CHAT_LOGS_TABLE }),
  );

  const items = result.Items || [];
  const counts: Record<string, number> = {};
  let total = 0;

  for (const item of items) {
    const category = (item.category as string) || 'uncategorized';
    counts[category] = (counts[category] || 0) + 1;
    total++;
  }

  const categories = Object.entries(counts).map(([name, count]) => ({
    name,
    count,
    percentage: total > 0 ? Math.round((count / total) * 10000) / 100 : 0,
  }));

  return respond(200, { categories });
}

/**
 * GET /admin/analytics/escalations
 * Query escalation events, group by reason.
 */
async function getEscalations(): Promise<APIGatewayProxyResult> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: ANALYTICS_LOGS_TABLE,
      KeyConditionExpression: 'eventType = :et',
      ExpressionAttributeValues: {
        ':et': 'escalation',
      },
    }),
  );

  const items = result.Items || [];
  const grouped: Record<string, { count: number; lastOccurred: string }> = {};

  for (const item of items) {
    const reason = (item.metadata?.reason as string) || 'unknown';
    const timestamp = item.timestamp as string;

    if (!grouped[reason]) {
      grouped[reason] = { count: 0, lastOccurred: timestamp };
    }

    grouped[reason].count++;
    if (timestamp > grouped[reason].lastOccurred) {
      grouped[reason].lastOccurred = timestamp;
    }
  }

  const escalations = Object.entries(grouped).map(([reason, data]) => ({
    reason,
    count: data.count,
    lastOccurred: data.lastOccurred,
  }));

  return respond(200, { escalations });
}

/**
 * Lambda handler — routes based on HTTP method + path.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Analytics Lambda invoked:', event.httpMethod, event.path);

  // Admin validation
  if (!validateAdmin(event)) {
    return respond(403, { message: 'Forbidden: admin access required' });
  }

  const path = event.path;
  const method = event.httpMethod;

  if (method === 'GET') {
    if (path.endsWith('/usage')) {
      return getUsage(event);
    }
    if (path.endsWith('/categories')) {
      return getCategories();
    }
    if (path.endsWith('/escalations')) {
      return getEscalations();
    }
  }

  return respond(404, { message: 'Not found' });
};
