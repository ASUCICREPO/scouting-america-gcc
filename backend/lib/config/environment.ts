// Optional per-deployment prefix so multiple environments (dev/stage/prod) can
// coexist without global name collisions — S3 buckets, DynamoDB tables, and IAM
// roles are account/globally unique. Set RESOURCE_PREFIX at synth/deploy time
// (e.g. RESOURCE_PREFIX=dev). Defaults to no prefix, preserving the existing
// resource names so the current deployment is unaffected.
// Exported so constructs can prefix account/region-unique names that aren't in
// CONFIG (Lambda function names, SQS queues, Bedrock resources, the KB) —
// otherwise a prefixed deploy collides with an existing unprefixed stack.
export const PREFIX = process.env.RESOURCE_PREFIX ? `${process.env.RESOURCE_PREFIX}-` : '';

export const CONFIG = {
  // DynamoDB Tables
  CHAT_LOGS_TABLE: `${PREFIX}GCC-ChatLogs`,
  ANALYTICS_LOGS_TABLE: `${PREFIX}GCC-AnalyticsLogs`,
  DOCUMENT_BATCHES_TABLE: `${PREFIX}GCC-DocumentBatches`,

  // S3 bucket base names. SharedResources appends the deploying account ID
  // because the general-purpose S3 namespace is global across AWS accounts.
  DOCUMENT_STORE_BUCKET: `${PREFIX}gcc-document-store`,
  KNOWLEDGE_BASE_BUCKET: `${PREFIX}gcc-knowledge-base-data`,
  CHAT_ARCHIVE_BUCKET: `${PREFIX}gcc-chat-audit-archive`,

  // S3 Vectors (Bedrock KB storage)
  VECTOR_BUCKET: `${PREFIX}gcc-volunteer-vectors`,
  VECTOR_INDEX: 'gcc-docs-index',

  // IAM
  KB_ROLE_NAME: `${PREFIX}GCC-BedrockKB-Role`,

  // SNS/SES
  STAFF_ALERT_TOPIC: `${PREFIX}gcc-staff-alerts`,
  STAFF_EMAIL: 'staff@grandcanyonbsa.org',

  // Bedrock
  MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',

  // Thresholds
  CONFIDENCE_THRESHOLD: 0.7,
  // Public chat protection. AWS WAF counts answer-generation requests per
  // originating IP over this five-minute window; API Gateway also applies a
  // lower shared-stage throttle as a second availability boundary.
  PUBLIC_CHAT_RATE_LIMIT_PER_FIVE_MINUTES: 100,
  PUBLIC_API_RATE_LIMIT_PER_FIVE_MINUTES: 600,
  PUBLIC_API_THROTTLING_RATE_LIMIT: 10,
  PUBLIC_API_THROTTLING_BURST_LIMIT: 20,
  PUBLIC_CHAT_RESERVED_CONCURRENCY: 10,
  PUBLIC_CHAT_MAX_SESSION_TURNS: 50,
  SAFETY_KEYWORDS: [
    'abuse',
    'emergency',
    'injury',
    'youth protection',
    'danger',
    'hurt',
    'abuso',
    'emergencia',
    'lesión',
    'herida',
    'protección juvenil',
    'peligro',
    'lastimado',
    'ayuda inmediata',
  ],
};
