# Architecture Deep Dive

This document describes the deployed architecture of Grand Canyon Council Scout AI. It reflects the CDK constructs and Lambda handlers in this repository as of July 15, 2026.

## Architecture Diagram

![Grand Canyon Council Scout AI AWS architecture](./media/architecture.png)

The editable Graphviz source is [architecture.dot](./media/architecture.dot). Regenerate the image with:

```bash
dot -Tpng -Gdpi=160 docs/media/architecture.dot -o docs/media/architecture.png
```

## System Boundaries

Scout AI has two browser-facing experiences in one Next.js application:

- **Public chat** at `/`, available without authentication.
- **Admin dashboard** at `/dashboard`, protected by Amazon Cognito and an `admin` group check.

The frontend is a static export. Application state that does not require the backend, including display preferences and the local list of chat sessions, is stored in browser `localStorage`. Chat turns, feedback, confidence values, and escalation state are stored server-side in DynamoDB.

## Request Flows

### Public Chat Flow

1. The browser downloads the static Next.js application through CloudFront. A CloudFront Function rewrites extensionless paths such as `/dashboard` to the corresponding exported `index.html` file.
2. The frontend sends `POST /chat` to the public API Gateway with `question`, optional `sessionId`, and `language` (`en` or `es`).
3. API Gateway invokes the Python 3.13 chat-handler Lambda.
4. The Lambda validates the request, reads the system guardrails from Secrets Manager, and starts two Bedrock calls in parallel:
   - `RetrieveAndGenerate` produces the grounded response and citations.
   - `Retrieve` returns up to five relevance scores for confidence reporting.
5. The Bedrock Knowledge Base retrieves semantically relevant chunks from S3 Vectors. Titan Text Embeddings v2 produces 1024-dimensional embeddings, and Claude Haiku 4.5 generates the response.
6. The Lambda averages the returned retrieval scores. A missing score set falls back to confidence `0.3`.
7. Safety keywords or confidence below `0.7` trigger the escalation-router Lambda asynchronously.
8. The turn is written to the chat-log DynamoDB table and returned to the browser with a session ID, message ID, sources, confidence, escalation flag, and language.
9. A thumbs-up or thumbs-down action calls `POST /chat/feedback`, which updates that exact turn using its timestamp-based message ID.

### Bilingual Flow

The shared frontend `LanguageContext` owns English/Spanish state for the chatbot, login screen, and dashboard. The selected language is persisted under `gcc_language` and synchronized with legacy chat and dashboard settings keys.

For chat generation, the browser sends the explicit language code on every request. The Lambda rejects unsupported values and adds a language requirement to the Bedrock prompt. The chosen language is returned by the API and persisted with the chat turn. Loading saved history restores the language recorded for that conversation.

The interface does not perform machine translation at render time. English and Spanish interface strings are maintained in `frontend/lib/i18n.ts`, while the model generates the answer directly in the requested language.

### Document Ingestion Flow

1. An authenticated administrator requests a presigned upload URL from `POST /dashboard/documents/upload`.
2. The browser uploads the file directly to the document-store bucket under `uploads/`. Folder paths are preserved after sanitization.
3. An S3 `ObjectCreated` event invokes the document-processor Lambda.
4. The Lambda copies the object to `documents/` in the knowledge-base data bucket.
5. The Lambda starts a Bedrock Knowledge Base ingestion job and records a `document_processing` event in the analytics table.
6. Bedrock parses the document, applies semantic chunking (maximum 800 tokens), creates Titan embeddings, and stores vectors in the S3 Vectors index.
7. The dashboard derives each document's `ready`, `indexing`, `pending`, or `failed` state from recent ingestion jobs.

Deleting a document removes both the raw upload and its knowledge-base copy, then starts another ingestion job so obsolete vectors are removed.

### Admin Analytics Flow

1. An administrator signs in through the frontend with Cognito `USER_PASSWORD_AUTH`.
2. The frontend stores Cognito tokens in browser storage and sends the ID token in the `Authorization` header.
3. API Gateway validates the token with a Cognito authorizer.
4. The dashboard Lambda independently verifies that `cognito:groups` contains `admin`.
5. The Lambda reads DynamoDB and S3 to return summary metrics, time-series usage, frequently asked questions, confidence distribution, escalations, feedback, session transcripts, and document state.

## AWS Components

| Component | Implementation | Responsibility |
| --- | --- | --- |
| Frontend hosting | `FrontendHosting` CDK construct | Private S3 origin, CloudFront HTTPS delivery, route rewriting, SPA fallback |
| Public API | `ApiGateway` CDK construct | Public chat, history, and feedback routes; 100 requests/second with burst 200 |
| Chat handler | `GCC-ChatHandler` Lambda | Validation, Bedrock orchestration, confidence, escalation, persistence |
| Dashboard API | `DashboardApi` CDK construct | Cognito-protected analytics and document routes; 50 requests/second with burst 100 |
| Dashboard handler | `GCC-AdminDashboard` Lambda | Metrics aggregation, session review, and presigned document operations |
| Document processor | Python Lambda with SQS DLQ | S3 copy, Bedrock ingestion, and processing analytics |
| Escalation router | `GCC-EscalationRouter` Lambda with SQS DLQ | SNS notification, high-severity SES email, and escalation analytics |
| Knowledge Base | Amazon Bedrock Knowledge Base | Retrieval-augmented generation over approved documents |
| Vector store | Amazon S3 Vectors | Cosine-similarity index with 1024-dimensional float vectors |
| Content storage | Two private S3 buckets | Versioned raw uploads and Bedrock data-source copies |
| Operational data | Two DynamoDB tables | Chat turns/feedback and analytics events |
| Authentication | Cognito User Pool | Dashboard authentication and admin group claims |
| Configuration | Secrets Manager | Runtime system prompt/guardrail configuration |

