# Architecture Deep Dive

This document describes the deployed architecture of Grand Canyon Council Scout AI. It reflects the CDK constructs and Lambda handlers in this repository as of July 24, 2026.

## Architecture Diagram

![Grand Canyon Council Scout AI AWS architecture](./media/architecture.png)

The editable Graphviz source is [architecture.dot](./media/architecture.dot). Regenerate the image with:

```bash
dot -Tpng -Gdpi=160 docs/media/architecture.dot -o docs/media/architecture.png
```

## System Boundaries

Scout AI has two browser-facing experiences in one Next.js static application published through one private-S3/CloudFront origin:

- **Public chat** at `/`, available without a user account.
- **Admin application** with sign-in at `/admin` and protected pages under `/dashboard`, backed by Amazon Cognito and an `admin` group check.

The frontend is a static export. Display preferences and the anonymous chat-session credential are stored in browser `localStorage`; admin JWTs use `sessionStorage`. Chat turns, feedback, confidence values, and escalation state are stored server-side in DynamoDB.

## Request Flows

### Public Chat Flow

1. The browser downloads the static export through CloudFront and opens the public chat at `/`.
2. The frontend sends `POST /chat` with `question` and `language`. Existing sessions also send `sessionId` plus the server-issued `X-Session-Token`.
3. API Gateway invokes the Python 3.13 chat-handler Lambda.
4. The Lambda validates the typed request and, for existing sessions, compares the bearer-token hash with the stored session hash.
5. The Lambda retrieves up to five chunks once from the Bedrock Knowledge Base. Those exact chunks are rendered through the immutable Prompt Management version and sent to Claude Haiku 4.5 through `Converse`; Bedrock Guardrails evaluates the generation input and output.
6. The Lambda averages the returned retrieval scores. A missing score set falls back to confidence `0.3`.
7. Safety keywords or confidence below `0.7` trigger the escalation-router Lambda asynchronously.
8. The turn is written to DynamoDB and returned with a session ID, anonymous session token, message ID, exact sources, confidence, escalation flag, and language.
9. A DynamoDB stream copies the original delivered turn into an object-locked S3 audit archive.
10. History and feedback calls require both the session ID and anonymous bearer token, preventing access through a guessed or leaked ID alone.

### Bilingual Flow

The shared frontend `LanguageContext` owns English/Spanish state for the chatbot, login screen, and dashboard. The selected language is persisted under `gcc_language` and synchronized with legacy chat and dashboard settings keys.

For chat generation, the browser sends the explicit language code on every request. The Lambda rejects unsupported values and adds a language requirement to the Bedrock prompt. The chosen language is returned by the API and persisted with the chat turn. Loading saved history restores the language recorded for that conversation.

The interface does not perform machine translation at render time. English and Spanish interface strings are maintained in `frontend/lib/i18n.ts`, while the model generates the answer directly in the requested language.

### Document Ingestion Flow

1. An authenticated administrator submits a manifest of up to 500 nested files to `POST /dashboard/documents/upload`.
2. The dashboard API creates short-lived DynamoDB batch state and returns one five-minute presigned POST policy per file. Every policy binds the exact S3 key, MIME type, byte size, and batch ID.
3. The browser uploads at most four files concurrently while retaining each relative path below `uploads/`.
4. At-least-once S3 `ObjectCreated` events enter an encrypted standard SQS queue. Two Lambda workers use S3 version IDs and idempotent batch tokens to tolerate duplicate or out-of-order notifications.
5. Each worker verifies the server-created manifest, stored metadata, size, binary signature, UTF-8 text, and Office ZIP structure. Invalid objects move to a private seven-day `quarantine/` prefix; accepted objects retain the same relative path below the knowledge-base `documents/` prefix.
6. When every expected object reaches a terminal state, the worker publishes one message to a FIFO queue. One message group serializes `StartIngestionJob`; a batch waits and retries while the shared data source already has an active job.
7. Bedrock incrementally processes changed objects, applies semantic chunking (maximum 800 tokens), creates Titan embeddings, and stores vectors in the S3 Vectors index.
8. The dashboard derives each document's `ready`, `indexing`, `pending`, or `failed` state from recent ingestion jobs.

