# Project Modification Guide

This guide explains where and how to extend GCC Chat while preserving its public-chat, bilingual, admin, security, and deployment contracts.

Start with the [Development Guide](./developmentGuide.md) for setup and tests. Review the [Architecture Deep Dive](./architectureDeepDive.md) before changing service boundaries.

## Change Map

| Change | Primary files |
| --- | --- |
| Public chat layout or behavior | `frontend/app/page.tsx`, `frontend/components/`, `frontend/app/globals.css` |
| Dashboard layout or behavior | `frontend/app/dashboard/`, `frontend/app/dashboard/dashboard.css` |
| English/Spanish interface text | `frontend/lib/i18n.ts`, `frontend/context/LanguageContext.tsx` |
| Public API client | `frontend/lib/api.ts` |
| Admin API client/auth | `frontend/lib/dashboard/api.ts`, `frontend/lib/dashboard/auth.ts` |
| Chat prompt, validation, confidence | `backend/lambda/chat-handler/index.py` |
| Dashboard metrics/documents | `backend/lambda/dashboard/index.py` |
| Document ingestion | `backend/lambda/doc-processor/index.py` |
| Escalation behavior | `backend/lambda/escalation-router/index.py` |
| Models, thresholds, resource names | `backend/lib/config/environment.ts` |
| AWS resources and permissions | `backend/lib/constructs/`, `backend/lib/backend-stack.ts` |

## Frontend Modifications

### Add Or Change A Chat Component

The public page owns conversation state in `frontend/app/page.tsx`. Presentational and focused interaction components live in `frontend/components/`.

When adding a component:

1. Keep API calls and session orchestration in the page or existing API module.
2. Pass translated copy or use `useLanguage()` inside a client component.
3. Add both desktop and mobile styles to `frontend/app/globals.css` using existing variables.
4. Include accessible names, keyboard behavior, and focus-visible states.
5. Verify that loading, empty, error, and long-content states do not shift or overlap the layout.

Assistant content must continue through `MarkdownContent` so headings, lists, links, and emphasis render consistently in both the chatbot and dashboard transcript modal.

### Add A Page

Create an App Router directory under `frontend/app/`:

```text
frontend/app/example/page.tsx
```

Because production uses `output: "export"`, the page must be statically exportable. Do not depend on server actions, request-time headers, route handlers, dynamic image optimization, or server-side secrets.

CloudFront rewrites extensionless URLs to each route's exported `index.html`. The existing function handles static routes automatically after the new page is present in `frontend/out/`.

### Modify Theme Or Text Size

- Public chat variables and component styles: `frontend/app/globals.css`
- Dashboard variables and styles: `frontend/app/dashboard/dashboard.css`
- Public settings state: `frontend/components/SettingsView.tsx`
- Dashboard settings state: `frontend/lib/dashboard/settings-context.tsx`

Do not hardcode a color in one component without verifying light and dark modes. Public chat uses pixel text sizes; the dashboard maps small/medium/large settings to its own CSS variables.

### Add A Language Or Translation Key

English and Spanish support is centralized in `frontend/lib/i18n.ts`.

To add a visible string:

1. Add the same key and compatible interpolation fields to `english` and `spanish`.
2. Read it through `const { t } = useLanguage()`.
3. Avoid maintaining a second local translation object.
4. Test both languages, including long labels, modals, document tables, and mobile widths.

To add a third language, the change is cross-stack rather than a dictionary-only edit:

1. Extend the `Language` type and translations.
2. Update `SUPPORTED_LANGUAGES` and prompt selection in the chat Lambda.
3. Update settings controls, language confirmation, saved-session types, API types, and admin settings mappings.
4. Add Lambda tests for prompt enforcement, validation, response echoing, and DynamoDB persistence.
5. Update API and user documentation.

### Modify Shared Language State

`frontend/context/LanguageContext.tsx` synchronizes:

- `gcc_language`
- `chat_settings.language`
- `gcc_admin_app_settings.language`
- the document `<html lang>` attribute

All public, login, and dashboard language toggles must call this provider. A standalone state variable would make surfaces drift out of sync.

The public chat intentionally asks for confirmation and clears an active conversation before changing languages. Preserve that behavior unless the backend contract is redesigned to support mixed-language sessions.

### Modify Admin Authentication

