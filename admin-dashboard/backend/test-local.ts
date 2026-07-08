/**
 * Local test script — runs the Lambda handler locally against live DynamoDB.
 * Uses your local AWS credentials to read from the deployed tables.
 */

// Set env vars that the Lambda expects
process.env.CHAT_LOGS_TABLE = 'GCC-ChatLogs';
process.env.ANALYTICS_LOGS_TABLE = 'GCC-AnalyticsLogs';
process.env.AWS_REGION = 'us-east-1';

import { handler } from './lambda/index';

async function test(path: string, queryParams?: Record<string, string>) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Testing: GET ${path}`);
  console.log('═'.repeat(60));

  const event = {
    httpMethod: 'GET',
    path,
    queryStringParameters: queryParams || null,
    requestContext: { authorizer: { claims: { 'cognito:groups': 'admin' } } },
  } as any;

  const result = await handler(event);
  const body = JSON.parse(result.body);
  console.log(`Status: ${result.statusCode}`);
  console.log('Response:', JSON.stringify(body, null, 2).slice(0, 1500));
  return body;
}

async function runTests() {
  console.log('🔍 Testing Admin Dashboard Backend against LIVE DynamoDB data...\n');

  await test('/dashboard/summary');
  await test('/dashboard/conversations', { period: 'day' });
  await test('/dashboard/faq', { limit: '5' });
  await test('/dashboard/confidence', { period: 'day' });
  await test('/dashboard/escalations');
  await test('/dashboard/documents');
  await test('/dashboard/negative-feedback', { limit: '5' });

  console.log('\n✅ All tests complete!\n');
}

runTests().catch(console.error);
