# IAM Policies Reference — Scouting America GCC Volunteer Assistant

This document describes the IAM permissions and account prerequisites for deploying the Scouting America Grand Canyon Council (GCC) Volunteer Assistant end-to-end with `deploy.sh`.

The GCC deployment has three permission layers:

1. **Deployment Caller** — the IAM Identity Center role, IAM role, or user that runs `deploy.sh`
2. **CDK Bootstrap Roles** — roles created once in the target account and Region by `cdk bootstrap`
3. **Application Runtime Roles** — least-privilege roles created by the `ScoutingAmericaChatbot` CloudFormation stack

> **Important:** This repository does not create a CodeBuild project or an Amplify application from `deploy.sh`. The script runs CDK locally, builds the Next.js static export locally, publishes it to two S3 buckets, and invalidates two CloudFront distributions.

---

## Table of Contents

- [Deployment Overview](#deployment-overview)
- [Client Pre-Deployment Checklist](#client-pre-deployment-checklist)
- [Deployment Caller Policy](#deployment-caller-policy)
  - [Core Deployment Permissions](#core-deployment-permissions)
  - [Optional Script Permissions](#optional-script-permissions)
- [One-Time CDK Bootstrap](#one-time-cdk-bootstrap)
  - [Bootstrap Operator Policy](#bootstrap-operator-policy)
  - [CloudFormation Execution Policy](#cloudformation-execution-policy)
  - [CDK Bootstrap Roles](#cdk-bootstrap-roles)
- [One-Time Bedrock Model Access](#one-time-bedrock-model-access)
- [Application Runtime Roles](#application-runtime-roles)
- [Setup and Deployment Instructions](#setup-and-deployment-instructions)
- [Post-Deployment Verification](#post-deployment-verification)
- [Security and Operational Notes](#security-and-operational-notes)
- [AWS References](#aws-references)

---

## Deployment Overview

`deploy.sh` performs the following operations:

1. Validates the caller with `sts:GetCallerIdentity`.
2. Runs `npx cdk deploy ScoutingAmericaChatbot`.
3. Reads CloudFormation stack outputs.
4. Writes the frontend environment configuration locally.
5. Optionally creates an initial Cognito administrator.
6. Optionally uploads seed documents to the document bucket.
7. Builds the Next.js static export.
8. Publishes the public chat and admin dashboard to separate S3 buckets.
9. Invalidates the public and admin CloudFront distributions.

The script assumes that the target account and Region already have a modern CDK bootstrap stack named `CDKToolkit`.

### Deployment identifiers

| Item | Current value |
|---|---|
| CloudFormation stack | `ScoutingAmericaChatbot` |
| Default Region | `us-east-1` |
| Optional resource prefix | `RESOURCE_PREFIX` or `--prefix`, for example `dev` |
| Public frontend | Private S3 origin and dedicated CloudFront distribution |
| Admin frontend | Separate private S3 origin and dedicated CloudFront distribution |
| Chat model | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| Embedding model | `amazon.titan-embed-text-v2:0` |
| Chat archive retention | S3 Object Lock, governance mode, 365 days |

When `<PREFIX>` appears below, replace it with:

- An empty string for the default deployment, or
- The selected prefix followed by a hyphen, such as `dev-`.

---

## Client Pre-Deployment Checklist

Confirm these items with the client before the deployment call:

- [ ] AWS account ID is confirmed.
- [ ] Deployment Region is confirmed. The current default is `us-east-1`.
- [ ] The deployment environment has a modern `CDKToolkit` bootstrap stack.
- [ ] The deployment caller uses short-lived credentials, preferably through IAM Identity Center.
- [ ] The deployment caller policy below is attached.
- [ ] The CDK CloudFormation execution role is approved for the AWS services used by this stack.
- [ ] The Anthropic first-time-use form has been completed for the account or AWS Organization.
- [ ] AWS Marketplace access for Claude Haiku 4.5 is permitted by IAM and organization policies.
- [ ] Organization SCPs permit the US cross-Region inference destinations used by the model.
- [ ] The SES identity `staff@grandcanyonbsa.org` is verified in the deployment Region.
- [ ] The client can confirm the SNS email subscription sent to `staff@grandcanyonbsa.org`.
- [ ] The resource prefix is agreed upon. Do not change it between deployments of the same environment.
- [ ] The initial admin email is confirmed.
- [ ] The initial admin password will be exchanged securely and will not be placed in this document, email, source control, or meeting notes.
- [ ] Optional seed documents are ready in a local directory if `--ingest` will be used.

---

## Deployment Caller Policy

The recommended deployment identity is an IAM Identity Center permission set or an assumable role with short-lived credentials. Long-lived IAM user access keys are not recommended.

Replace `<ACCOUNT_ID>`, `<REGION>`, and `<PREFIX>` before attaching this policy.

### Core Deployment Permissions

The following policy covers the normal end-to-end `deploy.sh` flow for an already bootstrapped account:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "IdentifyCaller",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    },
    {
      "Sid": "AssumeCDKBootstrapRoles",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "iam:ResourceTag/aws-cdk:bootstrap-role": [
            "deploy",
            "file-publishing",
            "image-publishing",
            "lookup"
          ]
        }
      }
    },
    {
      "Sid": "ReadCDKBootstrapVersion",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:<REGION>:<ACCOUNT_ID>:parameter/cdk-bootstrap/hnb659fds/version"
    },
    {
      "Sid": "ReadDeploymentStackOutputs",
      "Effect": "Allow",
      "Action": [
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackResources"
      ],
      "Resource": [
        "arn:aws:cloudformation:<REGION>:<ACCOUNT_ID>:stack/ScoutingAmericaChatbot/*",
        "arn:aws:cloudformation:<REGION>:<ACCOUNT_ID>:stack/CDKToolkit/*"
      ]
    },
    {
      "Sid": "ListFrontendBuckets",
      "Effect": "Allow",
      "Action": [
        "s3:GetBucketLocation",
        "s3:ListBucket"
      ],
      "Resource": "arn:aws:s3:::scoutingamericachatbot-frontendhosting*"
    },
    {
      "Sid": "PublishFrontendAssets",
      "Effect": "Allow",
      "Action": [
        "s3:AbortMultipartUpload",
        "s3:DeleteObject",
        "s3:GetObject",
        "s3:PutObject"
      ],
      "Resource": "arn:aws:s3:::scoutingamericachatbot-frontendhosting*/*"
    },
    {
      "Sid": "InvalidateFrontendDistributions",
      "Effect": "Allow",
      "Action": "cloudfront:CreateInvalidation",
      "Resource": "arn:aws:cloudfront::<ACCOUNT_ID>:distribution/*"
    }
  ]
}
```

### What each core permission does

| Permission | Why it is required |
|---|---|
| `sts:GetCallerIdentity` | Verifies that AWS credentials are configured and identifies the target account |
| `sts:AssumeRole` | Allows CDK to assume the tagged deploy, asset-publishing, image-publishing, and lookup bootstrap roles |
| `ssm:GetParameter` | Reads the modern CDK bootstrap version |
| `cloudformation:DescribeStacks` | Reads deployment status and all outputs used by the frontend and optional setup steps |
| `cloudformation:DescribeStackResources` | Allows CDK and deployment diagnostics to resolve stack resources |
| `s3:GetBucketLocation/ListBucket` | Compares local static assets with the two deployed frontend buckets |
| `s3:PutObject/DeleteObject/GetObject/AbortMultipartUpload` | Publishes the public and admin static exports and removes stale files |
| `cloudfront:CreateInvalidation` | Invalidates both distributions after frontend publication |

The first deployment does not know the generated CloudFront distribution IDs in advance. The policy therefore permits invalidations on distributions in the target account. After the first deployment, the client may replace the wildcard with the two distribution ARNs returned by the stack.

### Optional Script Permissions

Add the following statements only when the matching `deploy.sh` option will be used.

#### Optional initial admin creation

Required when both `--admin-email` and `--admin-password` are supplied:

```json
{
  "Sid": "SeedInitialAdmin",
  "Effect": "Allow",
  "Action": [
    "cognito-idp:AdminAddUserToGroup",
    "cognito-idp:AdminCreateUser",
    "cognito-idp:AdminSetUserPassword",
    "cognito-idp:CreateGroup"
  ],
  "Resource": "arn:aws:cognito-idp:<REGION>:<ACCOUNT_ID>:userpool/*"
}
```

After the first deployment, replace `userpool/*` with the exact user pool ARN if the client requires narrower scope.

#### Optional seed-document upload

Required when `--ingest <DIRECTORY>` is supplied:

```json
[
  {
    "Sid": "ListGCCDocumentStore",
    "Effect": "Allow",
    "Action": [
      "s3:GetBucketLocation",
      "s3:ListBucket"
    ],
    "Resource": "arn:aws:s3:::<PREFIX>gcc-document-store"
  },
  {
    "Sid": "UploadGCCSeedDocuments",
    "Effect": "Allow",
    "Action": [
      "s3:AbortMultipartUpload",
      "s3:GetObject",
      "s3:PutObject"
    ],
    "Resource": "arn:aws:s3:::<PREFIX>gcc-document-store/uploads/*"
  }
]
```

Normal document management after deployment occurs through the authenticated admin dashboard and does not require the deployment caller to retain these S3 permissions.

---

## One-Time CDK Bootstrap

The target account and Region must be bootstrapped before `deploy.sh` is run. This is an account setup operation and should be performed by a client cloud administrator, not by the normal deployment identity.

### Bootstrap Operator Policy

AWS documents the following minimum service families for the identity that performs `cdk bootstrap`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BootstrapCDKEnvironment",
      "Effect": "Allow",
      "Action": [
        "cloudformation:*",
        "ecr:*",
        "iam:*",
        "s3:*",
        "ssm:*"
      ],
      "Resource": "*"
    }
  ]
}
```

This broad policy should be temporary. Remove it after the bootstrap succeeds. If `CDKToolkit` already exists and is current, this policy is not needed for the deployment call.

### CloudFormation Execution Policy

The bootstrap `CloudFormationExecutionRole` determines what the GCC stack can create and modify. The default CDK bootstrap configuration commonly gives this role `AdministratorAccess`. For a client-managed environment, use a dedicated managed policy restricted to the service families in the current synthesized stack:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DeployScoutingAmericaGCCStack",
      "Effect": "Allow",
      "Action": [
        "apigateway:*",
        "bedrock:*",
        "cloudfront:*",
        "cloudwatch:*",
        "cognito-idp:*",
        "dynamodb:*",
        "iam:*",
        "lambda:*",
        "logs:*",
        "s3:*",
        "s3vectors:*",
        "sns:*",
        "sqs:*"
      ],
      "Resource": "*"
    }
  ]
}
```

This policy is:

- Attached to the CDK `CloudFormationExecutionRole`, not to a human user.
- Restricted to AWS services represented in the synthesized GCC stack.
- Still powerful within those services because resource-creation APIs often do not have ARNs until after creation.
- A practical deployment boundary, not a permanent substitute for organization SCPs, permission boundaries, CloudTrail, or IAM Access Analyzer.

Create this as a customer-managed policy, then reference its ARN during bootstrap:

```bash
npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION> \
  --cloudformation-execution-policies \
  arn:aws:iam::<ACCOUNT_ID>:policy/GCC-CDK-CloudFormationExecutionPolicy
```

The client may further restrict actions or resources after the first controlled deployment. Validate any narrower policy against stack updates and rollback paths, because CloudFormation requires create, update, and delete permissions.

### CDK Bootstrap Roles

Modern CDK bootstrapping creates these roles:

| Role | Purpose |
|---|---|
| `CloudFormationExecutionRole` | Performs AWS service operations contained in the CloudFormation template |
| `DeploymentActionRole` | Creates and monitors the CloudFormation change set and passes the execution role |
| `FilePublishingRole` | Uploads Lambda code and the Python dependency layer to the CDK S3 assets bucket |
| `ImagePublishingRole` | Publishes container assets to the CDK ECR repository; retained by the standard bootstrap even though this stack currently uses file assets |
| `LookupRole` | Performs read-only context lookups during synthesis and deployment |

The deployment caller only assumes these tagged roles. It does not need direct permission to create Lambda functions, Bedrock resources, DynamoDB tables, or application runtime roles.

---

## One-Time Bedrock Model Access

Claude Haiku 4.5 is a third-party Anthropic model with AWS Marketplace product ID `prod-xdkflymybwmvi`. AWS requires Marketplace permissions for initial model enablement and an Anthropic first-time-use submission.

This is an account-governance operation. A client account administrator should complete it before deployment; neither the deployment caller nor the runtime Lambda roles need Marketplace subscription permissions after the model is enabled.

A temporary model-access operator policy can be structured as follows:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SubscribeToClaudeHaiku45",
      "Effect": "Allow",
      "Action": "aws-marketplace:Subscribe",
      "Resource": "*",
      "Condition": {
        "ForAnyValue:StringEquals": {
          "aws-marketplace:ProductId": [
            "prod-xdkflymybwmvi"
          ]
        }
      }
    },
    {
      "Sid": "ManageMarketplaceSubscription",
      "Effect": "Allow",
      "Action": [
        "aws-marketplace:Unsubscribe",
        "aws-marketplace:ViewSubscriptions"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SubmitAndVerifyAnthropicAccess",
      "Effect": "Allow",
      "Action": [
        "bedrock:GetFoundationModelAvailability",
        "bedrock:PutUseCaseForModelAccess"
      ],
      "Resource": "*"
    }
  ]
}
```

Only `aws-marketplace:Subscribe` supports restriction through the `aws-marketplace:ProductId` condition key. Remove this temporary policy after model access and the Anthropic form are confirmed.

Amazon Titan Text Embeddings v2 is an Amazon model and does not use an AWS Marketplace product subscription.

---

## Application Runtime Roles

These roles are generated by CDK inside `ScoutingAmericaChatbot`. They are used by the running application, not by the deployment caller.

All Lambda roles also receive the AWS-managed `AWSLambdaBasicExecutionRole` policy for CloudWatch Logs.

### Bedrock Knowledge Base Role

Role name: `<PREFIX>GCC-BedrockKB-Role`<br>
Trusted service: `bedrock.amazonaws.com`

| Actions | Resource | Purpose |
|---|---|---|
| `bedrock:InvokeModel` | `foundation-model/amazon.titan-embed-text-v2:0` in the deployment Region | Generate document embeddings |
| `s3:GetBucket*`, `s3:GetObject*`, `s3:List*` | `<PREFIX>gcc-knowledge-base-data` | Read approved knowledge-base documents |
| `s3vectors:GetVectorBucket`, `GetIndex`, `PutVectors`, `GetVectors`, `DeleteVectors`, `QueryVectors`, `ListIndexes`, `ListVectors` | `<PREFIX>gcc-volunteer-vectors` and `gcc-docs-index` | Store and retrieve embeddings |

### Chat Handler Lambda Role

Function: `<PREFIX>GCC-ChatHandler`

| Actions | Resource | Purpose |
|---|---|---|
| DynamoDB read/write operations | `<PREFIX>GCC-ChatLogs` and its indexes | Store chat turns, retrieve history, and record feedback |
| `bedrock:Retrieve` | GCC Knowledge Base | Retrieve approved source chunks |
| `bedrock:GetPrompt` | Versioned GCC Bedrock prompt | Load the immutable production prompt |
| `bedrock:ApplyGuardrail` | Versioned GCC response guardrail | Apply input/output protections |
| `bedrock:GetInferenceProfile`, `bedrock:InvokeModel` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` inference profile and routed foundation models | Generate the grounded answer |
| `lambda:InvokeFunction` | `<PREFIX>GCC-EscalationRouter` | Send low-confidence and safety escalations asynchronously |

The synthesized stack currently grants the Bedrock actions with `Resource: "*"`, because retrieval, prompt, guardrail, inference-profile, and routed-model ARNs have different resource formats. These permissions can be narrowed in a production hardening pass after the final account and Region are fixed.

### Document Processor Lambda Role

Function: CDK-generated document processor function

| Actions | Resource | Purpose |
|---|---|---|
| SQS receive/delete/visibility operations | `<PREFIX>GCC-DocProcessor-Queue` | Consume bounded document-processing work |
| S3 read operations | `<PREFIX>gcc-document-store` | Read admin-uploaded source documents |
| S3 read/write operations | `<PREFIX>gcc-knowledge-base-data` | Copy documents into the Bedrock ingestion prefix |
| DynamoDB write operations | `<PREFIX>GCC-AnalyticsLogs` | Record document-processing outcomes |
| `bedrock:StartIngestionJob` | GCC Knowledge Base | Start ingestion after a document is copied |

### Escalation Router Lambda Role

Function: `<PREFIX>GCC-EscalationRouter`

| Actions | Resource | Purpose |
|---|---|---|
| `sns:Publish` | `<PREFIX>gcc-staff-alerts` | Publish medium- and high-severity alerts |
| `ses:SendEmail`, `ses:SendRawEmail` | `*` | Send high-severity safety email alerts from the verified staff address |
| DynamoDB write operations | `<PREFIX>GCC-AnalyticsLogs` | Record escalation events |
| `sqs:SendMessage` | `<PREFIX>GCC-EscalationRouter-DLQ` | Retain failed asynchronous invocations |

### Chat Archiver Lambda Role

Function: `<PREFIX>GCC-ChatArchiver`

| Actions | Resource | Purpose |
|---|---|---|
| DynamoDB stream read operations | Stream on `<PREFIX>GCC-ChatLogs` | Receive newly delivered chat records |
| `dynamodb:ListStreams` | `*` | Discover the table stream |
| S3 put and retention-related operations | `<PREFIX>gcc-chat-audit-archive/*` | Write immutable JSON audit records |
| SQS queue operations | `<PREFIX>GCC-ChatArchive-DLQ` | Retain failed archive records |

The archiver is not granted `s3:BypassGovernanceRetention`.

### Admin Dashboard Lambda Role

Function: `<PREFIX>GCC-AdminDashboard`

| Actions | Resource | Purpose |
|---|---|---|
| DynamoDB read operations | `<PREFIX>GCC-ChatLogs`, its indexes, and `<PREFIX>GCC-AnalyticsLogs` | Produce dashboard metrics and transcripts |
| `s3:ListBucket` | Document and knowledge-base buckets | List uploaded documents |
| `s3:GetObject`, `PutObject`, `DeleteObject` | `<PREFIX>gcc-document-store/uploads/*` | Download, upload, and delete managed documents |
| `s3:DeleteObject` | `<PREFIX>gcc-knowledge-base-data/documents/*` | Remove deleted documents from the ingestion prefix |
| `bedrock:StartIngestionJob`, `ListIngestionJobs`, `GetIngestionJob` | GCC Knowledge Base | Refresh and display ingestion state |

Every dashboard route is protected by a Cognito authorizer, and the Lambda separately requires membership in the `admin` group.

### CDK Custom Resource Roles

CDK creates small helper Lambda roles for:

- Configuring the document bucket notification that sends uploads to SQS.
- Emptying the two non-production frontend buckets if the stack is deleted.

These helpers are created and scoped automatically by CDK. The retained document, knowledge-base, archive, and DynamoDB resources are not emptied by these helpers.

---

## Setup and Deployment Instructions

### 1. Confirm the deployment identity

Prefer an IAM Identity Center profile or an assumable deployment role:

```bash
aws sts get-caller-identity \
  --profile <GCC_DEPLOYMENT_PROFILE> \
  --region <REGION>
```

Do not send access keys, secret keys, session tokens, or passwords by email or place them in this Markdown file.

### 2. Confirm CDK bootstrap status

```bash
aws cloudformation describe-stacks \
  --stack-name CDKToolkit \
  --profile <GCC_DEPLOYMENT_PROFILE> \
  --region <REGION>
```

If the stack does not exist, a client cloud administrator must perform the one-time bootstrap described above.

### 3. Confirm Bedrock access

The application uses:

- `us.anthropic.claude-haiku-4-5-20251001-v1:0`
- `amazon.titan-embed-text-v2:0`

For Anthropic, complete the first-time-use form and confirm Marketplace access before the call. The US inference profile can route requests to multiple US Regions, so relevant SCPs must not deny any required destination Region.

### 4. Confirm email readiness

- Verify `staff@grandcanyonbsa.org` in Amazon SES in the deployment Region.
- If SES is in sandbox mode, both sender and recipient restrictions apply.
- After deployment, open the SNS subscription confirmation email and select **Confirm subscription**.

### 5. Run the deployment

From the repository root:

```bash
./deploy.sh \
  --region <REGION> \
  --profile <GCC_DEPLOYMENT_PROFILE> \
  --prefix <PREFIX_WITHOUT_TRAILING_HYPHEN> \
  --admin-email <ADMIN_EMAIL> \
  --admin-password '<TEMPORARY_ADMIN_PASSWORD>' \
  --ingest <OPTIONAL_DOCUMENT_DIRECTORY>
```

Omit `--prefix`, `--admin-email`, `--admin-password`, or `--ingest` when that feature is not needed.

The person operating the terminal should enter the temporary password securely. Do not paste it into chat, email, tickets, source control, or recorded meeting notes. Rotate it after the first successful sign-in.

---

## Post-Deployment Verification

Complete these checks during or immediately after the deployment call:

- [ ] `ScoutingAmericaChatbot` reaches `CREATE_COMPLETE` or `UPDATE_COMPLETE`.
- [ ] Public and admin CloudFront URLs are returned as separate outputs.
- [ ] Public chat loads and cannot serve `/login` or `/dashboard`.
- [ ] Admin login succeeds only for a member of the Cognito `admin` group.
- [ ] Public API CORS accepts only the public CloudFront origin.
- [ ] Admin API and document S3 CORS accept only the admin CloudFront origin.
- [ ] A test chat answer uses retrieved GCC sources.
- [ ] Chat continuation, history, and feedback work with the anonymous session token.
- [ ] A test document enters `<PREFIX>GCC-DocProcessor-Queue` and completes ingestion.
- [ ] A new chat record is copied to `<PREFIX>gcc-chat-audit-archive`.
- [ ] The `GCC-Operations` CloudWatch dashboard displays Lambda and queue metrics.
- [ ] The SNS subscription is confirmed.
- [ ] A controlled test alert reaches the staff mailbox.
- [ ] All application DLQs are empty after the smoke test.

---

## Security and Operational Notes

- **No CodeBuild deployment role:** `deploy.sh` runs on the caller's workstation or CloudShell. `buildspec.yml` is available for a future CI/CD setup, but this script does not create or use a CodeBuild project.
- **No Amplify hosting:** Both frontend surfaces use private S3 buckets behind CloudFront.
- **Short-lived credentials:** Prefer IAM Identity Center or role assumption over IAM users with long-lived access keys.
- **CDK execution boundary:** The caller assumes tagged bootstrap roles. The CloudFormation execution policy—not the human caller policy—controls which resources the stack can create.
- **Resource `*` usage:** Some create/list operations and cross-Region Bedrock inference permissions cannot be fully scoped before resources exist. Use SCPs, permission boundaries, and Access Analyzer as additional controls.
- **Cross-Region inference:** The US Claude Haiku 4.5 inference profile can route prompts to supported US destination Regions. Confirm that this matches the client's data residency requirements and SCP configuration.
- **Bedrock third-party access:** Anthropic access can require a first-time-use submission and AWS Marketplace permissions. These account-governance permissions are not needed by the application runtime role.
- **S3 Object Lock:** Chat archives use governance mode for 365 days. Do not grant the archiver or normal operators `s3:BypassGovernanceRetention`.
- **Retained resources:** The document store, knowledge-base bucket, audit archive, and DynamoDB tables are retained when the application stack is deleted.
- **SES verification:** The stack grants the runtime send action but does not create or verify the SES identity.
- **SNS confirmation:** Email subscriptions remain pending until the mailbox owner confirms them.
- **Resource prefix:** Keep the same prefix for every update to a given environment. Changing it creates or targets a different resource set.
- **Generated frontend resources:** The public/admin S3 bucket names and CloudFront distribution IDs are generated during deployment and returned as stack outputs.
- **Policy refinement:** After the first controlled deployment, use CloudTrail and IAM Access Analyzer to tighten wildcard resources while preserving CloudFormation rollback permissions.

---

## AWS References

- [AWS CDK security best practices](https://docs.aws.amazon.com/cdk/v2/guide/best-practices-security.html)
- [Bootstrap an AWS environment for CDK](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html)
- [Deploy AWS CDK applications](https://docs.aws.amazon.com/cdk/v2/guide/deploy.html)
- [Amazon Bedrock model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)
- [Claude Haiku 4.5 model card and Region support](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html)
- [Bedrock inference profile prerequisites](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html)
- [Bedrock cross-Region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html)
- [Amazon S3 Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html)
- [CloudFront IAM actions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_cloudfront.html)
- [CloudFormation IAM actions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_awscloudformation.html)