Bulk deletion removes both raw uploads and their knowledge-base copies, then sends one request through the same FIFO synchronization path so obsolete vectors are removed without competing ingestion jobs.

### Admin Analytics Flow

1. An administrator opens `/admin` (or is redirected there from `/dashboard`) and signs in with Cognito `USER_PASSWORD_AUTH`.
2. The frontend stores Cognito tokens in tab-scoped `sessionStorage` and sends the ID token in the `Authorization` header.
3. API Gateway validates the token with a Cognito authorizer.
4. The dashboard Lambda independently verifies that `cognito:groups` contains `admin`.
5. The Lambda reads DynamoDB and S3 to return summary metrics, time-series usage, frequently asked questions, confidence distribution, escalations, feedback, session transcripts, and document state.

## AWS Components

| Component | Implementation | Responsibility |
| --- | --- | --- |
| Frontend hosting | `FrontendHosting` CDK construct | One private S3 origin and CloudFront distribution for `/`, `/admin`, and `/dashboard`, with route rewriting and security headers |
| Public API | `ApiGateway` CDK construct | Public chat, history, and feedback routes; 100 requests/second with burst 200 |
| Chat handler | `GCC-ChatHandler` Lambda | Validation, Bedrock orchestration, confidence, escalation, persistence |
| Dashboard API | `DashboardApi` CDK construct | Cognito-protected analytics and document routes; 50 requests/second with burst 100 |
| Dashboard handler | `GCC-AdminDashboard` Lambda | Metrics aggregation, session review, and presigned document operations |
| Document processor | Standard + FIFO SQS-triggered Python Lambda | Bounded validation/copy workers, quarantine, serialized Bedrock ingestion, and processing analytics |
| Escalation router | `GCC-EscalationRouter` Lambda with SQS DLQ | SNS notification, high-severity SES email, and escalation analytics |
| Chat archive | DynamoDB Stream Lambda + object-locked S3 | Append-only audit copy for retention and future Athena/Glue use |
| Observability | CloudWatch dashboard and alarms | Lambda health, ingestion backlog, and all application DLQs |
| Knowledge Base | Amazon Bedrock Knowledge Base | Retrieval-augmented generation over approved documents |
| Vector store | Amazon S3 Vectors | Cosine-similarity index with 1024-dimensional float vectors |
| Content storage | Private S3 buckets | Versioned raw uploads, Bedrock data-source copies, static sites, and immutable audit records |
| Operational data | Three DynamoDB tables | Chat turns/feedback, analytics events, and short-lived document-batch coordination |
| Authentication | Cognito User Pool | Dashboard authentication and admin group claims |
| AI controls | Bedrock Prompt Management + Guardrails | Immutable prompt version and response-generation safety policies |

## Data Model

### Chat Logs

Table name: `${RESOURCE_PREFIX}GCC-ChatLogs`

- Partition key: `sessionId` (string)
- Sort key: `timestamp` (ISO-8601 string)
- GSI: `userId-index` on `userId` and `timestamp`
- Billing: on demand
- Recovery: point-in-time recovery enabled
- Removal policy: retain

Each item can include `question`, `answer`, `sources`, `confidence`, `chunkScores`, `escalated`, `feedback`, `language`, `userId`, `sessionTokenHash`, and timestamps.

### Analytics Logs

Table name: `${RESOURCE_PREFIX}GCC-AnalyticsLogs`

- Partition key: `eventType` (string)
- Sort key: `timestamp` (ISO-8601 string)
- Billing: on demand
- Recovery: point-in-time recovery enabled
- Removal policy: retain

Current event types are `escalation` and `document_processing`.

### Document Upload Batches

Table name: `${RESOURCE_PREFIX}GCC-DocumentBatches`

- Partition key: `batchId` (32-character server-generated identifier)
- Contents: expected S3 keys, idempotent processed/accepted tokens, batch state, and ingestion job ID
- Billing: on demand
- Recovery: point-in-time recovery enabled
- Retention: DynamoDB TTL removes coordination state after seven days
- Removal policy: destroy because the records are temporary workflow state, not source documents