`frontend/lib/dashboard/auth.ts` uses Cognito `USER_PASSWORD_AUTH`, decodes the ID token, verifies `admin`, and stores tokens under `gcc_admin_tokens`. `frontend/lib/dashboard/api.ts` adds the ID token to each request and redirects on `401` or `403`.

Any change must stay aligned with:

- User Pool client auth flows in `shared-resources.ts`
- API Gateway Cognito authorizer in `dashboard-api.ts`
- the Lambda's independent `validate_admin` group check

For production hardening, treat a switch from local storage to cookies or a hosted UI as an authentication redesign and threat-model it separately.

## Public Chat API Changes

### Add A Request Field

1. Add the field and type to `frontend/lib/api.ts`.
2. Validate it in `backend/lambda/chat-handler/index.py` before AWS service calls.
3. Add it to DynamoDB only if administrators or history need it.
4. Include it in response/history schemas if the client must restore it.
5. Add positive and negative contract tests.
6. Update [APIDoc.md](./APIDoc.md).

The public endpoint is unauthenticated, so bound strings and collections to control prompt size, cost, and abuse.

### Add A Public Route

1. Add an API Gateway resource in `backend/lib/constructs/api-gateway.ts`.
2. Expose it as a construct property if another construct attaches the integration.
3. Add the method and authorization choice in `chat-handler.ts` or a new focused construct.
4. Route the request explicitly in the Lambda handler.
5. Add CORS only for the methods and headers the browser requires.
6. Add throttling, validation, tests, and documentation.

Public-by-default is not an acceptable assumption. Document why a new route can be unauthenticated.

## Dashboard API Changes

### Add A Metric Endpoint

1. Add the API Gateway resource and method in `backend/lib/constructs/dashboard-api.ts` using `authMethodOptions`.
2. Implement a focused handler in `backend/lambda/dashboard/index.py`.
3. Add the exact path to `ROUTES`.
4. Query existing indexes where possible; avoid adding another large table scan for every page load.
5. Add a typed wrapper in `frontend/lib/dashboard/api.ts`.
6. Add loading, error, and empty UI states.
7. Document the response and query parameters.

Every dashboard endpoint must keep both Cognito authorization layers.

### Change Document Types Or Limits

Update both:

- Backend `ALLOWED_FILE_TYPES`, size limits, and batch limit in `backend/lambda/dashboard/index.py`
- Worker `ALLOWED_FILE_TYPES` and signature/container validators in `backend/lambda/doc-processor/index.py`
- Frontend validation and user-facing copy in `frontend/lib/dashboard/upload-utils.ts` and `frontend/lib/i18n.ts`

The dashboard manifest is validated before signing, every presigned POST binds the declared byte size, and the worker independently validates the stored object before copying. Supported files currently cap at 50 MB, matching the Bedrock source-document limit. The allow-list intentionally follows the formats handled by the configured default Bedrock parser; adding image or presentation formats also requires an appropriate parser configuration. Update all three layers together.

### Change Folder Handling

`sanitize_relative_path` preserves valid folder structure and rejects traversal markers, leading separators, empty/ambiguous segments, surrounding whitespace, overlong paths, and control characters. Keep object keys below `uploads/`; the manifest, S3 event, permissions, download validation, and deletion mapping all depend on that prefix.

## AI And Knowledge Base Changes

### Change The Generation Model

Update `CONFIG.MODEL_ID` in `backend/lib/config/environment.ts`.

The chat construct builds an inference-profile ARN from that value. Before changing it:

- Confirm availability in the deployment region.
- Confirm the identifier is an inference profile compatible with the Bedrock `Converse` API.
- Update IAM only if new actions or resource formats are required.
- Re-run representative English, Spanish, safety, formatting, and citation tests.
- Compare latency, groundedness, and cost.

### Change The Embedding Model

Update `CONFIG.EMBEDDING_MODEL_ID` and the vector-index dimension in `backend/lib/constructs/knowledge-base.ts` together. Titan Text Embeddings v2 currently requires 1024 dimensions.

Vector index properties can require replacement. Plan migration and re-ingestion rather than assuming an in-place update.

### Modify The Prompt