## Data Model

### Chat Logs

Table name: `${RESOURCE_PREFIX}GCC-ChatLogs`

- Partition key: `sessionId` (string)
- Sort key: `timestamp` (ISO-8601 string)
- GSI: `userId-index` on `userId` and `timestamp`
- Billing: on demand
- Recovery: point-in-time recovery enabled
- Removal policy: retain

Each item can include `question`, `answer`, `sources`, `confidence`, `chunkScores`, `escalated`, `feedback`, `language`, `userId`, and timestamps.

### Analytics Logs

Table name: `${RESOURCE_PREFIX}GCC-AnalyticsLogs`

- Partition key: `eventType` (string)
- Sort key: `timestamp` (ISO-8601 string)
- Billing: on demand
- Recovery: point-in-time recovery enabled
- Removal policy: retain

Current event types are `escalation` and `document_processing`.

### Object Storage

- `${RESOURCE_PREFIX}gcc-document-store`: versioned source uploads under `uploads/`; retained when the stack is destroyed.
- `${RESOURCE_PREFIX}gcc-knowledge-base-data`: Bedrock source documents under `documents/`; retained when the stack is destroyed.
- CloudFront site bucket: generated name, auto-deleted with the stack because it contains only rebuildable static output.

## Infrastructure As Code

The `ScoutingAmericaChatbot` CDK stack composes these constructs:

```text
backend/lib/
  backend-stack.ts
  config/environment.ts
  constructs/
    api-gateway.ts
    chat-handler.ts
    dashboard-api.ts
    doc-processor.ts
    escalation-router.ts
    frontend-hosting.ts
    knowledge-base.ts
    shared-resources.ts
```

`RESOURCE_PREFIX` is read during CDK synthesis. It prefixes named tables, buckets, Lambda functions, queues, roles, secrets, topics, the knowledge base, and data source so multiple environments can coexist. The CloudFormation stack name remains `ScoutingAmericaChatbot`.

`cdk-nag` AWS Solutions checks run during synthesis. Explicit suppressions in `backend-stack.ts` document pilot-phase tradeoffs such as deferred WAF, access logging, and Cognito MFA.

## Security Model

### Implemented Controls

- CloudFront redirects HTTP to HTTPS and enforces TLS 1.2 (2021 policy).
- Frontend, document, and knowledge-base buckets block public access and enforce SSL.
- CloudFront uses origin access control to read the private site bucket.
- Dashboard routes require a Cognito token and membership in the `admin` group.
- The dashboard Lambda repeats the group check rather than trusting only the gateway.
- IAM grants are scoped to the application tables, buckets, secret, and Lambda where resource ARNs are available.
- Upload and delete paths are validated against `uploads/`; traversal and control characters are rejected.
- Presigned upload/download URLs expire after five minutes.
- Lambda log groups retain logs for one month.
- Document processing and escalation use encrypted dead-letter queues.
- Source buckets and DynamoDB data are encrypted at rest with AWS-managed encryption; DynamoDB point-in-time recovery is enabled.

### Pilot Limitations

- Public chat, history, and feedback routes do not require authentication. Anyone who knows a session ID can call its history endpoint.
- API Gateway and upload-bucket CORS default to all origins unless `UPLOAD_ALLOWED_ORIGINS` is set for uploads.
- WAF, API/CloudFront access logging, CloudFront geo restrictions, Cognito MFA, and advanced Cognito security are not enabled.
- The frontend stores admin JWTs in `localStorage`; a production hardening phase should evaluate an HttpOnly cookie or managed hosted-UI flow.
- SNS encryption and Secrets Manager rotation are deferred for the pilot.
- SES delivery requires the configured sender/recipient identity to be verified.

These limitations are intentional pilot tradeoffs, not production security recommendations.

## Scalability And Performance

- API Gateway, Lambda, S3, DynamoDB on-demand, CloudFront, and Bedrock are managed services that scale without fixed application servers.
- CloudFront caches the static frontend at edge locations.
- Generation and confidence retrieval execute concurrently to avoid two sequential Bedrock round trips.
- S3 Vectors has no always-on search cluster and is better aligned with intermittent nonprofit usage.
- Lambda cold starts and Bedrock generation remain the primary latency contributors.
- Dashboard endpoints currently scan up to 90 days of chat records for several aggregates. This is acceptable for pilot volume but should move to incremental aggregates or indexed queries as data grows.
- API Gateway throttles limit sudden load, but there is no per-user public-chat quota.

## Architectural Decisions

### Static Next.js Export On S3 And CloudFront

**Decision:** Use `output: "export"` and publish `frontend/out` to a private S3 origin behind CloudFront.

**Rationale:** The application does not require server-side rendering. Static hosting reduces operational overhead and keeps the chat and dashboard in one frontend deployment.

**Tradeoff:** Every `NEXT_PUBLIC_*` setting is baked in at build time, and nested routes require explicit CloudFront rewriting.

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

- Lambda execution logs are available in CloudWatch for all four handlers.
- DynamoDB stores response confidence, chunk score samples, feedback, and escalation state for dashboard review.
- Failed asynchronous document and escalation events are retained in their SQS dead-letter queues for 14 days.
- Bedrock ingestion jobs provide the source of document readiness status.

The pilot does not yet include centralized alarms, dashboards, distributed tracing, or API/CloudFront access logs.

## Related Documentation

- [API Documentation](./APIDoc.md)
- [Development Guide](./developmentGuide.md)
- [Modification Guide](./modificationGuide.md)
- [Deployment Guide](./deploymentGuide.md)
- [User Guide](./userGuide.md)