### Object Storage

- `${RESOURCE_PREFIX}gcc-document-store-<ACCOUNT_ID>`: versioned source uploads under `uploads/` and rejected files under a seven-day `quarantine/` lifecycle; retained when the stack is destroyed.
- `${RESOURCE_PREFIX}gcc-knowledge-base-data-<ACCOUNT_ID>`: Bedrock source documents under `documents/`; retained when the stack is destroyed.
- `${RESOURCE_PREFIX}gcc-chat-audit-archive-<ACCOUNT_ID>`: versioned audit JSON with a one-year S3 Object Lock retention period.
- CloudFront site bucket: generated name, auto-deleted with the stack because it contains only rebuildable static output.

The account ID suffix is resolved automatically by CloudFormation. It prevents
globally unique S3 names from colliding when separate customer sandboxes deploy
the same unprefixed stack.

## Infrastructure As Code

The `GrandCanyonCouncilChatbot` CDK stack composes these constructs:

```text
backend/lib/
  backend-stack.ts
  config/environment.ts
  constructs/
    api-gateway.ts
    ai-safety.ts
    chat-archive.ts
    chat-handler.ts
    dashboard-api.ts
    doc-processor.ts
    escalation-router.ts
    frontend-hosting.ts
    knowledge-base.ts
    observability.ts
    python-dependencies.ts
    shared-resources.ts
```

`RESOURCE_PREFIX` is read during CDK synthesis. It prefixes named tables, buckets, Lambda functions, queues, roles, secrets, topics, the knowledge base, and data source so multiple environments can coexist. The CloudFormation stack name remains `GrandCanyonCouncilChatbot`.

`cdk-nag` AWS Solutions checks run during synthesis. Explicit suppressions in `backend-stack.ts` document pilot-phase tradeoffs such as deferred WAF, access logging, and Cognito MFA.

## Security Model

### Implemented Controls

- CloudFront redirects HTTP to HTTPS and enforces TLS 1.2 (2021 policy).
- Frontend, document, knowledge-base, and audit buckets block public access and enforce SSL.
- CloudFront uses origin access control to read the private site bucket.
- Public and admin assets share one CloudFront distribution; both APIs and the upload bucket allow only that generated browser origin through CORS.
- Dashboard routes require a Cognito token and membership in the `admin` group.
- The dashboard Lambda repeats the group check rather than trusting only the gateway.
- IAM grants are scoped to the application tables, buckets, secret, and Lambda where resource ARNs are available.
- Upload and delete paths are validated against `uploads/`; traversal, ambiguous segments, duplicates, and control characters are rejected.
- Presigned uploads/downloads expire after five minutes. Upload policies bind the exact object key, extension-compatible MIME type, byte size, and server-created batch ID; downloads are forced to attachments.
- The document worker verifies stored metadata, byte limits, file signatures, UTF-8 text, and Office container structure before an object can enter the knowledge-base bucket. The allow-list is restricted to CSV, PDF, TXT, DOCX, and XLSX formats supported by the configured default parser.
- Existing public sessions require a high-entropy bearer credential for continuation, history, and feedback.
- Bedrock Guardrails evaluates response generation, and the production prompt is an immutable Prompt Management version.
- Chat inserts stream to an object-locked S3 audit archive.
- Lambda log groups retain logs for one month.
- Document copies are buffered with bounded concurrency, while a FIFO queue permits only one Bedrock ingestion start at a time. Both paths use encrypted dead-letter queues.
- CloudWatch alarms notify the staff topic when a DLQ receives a message.
- Source buckets and DynamoDB data are encrypted at rest with AWS-managed encryption; DynamoDB point-in-time recovery is enabled.

### Pilot Limitations

- Public chat does not require a named user account; anonymous bearer tokens remain browser-managed credentials.
- WAF, API/CloudFront access logging, CloudFront geo restrictions, Cognito MFA, and advanced Cognito security are not enabled.
- A static SPA cannot use HttpOnly admin-session cookies without adding a backend-for-frontend; the pilot uses tab-scoped storage.
- SNS encryption is deferred for the pilot.
- SES delivery requires the configured sender/recipient identity to be verified.

