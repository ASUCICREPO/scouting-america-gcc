export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  "REPLACE_AFTER_CDK_DEPLOY";

export const COGNITO_CONFIG = {
  userPoolId: process.env.NEXT_PUBLIC_USER_POOL_ID || "REPLACE_AFTER_CDK_DEPLOY",
  clientId:
    process.env.NEXT_PUBLIC_CLIENT_ID || "REPLACE_AFTER_CDK_DEPLOY",
  region: "us-east-1",
};

// Cognito Identity Pool — supplies short-lived AWS credentials to the browser
// for bilingual voice (Amazon Transcribe Streaming + Amazon Polly).
// Value comes from the BackendStack `IdentityPoolId` output.
export const IDENTITY_POOL_ID =
  process.env.NEXT_PUBLIC_IDENTITY_POOL_ID || "REPLACE_AFTER_CDK_DEPLOY";

// Supported chat/voice languages. BCP-47 codes map to Amazon Transcribe
// streaming language codes and Polly voices.
export const SUPPORTED_LANGUAGES = {
  en: { transcribe: "en-US", polly: "Joanna", label: "English" },
  es: { transcribe: "es-US", polly: "Lupe", label: "Español" },
} as const;

export type SupportedLanguage = keyof typeof SUPPORTED_LANGUAGES;
