export const CONFIG = {
  // DynamoDB Tables
  CHAT_LOGS_TABLE: 'GCC-ChatLogs',
  ANALYTICS_LOGS_TABLE: 'GCC-AnalyticsLogs',

  // S3 Buckets
  DOCUMENT_STORE_BUCKET: 'gcc-document-store',
  KNOWLEDGE_BASE_BUCKET: 'gcc-knowledge-base-data',

  // SNS/SES
  STAFF_ALERT_TOPIC: 'gcc-staff-alerts',
  STAFF_EMAIL: 'staff@grandcanyonbsa.org',

  // Bedrock
  MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',

  // Thresholds
  CONFIDENCE_THRESHOLD: 0.7,
  SAFETY_KEYWORDS: ['abuse', 'emergency', 'injury', 'youth protection', 'danger', 'hurt'],
};
