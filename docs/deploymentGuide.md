# Deployment Guide

This guide describes reviewed deployments of Grand Canyon Council Scout AI to AWS. Deployment changes cloud infrastructure and publishes the frontend. Confirm the target account, region, branch, stack, and resource prefix before running any command.

## Deployment Model

The repository deploys one CDK stack named `ScoutingAmericaChatbot`. The stack contains the backend, data stores, authentication, knowledge base, and static frontend hosting.

`deploy.sh` is a thin deployment orchestrator. It packages the reviewed Git commit, creates or updates the GCC deployment-support IAM resources and private source bucket, then starts one AWS CodeBuild job.

CodeBuild performs the supported end-to-end workflow:

1. Installs locked backend dependencies and runs the backend tests.
2. Bootstraps or updates the target account/Region for CDK.
3. Deploys the CDK stack through the sandbox CDK bootstrap roles.
4. Reads the stack outputs and generates the build-time frontend environment.
5. Builds the Next.js static export.
6. Publishes public and admin assets to separate private S3 origins.
7. Invalidates both CloudFront distributions.

After CodeBuild succeeds, `deploy.sh` optionally creates the first Cognito administrator and prints all application URLs. Knowledge-base documents are uploaded later through the authenticated admin dashboard.

## Requirements

### Local Tools

- Bash
- AWS CLI v2
- Git
- jq

Node.js 20, Python 3.13, npm, pip, and the repository-local CDK CLI run inside CodeBuild. They are not required on the deployment caller's workstation or in CloudShell.

### AWS Region And Services

The default region is `us-west-2`. The target account must support and authorize:

- CloudFormation and IAM
- Lambda, API Gateway, CloudWatch Logs, and SQS
- S3, S3 Vectors, CloudFront, and DynamoDB
- Amazon Bedrock Knowledge Bases and required model access
- Cognito, Bedrock Prompt Management and Guardrails, SNS, and SES

Confirm that Claude Haiku 4.5 through the configured inference profile and Titan Text Embeddings v2 are available in the target region.

### AWS Permissions

This convenience installer requires an administrator-capable AWS CLI identity in an approved sandbox. It creates a CodeBuild service role and attaches the AWS-managed `AdministratorAccess` policy so that CDK bootstrap and first deployment do not require iterative IAM additions. This permission model is intentionally sandbox-only and must be replaced with reviewed least-privilege roles before production use.

## Pre-Deployment Review

### Confirm The Source

Deploy only the reviewed commit or branch approved for the target environment:

```bash
git status --short --branch
git log -1 --oneline
```

Do not deploy with unresolved tracked changes. Local document sets and environment files should not be committed.

### Confirm AWS Identity And Region

```bash
aws sts get-caller-identity
aws configure get region
```

For a named profile:

```bash
aws sts get-caller-identity --profile my-profile
```

### CDK Bootstrap

No separate caller-side bootstrap command is required. CodeBuild runs `cdk bootstrap` on every deployment; the operation is idempotent and creates or updates `CDKToolkit` in the selected account and Region.

### Choose A Resource Prefix

`RESOURCE_PREFIX` allows named AWS resources for different environments to coexist. Examples:

```bash
RESOURCE_PREFIX=demo ./deploy.sh
RESOURCE_PREFIX=staging ./deploy.sh
```

Rules:

- Lowercase letters and numbers are allowed.
- Hyphens are allowed only inside the prefix.
- Maximum length is 30 characters.
- An empty prefix preserves legacy unprefixed names.

**Always reuse the same prefix when updating an existing environment.** Changing or omitting it changes physical resource names and can cause replacements, empty dashboards, missing chat history, bucket-name collisions, or retained duplicate data resources.

The prefix does not change the CloudFormation stack name. This repository manages one `ScoutingAmericaChatbot` stack per account/region.

### Public And Admin Origins

The stack creates separate public and admin S3/CloudFront deployments. CloudFormation passes those generated domains directly into API Gateway, Lambda, and upload-bucket CORS configuration, so a second CORS-tightening deployment is not required. For custom domains, keep the same separation: use the public application at the root domain and the dashboard at an admin subdomain.

## Recommended Deployment

From the repository root:

```bash
RESOURCE_PREFIX=demo ./deploy.sh
```

Optional flags:

```text
--region REGION
--profile PROFILE
--prefix PREFIX
--admin-email EMAIL
--admin-password PASSWORD
--skip-admin
--yes
```

`RESOURCE_PREFIX=demo ./deploy.sh` and `./deploy.sh --prefix demo` are equivalent.

### Deploy With A Named Profile

```bash
./deploy.sh --profile my-profile --region us-west-2 --prefix demo
```

### Create Or Update An Admin User

