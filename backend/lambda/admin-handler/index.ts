import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { randomUUID } from 'crypto';

const s3 = new S3Client({});
const secretsManager = new SecretsManagerClient({});

const DOCUMENT_STORE_BUCKET = process.env.DOCUMENT_STORE_BUCKET!;
const KNOWLEDGE_BASE_BUCKET = process.env.KNOWLEDGE_BASE_BUCKET!;
const GUARDRAILS_SECRET_ARN = process.env.GUARDRAILS_SECRET_ARN!;

/**
 * Returns a properly formatted API Gateway response with CORS headers.
 */
function respond(statusCode: number, body: Record<string, unknown> | Array<unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

/**
 * Validates that the caller belongs to the 'admin' Cognito group.
 * Returns a 403 response if not authorized, or null if authorized.
 */
function validateAdmin(event: APIGatewayProxyEvent): APIGatewayProxyResult | null {
  const claims = event.requestContext.authorizer?.claims;
  if (!claims) {
    return respond(403, { message: 'Unauthorized: No claims found' });
  }

  const groups: string = claims['cognito:groups'] || '';
  const groupList = groups.split(',').map((g: string) => g.trim());

  if (!groupList.includes('admin')) {
    return respond(403, { message: 'Forbidden: Admin access required' });
  }

  return null;
}

/**
 * POST /admin/documents — Upload a new document
 */
async function handleUploadDocument(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  const { fileName, fileContent, contentType } = body;

  if (!fileName || !fileContent || !contentType) {
    return respond(400, { message: 'Missing required fields: fileName, fileContent, contentType' });
  }

  const docId = randomUUID();
  const ext = fileName.includes('.') ? fileName.split('.').pop()! : 'bin';
  const s3Key = `uploads/${docId}.${ext}`;

  // Decode base64 file content and upload to S3
  const fileBuffer = Buffer.from(fileContent, 'base64');

  await s3.send(new PutObjectCommand({
    Bucket: DOCUMENT_STORE_BUCKET,
    Key: s3Key,
    Body: fileBuffer,
    ContentType: contentType,
  }));

  // Store metadata
  const metadata = {
    docId,
    name: fileName,
    uploadDate: new Date().toISOString(),
    status: 'processing',
    size: fileBuffer.length,
    contentType,
  };

  await s3.send(new PutObjectCommand({
    Bucket: DOCUMENT_STORE_BUCKET,
    Key: `metadata/${docId}.json`,
    Body: JSON.stringify(metadata),
    ContentType: 'application/json',
  }));

  return respond(200, { docId, status: 'processing' });
}

/**
 * GET /admin/documents — List all documents
 */
async function handleListDocuments(): Promise<APIGatewayProxyResult> {
  const listResponse = await s3.send(new ListObjectsV2Command({
    Bucket: DOCUMENT_STORE_BUCKET,
    Prefix: 'metadata/',
  }));

  const documents: Array<Record<string, unknown>> = [];

  if (listResponse.Contents) {
    for (const obj of listResponse.Contents) {
      if (!obj.Key || !obj.Key.endsWith('.json')) continue;

      const getResponse = await s3.send(new GetObjectCommand({
        Bucket: DOCUMENT_STORE_BUCKET,
        Key: obj.Key,
      }));

      const bodyStr = await getResponse.Body?.transformToString();
      if (bodyStr) {
        const meta = JSON.parse(bodyStr);
        documents.push({
          docId: meta.docId,
          name: meta.name,
          uploadDate: meta.uploadDate,
          status: meta.status,
          size: meta.size,
        });
      }
    }
  }

  return respond(200, documents);
}

/**
 * DELETE /admin/documents/{id} — Remove a document
 */
async function handleDeleteDocument(docId: string): Promise<APIGatewayProxyResult> {
  // Get current metadata
  const metaResponse = await s3.send(new GetObjectCommand({
    Bucket: DOCUMENT_STORE_BUCKET,
    Key: `metadata/${docId}.json`,
  }));

  const metaStr = await metaResponse.Body?.transformToString();
  if (!metaStr) {
    return respond(404, { message: 'Document not found' });
  }

  const metadata = JSON.parse(metaStr);
  metadata.status = 'deleted';

  // Update metadata with deleted status
  await s3.send(new PutObjectCommand({
    Bucket: DOCUMENT_STORE_BUCKET,
    Key: `metadata/${docId}.json`,
    Body: JSON.stringify(metadata),
    ContentType: 'application/json',
  }));

  // Delete chunks from knowledge-base-data bucket
  const chunksResponse = await s3.send(new ListObjectsV2Command({
    Bucket: KNOWLEDGE_BASE_BUCKET,
    Prefix: `chunks/${docId}-`,
  }));

  if (chunksResponse.Contents && chunksResponse.Contents.length > 0) {
    await s3.send(new DeleteObjectsCommand({
      Bucket: KNOWLEDGE_BASE_BUCKET,
      Delete: {
        Objects: chunksResponse.Contents.map((obj) => ({ Key: obj.Key })),
      },
    }));
  }

  return respond(200, { status: 'deleted' });
}

/**
 * PUT /admin/documents/{id} — Replace a document
 */
async function handleReplaceDocument(docId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  const { fileName, fileContent, contentType } = body;

  if (!fileName || !fileContent || !contentType) {
    return respond(400, { message: 'Missing required fields: fileName, fileContent, contentType' });
  }

  // Delete old chunks from knowledge-base-data bucket
  const chunksResponse = await s3.send(new ListObjectsV2Command({
    Bucket: KNOWLEDGE_BASE_BUCKET,
    Prefix: `chunks/${docId}-`,
  }));

  if (chunksResponse.Contents && chunksResponse.Contents.length > 0) {
    await s3.send(new DeleteObjectsCommand({
      Bucket: KNOWLEDGE_BASE_BUCKET,
      Delete: {
        Objects: chunksResponse.Contents.map((obj) => ({ Key: obj.Key })),
      },
    }));
  }

  // Upload new file
  const newExt = fileName.includes('.') ? fileName.split('.').pop()! : 'bin';
  const s3Key = `uploads/${docId}.${newExt}`;
  const fileBuffer = Buffer.from(fileContent, 'base64');

  await s3.send(new PutObjectCommand({
    Bucket: DOCUMENT_STORE_BUCKET,
    Key: s3Key,
    Body: fileBuffer,
    ContentType: contentType,
  }));

  // Update metadata
  const metadata = {
    docId,
    name: fileName,
    uploadDate: new Date().toISOString(),
    status: 'replacing',
    size: fileBuffer.length,
    contentType,
  };

  await s3.send(new PutObjectCommand({
    Bucket: DOCUMENT_STORE_BUCKET,
    Key: `metadata/${docId}.json`,
    Body: JSON.stringify(metadata),
    ContentType: 'application/json',
  }));

  return respond(200, { docId, status: 'replacing' });
}

/**
 * PUT /admin/guardrails — Update system instructions
 */
async function handleUpdateGuardrails(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  const { systemPrompt } = body;

  if (!systemPrompt) {
    return respond(400, { message: 'Missing required field: systemPrompt' });
  }

  const secretValue = JSON.stringify({
    systemPrompt,
    lastUpdated: new Date().toISOString(),
  });

  await secretsManager.send(new PutSecretValueCommand({
    SecretId: GUARDRAILS_SECRET_ARN,
    SecretString: secretValue,
  }));

  return respond(200, { status: 'updated' });
}

/**
 * GET /admin/guardrails — Get current system instructions
 */
async function handleGetGuardrails(): Promise<APIGatewayProxyResult> {
  const response = await secretsManager.send(new GetSecretValueCommand({
    SecretId: GUARDRAILS_SECRET_ARN,
  }));

  const parsed = JSON.parse(response.SecretString || '{}');

  return respond(200, { guardrails: parsed, lastUpdated: parsed.lastUpdated });
}

/**
 * Main Lambda handler — routes based on HTTP method and path.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return respond(200, {});
  }

  // Validate admin access
  const authError = validateAdmin(event);
  if (authError) {
    return authError;
  }

  const method = event.httpMethod;
  const path = event.resource || event.path;
  const docId = event.pathParameters?.id;

  try {
    // POST /admin/documents
    if (method === 'POST' && path === '/admin/documents') {
      return await handleUploadDocument(event);
    }

    // GET /admin/documents
    if (method === 'GET' && path === '/admin/documents') {
      return await handleListDocuments();
    }

    // DELETE /admin/documents/{id}
    if (method === 'DELETE' && path === '/admin/documents/{id}') {
      if (!docId) {
        return respond(400, { message: 'Missing document ID' });
      }
      return await handleDeleteDocument(docId);
    }

    // PUT /admin/documents/{id}
    if (method === 'PUT' && path === '/admin/documents/{id}') {
      if (!docId) {
        return respond(400, { message: 'Missing document ID' });
      }
      return await handleReplaceDocument(docId, event);
    }

    // PUT /admin/guardrails
    if (method === 'PUT' && path === '/admin/guardrails') {
      return await handleUpdateGuardrails(event);
    }

    // GET /admin/guardrails
    if (method === 'GET' && path === '/admin/guardrails') {
      return await handleGetGuardrails();
    }

    return respond(404, { message: `Route not found: ${method} ${path}` });
  } catch (error) {
    console.error('Admin handler error:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return respond(500, { message });
  }
};