The source template is `backend/lambda/chat-handler/templates/chat_prompt.j2`. CDK publishes that template to Bedrock Prompt Management and creates an immutable version; the packaged file is also the runtime fallback. Update the template through code review, deploy a new prompt version, and keep all Jinja variables declared in `ai-safety.ts`.

### Change Confidence Or Escalation Rules

Configuration lives in `backend/lib/config/environment.ts`:

- `CONFIDENCE_THRESHOLD`: current value `0.7`
- `SAFETY_KEYWORDS`: current English and Spanish keyword list

The handler checks the combined question and answer. Safety matches produce high-severity events; low confidence produces medium severity. SNS is used for both, while SES is attempted only for high-severity safety events.

Before adding keywords, test false positives in both languages.

### Change Chunking

Semantic chunking is configured in `knowledge-base.ts`:

- Maximum tokens: 800
- Buffer size: 1
- Breakpoint percentile: 95

The non-filterable S3 Vectors metadata keys are a regression-sensitive requirement. Do not remove `AMAZON_BEDROCK_TEXT` or `AMAZON_BEDROCK_METADATA` from that configuration without validating Bedrock ingestion limits.

## Data Model Changes

### Add A Chat Attribute

DynamoDB is schemaless for non-key attributes. Add the value at write time, then update history, dashboard serialization, TypeScript types, exports, and docs as needed. Provide a default for older rows.

### Change A Key Or Index

Changing `sessionId`, `timestamp`, or a GSI is an infrastructure/data migration. CDK may replace the table while its retain policy leaves the old one. Design the migration, backfill, rollback, and resource-prefix impact before deployment.

### Add A Table

1. Define it in `shared-resources.ts` with encryption, billing, recovery, and retention decisions.
2. Pass the `ITable` reference through construct props.
3. Grant only required read/write actions.
4. Pass the physical name through Lambda environment variables.
5. Add CDK assertions and update architecture/deployment docs.

## Infrastructure Changes

### Add A Lambda

Follow the existing Python construct pattern:

1. Create `backend/lambda/<name>/index.py`.
2. Create or extend a focused CDK construct under `backend/lib/constructs/`.
3. Use Python 3.13, bounded timeout/memory, explicit environment variables, and a one-month log group unless requirements justify otherwise.
4. Grant least-privilege access through referenced resources.
5. Add a DLQ for asynchronous invocation.
6. Wire the construct in `backend-stack.ts` and add outputs only when operators need them.

### Add A Named Resource

Use `PREFIX` or a `CONFIG` value from `environment.ts`. Unprefixed explicit names can collide when `RESOURCE_PREFIX=demo` or another environment is deployed.

S3 names are globally unique and have stricter length/character rules. `deploy.sh` restricts prefixes to lowercase letters, numbers, internal hyphens, and 39 characters.

### Add A cdk-nag Suppression

First determine whether the finding should be fixed. If a pilot constraint genuinely requires suppression, record:

- Decision and scope
- Rationale
- Alternative considered
- Production follow-up

Keep the suppression as narrow as possible.

## Testing Changes

Run the smallest relevant checks during development and the full affected-layer checks before opening a PR:

```bash
cd frontend
npm run lint
npm run build

cd ../backend
npm test
npx cdk synth
python3.13 -m venv /tmp/gcc-python-tests
source /tmp/gcc-python-tests/bin/activate
python -m pip install boto3
python -m unittest discover -s test -p 'test_*.py'
```

Add CDK assertion tests for infrastructure invariants and Python unit tests for validation, prompt contracts, routing, and DynamoDB serialization. For UI changes, test direct route loads, mobile and desktop layouts, both themes, both languages, keyboard navigation, and long translated strings.

## Documentation Checklist

- [ ] `APIDoc.md` reflects route and schema changes.
- [ ] `architectureDeepDive.md` reflects service or data-flow changes.
- [ ] `architecture.dot` and `architecture.png` are updated together.
- [ ] `userGuide.md` reflects user-visible workflow changes.
- [ ] `deploymentGuide.md` includes new variables, permissions, outputs, or migration risks.
- [ ] `projectClosure.md` is updated only for agreed final deliverables or future-scope changes.

## Related Documentation

- [Development Guide](./developmentGuide.md)
- [API Documentation](./APIDoc.md)
- [Architecture Deep Dive](./architectureDeepDive.md)
- [Deployment Guide](./deploymentGuide.md)
