import { S3Event } from 'aws-lambda';
import { S3Client, CopyObjectCommand } from '@aws-sdk/client-s3';
import { BedrockAgentClient, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const s3 = new S3Client({});
const bedrockAgent = new BedrockAgentClient({});
const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const KNOWLEDGE_BASE_BUCKET = process.env.KNOWLEDGE_BASE_BUCKET!;
const ANALYTICS_TABLE = process.env.ANALYTICS_TABLE!;
const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID!;
const DATA_SOURCE_ID = process.env.DATA_SOURCE_ID!;

/**
 * Lambda handler triggered by S3 ObjectCreated event on document-store bucket.
 *
 * Simplified flow: Copy uploaded file to KB data bucket, trigger Bedrock ingestion.
 * Bedrock KB handles PDF parsing, chunking, and embedding natively — no Textract needed.
 */
export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    const startTime = Date.now();
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    const fileSize = record.s3.object.size;

    console.log(`Processing file: s3://${bucket}/${key} (${fileSize} bytes)`);

    // Derive filename from key (strip the uploads/ prefix)
    const fileName = key.replace(/^uploads\//, '');

    // Copy the file from document-store to knowledge-base-data bucket
    // Bedrock KB data source points to this bucket and handles parsing natively
    await s3.send(new CopyObjectCommand({
      CopySource: `${bucket}/${key}`,
      Bucket: KNOWLEDGE_BASE_BUCKET,
      Key: `documents/${fileName}`,
    }));
    console.log(`Copied to s3://${KNOWLEDGE_BASE_BUCKET}/documents/${fileName}`);

    // Trigger Bedrock KB ingestion — Bedrock handles PDF parsing, chunking, embedding
    await bedrockAgent.send(new StartIngestionJobCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      dataSourceId: DATA_SOURCE_ID,
    }));
    console.log('Started Bedrock Knowledge Base ingestion job');

    // Log analytics event
    const processingTimeMs = Date.now() - startTime;
    await ddbDocClient.send(new PutCommand({
      TableName: ANALYTICS_TABLE,
      Item: {
        eventType: 'document_processing',
        timestamp: new Date().toISOString(),
        metadata: {
          fileName,
          fileSize,
          processingTimeMs,
          processedAt: new Date().toISOString(),
        },
      },
    }));
    console.log(`Done (${processingTimeMs}ms)`);
  }
};