These limitations are intentional pilot tradeoffs, not production security recommendations.

## Scalability And Performance

- API Gateway, Lambda, S3, DynamoDB on-demand, CloudFront, and Bedrock are managed services that scale without fixed application servers.
- CloudFront caches the static frontend at edge locations.
- Generation uses one retrieval, avoiding duplicate vector searches and guaranteeing that answer context, confidence, and sources agree.
- S3 Vectors has no always-on search cluster and is better aligned with intermittent nonprofit usage.
- Lambda cold starts and Bedrock generation remain the primary latency contributors.
- Dashboard endpoints currently scan up to 90 days of chat records for several aggregates. This is acceptable for pilot volume but should move to incremental aggregates or indexed queries as data grows.
- API Gateway throttles limit sudden load, but there is no per-user public-chat quota.

## Architectural Decisions

### Static Next.js Export On S3 And CloudFront

**Decision:** Use `output: "export"` and publish the complete application to one private S3 origin behind one CloudFront distribution. Serve chat at `/`, admin sign-in at `/admin`, and authenticated pages below `/dashboard`.

**Rationale:** The application does not require server-side rendering, and one origin matches the intended customer URL structure. The generated CloudFront domain remains the only allowed CORS origin; Cognito authorization and the Lambda's independent `admin` group check protect administrative data and actions.

**Tradeoff:** Every `NEXT_PUBLIC_*` setting is baked in at build time, nested routes require explicit CloudFront rewriting, and static admin assets are publicly retrievable even though protected admin data and operations are not. Hiding the static shell itself would require edge authentication or a server-rendered backend-for-frontend.

### Separate Public And Admin APIs

**Decision:** Use one unauthenticated API for chat and one Cognito-protected API for administration.

**Rationale:** Public access is important for volunteers, while analytics and document operations need stronger authorization and lower throttles.

**Tradeoff:** The frontend manages two base URLs and the infrastructure contains two API Gateway deployments.

### S3 Vectors Instead Of OpenSearch Serverless

**Decision:** Store knowledge-base vectors in S3 Vectors using Titan Text Embeddings v2.

**Rationale:** It avoids the minimum always-on cost of an OpenSearch Serverless collection and suits low-to-moderate, intermittent pilot traffic.

**Tradeoff:** S3 Vectors has service-specific metadata constraints. Bedrock text and metadata fields are configured as non-filterable so chunks fit within the vector metadata limits.

### Bedrock-Native Parsing And Semantic Chunking

**Decision:** Copy source documents into an S3 data source and let Bedrock parse and semantically chunk them at up to 800 tokens.

**Rationale:** This removes custom parsing infrastructure and preserves coherent context better than whole-document or fixed-size chunks.

**Tradeoff:** Ingestion jobs operate on the data source, so per-document dashboard status is derived heuristically from job timestamps.

### Explicit Bilingual Contract

**Decision:** Send `en` or `es` on every chat request and instruct the model to generate directly in that language.

**Rationale:** A shared explicit state keeps the public UI, admin UI, stored history, and response language aligned without introducing separate translation services.

**Tradeoff:** Every new interface string must be maintained in both translation dictionaries, and model compliance still needs regression testing.

## Operational Observability

- Lambda execution logs are available in CloudWatch for all handlers.
- DynamoDB stores response confidence, chunk score samples, feedback, and escalation state for dashboard review.
- Failed document copy, document sync, escalation, and audit-archive events are retained in encrypted SQS dead-letter queues for 14 days.
- Bedrock ingestion jobs provide the source of document readiness status.
- A CloudWatch operations dashboard tracks Lambda errors/throttles/duration, ingestion backlog, and DLQ depth. Every application DLQ has an SNS-backed alarm.

The pilot does not yet include distributed tracing or API/CloudFront access logs.

## Related Documentation

- [API Documentation](./APIDoc.md)
- [Development Guide](./developmentGuide.md)
- [Modification Guide](./modificationGuide.md)
- [Deployment Guide](./deploymentGuide.md)
- [User Guide](./userGuide.md)