```bash
./deploy.sh \
  --prefix demo \
  --admin-email admin@example.org
```

The script prompts privately for the password, creates the user if necessary, sets a permanent password, and adds the user to the CDK-created `admin` group. For approved non-interactive use, set `GCC_ADMIN_PASSWORD` temporarily and unset it immediately afterward. Avoid `--admin-password` in interactive shells because it exposes the value in shell history.

### Add Knowledge-Base Documents

`deploy.sh` does not package or upload a local document directory. After deployment, sign in to the protected admin dashboard and upload approved files from the Documents page. Each upload enters the bounded document-processing queue, retries transient failures, and moves exhausted messages to the monitored DLQ.

## What The Build Writes

Inside the disposable CodeBuild workspace, `frontend/.env.local` contains:

```dotenv
NEXT_PUBLIC_API_URL=...
NEXT_PUBLIC_DASHBOARD_API_URL=...
NEXT_PUBLIC_USER_POOL_ID=...
NEXT_PUBLIC_CLIENT_ID=...
NEXT_PUBLIC_AWS_REGION=...
```

These values are embedded into the static frontend during `npm run build`. The file is not written back to the caller's checkout or uploaded as a build artifact. Do not copy one environment's built `frontend/out/` into another environment.

## CloudFormation Outputs

The stack exports:

| Output | Purpose |
| --- | --- |
| `ChatApiUrl` | Public chat API base URL |
| `DashboardApiUrl` | Cognito-protected dashboard API base URL |
| `UserPoolId` | Cognito User Pool |
| `UserPoolClientId` | Browser client ID |
| `DocumentStoreBucket` | Raw document uploads |
| `KnowledgeBaseBucket` | Bedrock data source documents |
| `PublicFrontendBucket` | Public chat static-export target; admin paths are excluded |
| `PublicFrontendDistributionId` | Public CloudFront invalidation target |
| `PublicFrontendUrl` | Public chat URL |
| `AdminFrontendBucket` | Admin dashboard static-export target |
| `AdminFrontendDistributionId` | Admin CloudFront invalidation target |
| `AdminFrontendUrl` | Admin login/dashboard URL |
| `ChatArchiveBucket` | Object-locked chat audit archive |
| `OperationsDashboardName` | CloudWatch operations dashboard |

Read them without changing the stack:

```bash
aws cloudformation describe-stacks \
  --stack-name ScoutingAmericaChatbot \
  --region us-west-2 \
  --query 'Stacks[0].Outputs' \
  --output table
```

## Post-Deployment Verification

### Stack Status

```bash
aws cloudformation describe-stacks \
  --stack-name ScoutingAmericaChatbot \
  --region us-west-2 \
  --query 'Stacks[0].StackStatus' \
  --output text
```

Expected status after an update: `UPDATE_COMPLETE`. A first deployment ends at `CREATE_COMPLETE`.

### CloudFront Invalidation

`deploy.sh` submits an invalidation but does not wait for it to finish. Retrieve the distribution output and inspect the newest invalidation:

```bash
PUBLIC_DIST_ID=$(aws cloudformation describe-stacks \
  --stack-name ScoutingAmericaChatbot \
  --region us-west-2 \
  --query "Stacks[0].Outputs[?OutputKey=='PublicFrontendDistributionId'].OutputValue" \
  --output text)

aws cloudfront list-invalidations \
  --distribution-id "$PUBLIC_DIST_ID" \
  --max-items 1
```

Repeat with `AdminFrontendDistributionId`. Wait for status `Completed` before concluding that every edge location has the new files.

### Frontend Routes

Open `PublicFrontendUrl` and verify `/` works while `/login` and `/dashboard` return an error. Open `AdminFrontendUrl`; `/` should resolve to `/login`, and authenticated deep links under `/dashboard` should refresh successfully.

### Public Chat Contract

```bash
CHAT_API=$(aws cloudformation describe-stacks \
  --stack-name ScoutingAmericaChatbot \
  --region us-west-2 \
  --query "Stacks[0].Outputs[?OutputKey=='ChatApiUrl'].OutputValue" \
  --output text)

curl -sS -X POST "${CHAT_API%/}/chat" \
  -H 'Content-Type: application/json' \
  -d '{"question":"What can you tell me about Camp Geronimo?","language":"en"}'
```

Repeat with a Spanish question and `"language":"es"`. Confirm the response includes `answer`, `sessionId`, `sessionToken`, `messageId`, and the selected `language`. A follow-up with `sessionId` must also send the returned value in `X-Session-Token`.

### Dashboard

Sign in with an authorized admin account and verify:

- Summary and feedback data load without `401` or `403`.
- A rated conversation opens the full transcript.
- The English/Spanish control works in **Settings > Appearance**.
- A small test document uploads and progresses toward **Ready**.
- Download and deletion are available only after authentication.

