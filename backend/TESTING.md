# Backend Testing Guide

## Prerequisites

- AWS CLI configured with credentials (`aws sts get-caller-identity`)
- Node.js 20+
- esbuild installed locally: `npm install --save-dev esbuild`

## Docker Not Required

CDK uses `NodejsFunction` which defaults to Docker for bundling Lambda code. We bypass this by installing esbuild locally — CDK auto-detects it and skips Docker. If you see a Docker error like:

```
docker exited with status 1
```

Just run:

```bash
npm install --save-dev esbuild
```

Then retry. No Docker Desktop needed.

## Deploy

```bash
cd backend
npm install
npx cdk deploy
```

Note the stack outputs — you'll need `UserPoolId`, `UserPoolClientId`, and the API endpoints.

## Known Issues: Orphaned Resources

If deploy fails with "already exists" errors for S3 buckets or DynamoDB tables, delete them manually:

```bash
aws dynamodb delete-table --table-name GCC-ChatLogs
aws dynamodb delete-table --table-name GCC-AnalyticsLogs
aws s3 rb s3://gcc-document-store --force
aws s3 rb s3://gcc-knowledge-base-data --force
```

Also delete any stuck `BackendStack` in CloudFormation:

```bash
aws cloudformation delete-stack --stack-name BackendStack
```

Then retry `npx cdk deploy`.

## Create a Test User

```bash
# Replace <USER_POOL_ID> with the value from stack outputs
aws cognito-idp admin-create-user \
  --user-pool-id <USER_POOL_ID> \
  --username test@example.com \
  --temporary-password TempPass123! \
  --user-attributes Name=email,Value=test@example.com Name=email_verified,Value=true Name=given_name,Value=Test Name=family_name,Value=User

# Add to admin group
aws cognito-idp admin-add-user-to-group \
  --user-pool-id <USER_POOL_ID> \
  --username test@example.com \
  --group-name admin
```

## Get Auth Token (PowerShell)

```powershell
# Step 1: Initiate auth (returns NEW_PASSWORD_REQUIRED challenge)
$auth = aws cognito-idp initiate-auth --client-id <CLIENT_ID> --auth-flow USER_PASSWORD_AUTH --auth-parameters USERNAME=test@example.com,PASSWORD=TempPass123! | ConvertFrom-Json

# Step 2: Set new password
$result = aws cognito-idp respond-to-auth-challenge --client-id <CLIENT_ID> --challenge-name NEW_PASSWORD_REQUIRED --challenge-responses "USERNAME=test@example.com,NEW_PASSWORD=TestPass456!,userAttributes.given_name=Test,userAttributes.family_name=User" --session $auth.Session | ConvertFrom-Json
$token = $result.AuthenticationResult.IdToken

# For subsequent logins (password already set):
$auth = aws cognito-idp initiate-auth --client-id <CLIENT_ID> --auth-flow USER_PASSWORD_AUTH --auth-parameters USERNAME=test@example.com,PASSWORD=TestPass456! | ConvertFrom-Json
$token = $auth.AuthenticationResult.IdToken
```

## Upload Documents

Sign in at `/admin`, open **Documents**, and upload the file or folder from the
dashboard. The dashboard creates a server-validated upload manifest and signed
S3 POST for each file. Direct `aws s3 cp` or console uploads are intentionally
rejected because they do not contain the signed batch metadata required by the
document processor.

Wait 1-2 minutes for processing and KB ingestion before querying.

## Test Chat API

```powershell
Invoke-RestMethod -Method POST -Uri "<CHAT_API_URL>/chat" `
  -Headers @{Authorization=$token;"Content-Type"="application/json"} `
  -Body '{"question":"What food is served at camp?","userId":"test@example.com"}'
```

Expected response:
```json
{
  "answer": "Based on the documents...",
  "sources": ["s3://gcc-knowledge-base-data/chunks/..."],
  "confidence": 0.25,
  "sessionId": "uuid",
  "escalated": true
}
```

Note: Confidence is based on citation count (0.25 per citation). Low confidence triggers escalation — this is expected behavior for single-document answers.

## Test Admin API

```powershell
# List documents
Invoke-RestMethod -Method GET -Uri "<ADMIN_API_URL>/admin/documents" `
  -Headers @{Authorization=$token}

# Get analytics
Invoke-RestMethod -Method GET -Uri "<ADMIN_API_URL>/admin/analytics/usage" `
  -Headers @{Authorization=$token}
```

## Tear Down

```bash
npx cdk destroy
```

S3 buckets and DynamoDB tables are retained after destroy (removalPolicy: RETAIN). To fully clean up, delete them manually:

```bash
aws dynamodb delete-table --table-name GCC-ChatLogs
aws dynamodb delete-table --table-name GCC-AnalyticsLogs
aws s3 rb s3://gcc-document-store --force
aws s3 rb s3://gcc-knowledge-base-data --force
```

Also delete any leftover CloudWatch log groups:

```bash
aws logs delete-log-group --log-group-name /aws/lambda/GCC-ChatHandler
aws logs delete-log-group --log-group-name /aws/lambda/GCC-EscalationRouter
```
