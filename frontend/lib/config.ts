export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  "https://jaokqq2aif.execute-api.us-east-1.amazonaws.com/prod";

export const COGNITO_CONFIG = {
  userPoolId: process.env.NEXT_PUBLIC_USER_POOL_ID || "us-east-1_zlxvcEmTL",
  clientId:
    process.env.NEXT_PUBLIC_CLIENT_ID || "7idmd74una3f4eekp8bo1dgo2i",
  region: "us-east-1",
};
