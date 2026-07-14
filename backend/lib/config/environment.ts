// Optional per-deployment prefix so multiple environments (dev/stage/prod) can
// coexist without global name collisions — S3 buckets, DynamoDB tables, and IAM
// roles are account/globally unique. Set RESOURCE_PREFIX at synth/deploy time
// (e.g. RESOURCE_PREFIX=dev). Defaults to no prefix, preserving the existing
// resource names so the current deployment is unaffected.
const PREFIX = process.env.RESOURCE_PREFIX ? `${process.env.RESOURCE_PREFIX}-` : '';

export const CONFIG = {
  // DynamoDB Tables
  CHAT_LOGS_TABLE: `${PREFIX}GCC-ChatLogs`,
  ANALYTICS_LOGS_TABLE: `${PREFIX}GCC-AnalyticsLogs`,

  // S3 Buckets
  DOCUMENT_STORE_BUCKET: `${PREFIX}gcc-document-store`,
  KNOWLEDGE_BASE_BUCKET: `${PREFIX}gcc-knowledge-base-data`,

  // S3 Vectors (Bedrock KB storage)
  VECTOR_BUCKET: `${PREFIX}gcc-volunteer-vectors`,
  VECTOR_INDEX: 'gcc-docs-index',

  // IAM
  KB_ROLE_NAME: `${PREFIX}GCC-BedrockKB-Role`,

  // SNS/SES
  STAFF_ALERT_TOPIC: `${PREFIX}gcc-staff-alerts`,
  STAFF_EMAIL: 'staff@grandcanyonbsa.org',

  // Browser upload CORS — origins allowed to PUT documents directly to S3 via
  // presigned URLs. Set UPLOAD_ALLOWED_ORIGINS (comma-separated) at synth/deploy
  // time to lock this down in production. Defaults to '*' to match the existing
  // API Gateway CORS posture for local/dev.
  UPLOAD_ALLOWED_ORIGINS: process.env.UPLOAD_ALLOWED_ORIGINS
    ? process.env.UPLOAD_ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : ['*'],

  // Bedrock
  MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',

  // Thresholds
  CONFIDENCE_THRESHOLD: 0.7,
  SAFETY_KEYWORDS: ['abuse', 'emergency', 'injury', 'youth protection', 'danger', 'hurt'],
};
