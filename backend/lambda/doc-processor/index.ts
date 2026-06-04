import { S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { TextractClient, DetectDocumentTextCommand } from '@aws-sdk/client-textract';
import { BedrockAgentClient, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const s3 = new S3Client({});
const textract = new TextractClient({});
const bedrockAgent = new BedrockAgentClient({});
const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const DOCUMENT_STORE_BUCKET = process.env.DOCUMENT_STORE_BUCKET!;
const KNOWLEDGE_BASE_BUCKET = process.env.KNOWLEDGE_BASE_BUCKET!;
const ANALYTICS_TABLE = process.env.ANALYTICS_TABLE!;
const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID!;
const DATA_SOURCE_ID = process.env.DATA_SOURCE_ID!;

// Chunking constants: ~300 tokens per chunk, ~4 chars per token
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 240;

/**
 * Extract text from a PDF using Amazon Textract DetectDocumentText API.
 */
async function extractTextFromPdf(bucket: string, key: string): Promise<string> {
  const response = await textract.send(
    new DetectDocumentTextCommand({
      Document: {
        S3Object: {
          Bucket: bucket,
          Name: key,
        },
      },
    }),
  );

  const lines = response.Blocks?.filter((block) => block.BlockType === 'LINE')
    .map((block) => block.Text || '')
    .join('\n') || '';

  return lines;
}

/**
 * Read plain text content directly from S3 object body.
 */
async function readTextFromS3(bucket: string, key: string): Promise<string> {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  return (await response.Body?.transformToString()) || '';
}

/**
 * Split text into chunks of ~300 tokens with 20% overlap.
 */
function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }

  return chunks;
}

/**
 * Write chunks to the knowledge-base-data bucket.
 */
async function writeChunks(docId: string, chunks: string[]): Promise<void> {
  const writePromises = chunks.map((chunk, index) => {
    const chunkKey = `chunks/${docId}-chunk-${String(index).padStart(3, '0')}.txt`;
    return s3.send(
      new PutObjectCommand({
        Bucket: KNOWLEDGE_BASE_BUCKET,
        Key: chunkKey,
        Body: chunk,
        ContentType: 'text/plain',
      }),
    );
  });

  await Promise.all(writePromises);
}

/**
 * Trigger Bedrock Knowledge Base ingestion job to re-sync data.
 */
async function startIngestionJob(): Promise<void> {
  await bedrockAgent.send(
    new StartIngestionJobCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      dataSourceId: DATA_SOURCE_ID,
    }),
  );
}

/**
 * Log document processing event to the AnalyticsLogs DynamoDB table.
 */
async function logAnalyticsEvent(
  fileName: string,
  fileSize: number,
  chunkCount: number,
  processingTimeMs: number,
): Promise<void> {
  await ddbDocClient.send(
    new PutCommand({
      TableName: ANALYTICS_TABLE,
      Item: {
        eventType: 'document_processing',
        timestamp: new Date().toISOString(),
        metadata: {
          fileName,
          fileSize,
          chunkCount,
          processingTimeMs,
          processedAt: new Date().toISOString(),
        },
      },
    }),
  );
}

/**
 * Lambda handler triggered by S3 ObjectCreated event on document-store bucket.
 */
export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    const startTime = Date.now();
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    const fileSize = record.s3.object.size;

    console.log(`Processing file: s3://${bucket}/${key} (${fileSize} bytes)`);

    // Derive a document ID from the key (strip path and extension)
    const docId = key
      .split('/')
      .pop()!
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_');

    let text: string;

    // Determine extraction method based on file extension
    if (key.toLowerCase().endsWith('.pdf')) {
      console.log('Extracting text from PDF via Textract');
      text = await extractTextFromPdf(bucket, key);
    } else {
      // Plain text files: .txt, .md, .doc
      console.log('Reading plain text content from S3');
      text = await readTextFromS3(bucket, key);
    }

    if (!text || text.trim().length === 0) {
      console.warn(`No text extracted from ${key}, skipping.`);
      continue;
    }

    // Chunk the extracted text
    const chunks = chunkText(text);
    console.log(`Generated ${chunks.length} chunks from ${key}`);

    // Write chunks to knowledge base bucket
    await writeChunks(docId, chunks);
    console.log(`Wrote ${chunks.length} chunks to ${KNOWLEDGE_BASE_BUCKET}`);

    // Trigger knowledge base re-sync
    await startIngestionJob();
    console.log('Started Bedrock Knowledge Base ingestion job');

    // Log analytics event
    const processingTimeMs = Date.now() - startTime;
    await logAnalyticsEvent(key, fileSize, chunks.length, processingTimeMs);
    console.log(`Logged analytics event (processing took ${processingTimeMs}ms)`);
  }
};
