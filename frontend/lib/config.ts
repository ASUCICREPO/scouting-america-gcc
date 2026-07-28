export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  "REPLACE_AFTER_CDK_DEPLOY";

export const COGNITO_CONFIG = {
  userPoolId: process.env.NEXT_PUBLIC_USER_POOL_ID || "REPLACE_AFTER_CDK_DEPLOY",
  clientId:
    process.env.NEXT_PUBLIC_CLIENT_ID || "REPLACE_AFTER_CDK_DEPLOY",
  region: process.env.NEXT_PUBLIC_AWS_REGION || "us-east-1",
};