### Logs And Ingestion

Check recent Lambda errors:

```bash
aws logs tail /aws/lambda/demo-GCC-ChatHandler --since 15m --region us-west-2
aws logs tail /aws/lambda/demo-GCC-AdminDashboard --since 15m --region us-west-2
aws logs tail /aws/lambda/demo-GCC-EscalationRouter --since 15m --region us-west-2
```

CDK-generated document-processor function names include a stack/logical-ID suffix. Locate it before tailing:

```bash
aws lambda list-functions \
  --region us-west-2 \
  --query "Functions[?contains(FunctionName, 'DocProcessor')].FunctionName" \
  --output text
```

Replace `demo-` with the environment's actual prefix.

## Manual Backend-Only Deployment

Use this only when intentionally omitting the frontend publish:

```bash
cd backend
npm ci
npm test
npx cdk synth
RESOURCE_PREFIX=demo npx cdk deploy ScoutingAmericaChatbot --require-approval never
```

Set `RESOURCE_PREFIX` on synthesis and deployment. A backend-only deployment does not regenerate `frontend/.env.local`, rebuild the static export, sync S3, or invalidate CloudFront.

## CodeBuild

`deploy.sh` creates or updates a stable project named `<PREFIX>gcc-chatbot-deployment`. Its S3 source is an archive of the exact reviewed Git `HEAD`, not the caller's uncommitted working tree and not a long-lived GitHub credential.

`buildspec.yml` runs backend tests, bootstraps CDK, deploys the stack, builds `frontend/out`, publishes both isolated frontend origins, and invalidates both CloudFront distributions. The script streams the project's CloudWatch logs until CodeBuild reaches a terminal state.

## Troubleshooting

### Resource Already Exists

**Cause:** The deployment used a different prefix, no prefix, or a retained explicit-name resource already exists.

**Action:** Stop and identify the existing environment. Do not delete a bucket or table simply to make deployment pass. Compare the intended prefix with the stack template and retained resources, then choose an approved migration or the original prefix.

### Dashboard Opens The Public Home Page

**Cause:** One CloudFront surface is serving an old export or does not have its route-rewrite function associated.

**Action:** Confirm the current stack includes both CloudFront Functions, rebuild with `trailingSlash: true`, publish with `deploy.sh`, and wait for both invalidations. Do not sync `/login` or `/dashboard` into the public bucket.

### Frontend Uses The Wrong API

**Cause:** The wrong prefix was supplied to CodeBuild, an older build was published, or a CloudFront invalidation is still in progress.

**Action:** Re-run the approved deployment from the intended commit with the correct prefix, confirm the CodeBuild environment values, and wait for both invalidations to complete.

### Chat Returns 500

Check the chat-handler log for Bedrock permissions, model availability, knowledge-base state, prompt-template errors, or DynamoDB access. Verify the KB has a completed ingestion job and that `$search_results$` remains in the generation prompt.

### Document Upload Fails In The Browser

- Confirm the dashboard token is valid.
- Confirm the file type and size are supported.
- Check the presigned POST policy response and ensure the browser submits all returned fields before the file.
- Compare the browser origin with `AdminFrontendUrl`.
- Check the S3 CORS configuration and dashboard Lambda logs.

### Document Stays Pending

Check the document-processor logs, its dead-letter queue, the copied object under the KB bucket's `documents/` prefix, and Bedrock ingestion jobs. Multiple simultaneous uploads can cause a start request to fail while another ingestion job is active.

### Admin Login Fails

- Verify the frontend User Pool ID and client ID.
- Verify the account has a permanent password.
- Verify the user belongs to `admin`.
- Confirm `NEXT_PUBLIC_AWS_REGION` in the generated frontend environment matches the deployed region.

## Cleanup And Destruction

Destruction is irreversible for non-retained resources and can make the frontend unavailable. It requires explicit environment-owner approval.

Preview the target first:

```bash
aws sts get-caller-identity
aws cloudformation describe-stacks --stack-name ScoutingAmericaChatbot --region us-west-2
```

The CDK destroy command is:

```bash
cd backend
RESOURCE_PREFIX=demo npx cdk destroy ScoutingAmericaChatbot
```

The document buckets, chat and analytics tables, and Cognito User Pool use `RETAIN`, so stack destruction does not constitute a full data deletion. The static frontend bucket is auto-deleted. Inventory and back up retained data before any separately approved manual cleanup.

## Related Documentation

- [Development Guide](./developmentGuide.md)
- [API Documentation](./APIDoc.md)
- [Architecture Deep Dive](./architectureDeepDive.md)
- [User Guide](./userGuide.md)
