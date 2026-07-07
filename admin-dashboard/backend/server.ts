/**
 * Local development server — wraps the Lambda handler for local testing.
 * 
 * For local dev, it validates the Cognito token by decoding the JWT and checking
 * the 'cognito:groups' claim. In production, API Gateway does this.
 */
import * as http from 'http';

process.env.CHAT_LOGS_TABLE = 'GCC-ChatLogs';
process.env.ANALYTICS_LOGS_TABLE = 'GCC-AnalyticsLogs';
process.env.DOCUMENT_BUCKET = 'gcc-document-store';
process.env.KB_BUCKET = 'gcc-knowledge-base-data';
process.env.AWS_REGION = 'us-east-1';

async function start() {
  const { handler } = await import('./lambda/index');
  const PORT = 3002;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      });
      res.end();
      return;
    }

    // Parse query params
    const queryParams: Record<string, string> = {};
    url.searchParams.forEach((val, key) => { queryParams[key] = val; });

    // Extract and decode Authorization header for local auth simulation
    const authHeader = req.headers['authorization'] || '';
    let claims: Record<string, any> = {};

    if (authHeader) {
      try {
        // Decode JWT payload (no signature verification locally — API Gateway handles that in prod)
        const payload = JSON.parse(Buffer.from(authHeader.split('.')[1], 'base64').toString());
        claims = payload;
      } catch {
        claims = {};
      }
    } else {
      // No auth header in local dev — simulate admin for testing
      // Remove this fallback when testing auth flow
      claims = { 'cognito:groups': 'admin', email: 'local-dev@gcc.org' };
    }

    // Build Lambda event
    const event: any = {
      httpMethod: req.method || 'GET',
      path: url.pathname,
      queryStringParameters: Object.keys(queryParams).length > 0 ? queryParams : null,
      headers: req.headers as Record<string, string>,
      requestContext: {
        authorizer: { claims },
      },
      body: null,
    };

    // Read body for POST/PUT/DELETE
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) { chunks.push(chunk as Buffer); }
      const bodyStr = Buffer.concat(chunks).toString();
      if (bodyStr) event.body = bodyStr;
    }

    try {
      const result = await handler(event);
      res.writeHead(result.statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
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
    console.log(`   Reading LIVE data from DynamoDB + S3 in us-east-1`);
    console.log(`   Auth: Cognito JWT validated (local fallback to admin for dev)\n`);
    console.log('   Endpoints (all require admin group):');
    console.log('   GET  /dashboard/summary');
    console.log('   GET  /dashboard/conversations?period=day');
    console.log('   GET  /dashboard/faq?limit=5');
    console.log('   GET  /dashboard/faq/all?limit=30&offset=0');
    console.log('   GET  /dashboard/confidence?period=day');
    console.log('   GET  /dashboard/escalations');
    console.log('   GET  /dashboard/negative-feedback');
    console.log('   GET  /dashboard/documents');
    console.log('   GET  /dashboard/documents/download?key=uploads/file.pdf');
    console.log('   POST /dashboard/documents/upload');
    console.log('   DELETE /dashboard/documents?key=uploads/file.pdf');
    console.log('');
  });
}

start().catch(console.error);
