/**
 * Local server that wraps the Lambda handler for local testing.
 * Serves the dashboard API on port 3002 using live DynamoDB data.
 * 
 * IMPORTANT: env vars must be set BEFORE importing the handler.
 */
import * as http from 'http';

// Set env vars BEFORE importing handler (Lambda reads them at module load)
process.env.CHAT_LOGS_TABLE = 'GCC-ChatLogs';
process.env.ANALYTICS_LOGS_TABLE = 'GCC-AnalyticsLogs';
process.env.AWS_REGION = 'us-east-1';

// Dynamic import after env is set
async function start() {
  const { handler } = await import('./lambda/index');
  const PORT = 3002;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      res.end();
      return;
    }

    // Parse query params
    const queryParams: Record<string, string> = {};
    url.searchParams.forEach((val, key) => { queryParams[key] = val; });

    // Build Lambda event
    const event = {
      httpMethod: req.method || 'GET',
      path: url.pathname,
      queryStringParameters: Object.keys(queryParams).length > 0 ? queryParams : null,
      headers: req.headers as Record<string, string>,
      requestContext: { authorizer: { claims: { 'cognito:groups': 'admin' } } },
      body: null,
    } as any;

    // Read request body for POST/PUT
    if (req.method === 'POST' || req.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) { chunks.push(chunk as Buffer); }
      event.body = Buffer.concat(chunks).toString();
    }

    try {
      const result = await handler(event);
      res.writeHead(result.statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      res.end(result.body);
    } catch (err) {
      console.error('Server error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  server.listen(PORT, () => {
    console.log(`\n🚀 Admin Dashboard API running at http://localhost:${PORT}`);
    console.log(`   Reading live data from DynamoDB tables in us-east-1\n`);
    console.log('   Endpoints:');
    console.log('   GET /dashboard/summary');
    console.log('   GET /dashboard/conversations?period=day');
    console.log('   GET /dashboard/faq?limit=20');
    console.log('   GET /dashboard/confidence?period=day');
    console.log('   GET /dashboard/escalations');
    console.log('   GET /dashboard/documents');
    console.log('   GET /dashboard/negative-feedback?limit=50');
    console.log('');
  });
}

start().catch(console.error);
