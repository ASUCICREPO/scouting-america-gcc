# Development Guide

This guide covers local setup, repository structure, testing, and the normal contribution workflow for GCC Chat. It does not authorize a deployment; use the separate [Deployment Guide](./deploymentGuide.md) only after review and approval.

## Technology Baseline

| Area | Technology |
| --- | --- |
| Frontend | Next.js 16, React 19, TypeScript, App Router, static export |
| UI | CSS, Lucide React, React Markdown, Sonner |
| Backend infrastructure | AWS CDK v2 in TypeScript |
| Runtime handlers | Python 3.13 with runtime-provided boto3 |
| AI | Amazon Bedrock Knowledge Base, Claude Haiku 4.5, Titan Text Embeddings v2 |
| Persistence | Amazon S3, S3 Vectors, DynamoDB, S3 Object Lock |
| Authentication | Amazon Cognito User Pool |
| Testing | Jest/CDK assertions, Python unittest, ESLint, Next.js build |

## Prerequisites

- Git
- Node.js 20 or newer
- npm 9 or newer
- Python 3.13 and boto3 for Lambda contract tests
- Graphviz `dot` only when editing the architecture diagram
- AWS CLI v2 and valid credentials only for CDK lookup, deployment, or live service testing

Verify the local toolchain:

```bash
node --version
npm --version
python3 --version
aws --version
```

## Clone And Install

```bash
git clone git@github.com:ASUCICREPO/scouting-america-gcc.git
cd scouting-america-gcc
```

Install frontend and backend dependencies independently:

```bash
cd frontend
npm ci
cd ../backend
npm ci
```

Use `npm install` only when intentionally changing dependencies. Commit the matching package lock from the affected package.

## Repository Structure

```text
backend/
  bin/backend.ts                    CDK application entry
  lib/backend-stack.ts              Top-level stack composition and outputs
  lib/config/environment.ts         Prefix-aware names, models, thresholds
  lib/constructs/                   Service-focused CDK constructs
  lambda/chat-handler/index.py      Chat, history, feedback, Bedrock orchestration
  lambda/dashboard/index.py         Admin metrics and document API
  lambda/doc-processor/index.py     S3 event to KB ingestion
  lambda/escalation-router/index.py Safety/low-confidence notification routing
  test/backend.test.ts              CDK regression assertions
  test/test_chat_language.py        Bilingual Lambda contract tests
frontend/
  app/page.tsx                      Public chat state and orchestration
  app/admin/page.tsx                Cognito admin sign-in
  app/dashboard/                    Overview, documents, settings
  components/                       Chat and shared UI components
  context/LanguageContext.tsx       Shared persistent language state
  lib/api.ts                        Public chat API client
  lib/dashboard/                    Admin auth, API, settings, upload utilities
  lib/i18n.ts                       English and Spanish copy
  next.config.ts                    Static-export configuration
docs/                               Maintainer and handoff documentation
deploy.sh                           Approved one-step deployment workflow
```

## Frontend Configuration

The browser API settings are build-time variables. Create `frontend/.env.local` for local development against an existing approved backend:

```dotenv
NEXT_PUBLIC_API_URL=https://chat-api-id.execute-api.us-west-2.amazonaws.com/prod
NEXT_PUBLIC_DASHBOARD_API_URL=https://dashboard-api-id.execute-api.us-west-2.amazonaws.com/prod
NEXT_PUBLIC_USER_POOL_ID=us-west-2_example
NEXT_PUBLIC_CLIENT_ID=exampleclientid
NEXT_PUBLIC_AWS_REGION=us-west-2
```

Do not commit `.env.local`. `deploy.sh` regenerates it from CloudFormation outputs during an authorized deployment.

Without a valid public API URL, the page can render but chat requests will fail. Dashboard sign-in and data loading require the API, Cognito, and region values.

## Run Locally

```bash
cd frontend
npm run dev
```

Open `http://localhost:3000`. Useful routes are:

- `http://localhost:3000/`
- `http://localhost:3000/admin`
- `http://localhost:3000/dashboard`
- `http://localhost:3000/dashboard/documents`
- `http://localhost:3000/dashboard/settings`

The dashboard still talks to the deployed Cognito User Pool and dashboard API configured in `.env.local`.

## Branch And Review Workflow

1. Update local `main` without rewriting history.
2. Create a focused branch such as `feat/...`, `fix/...`, or `docs/...`.
3. Make scoped changes and run the checks appropriate to the affected layer.
4. Review `git diff` for generated output, secrets, environment files, and unrelated changes.
5. Commit coherent units of work.
6. Push the branch and open a pull request into `main`.
7. Do not deploy from an unreviewed branch unless the environment owner explicitly authorizes it.

Example:

```bash
git switch main
git pull --ff-only
git switch -c fix/descriptive-name
```

The repository can contain local generated or ingestion files. Stage explicit paths instead of `git add .`.

## Development Conventions

### Frontend

- Keep browser-only components marked with `"use client"`.
- Reuse `LanguageContext` for language state; do not create a second independent toggle.
- Add every visible user string to both language dictionaries in `frontend/lib/i18n.ts`.
- Reuse the dashboard API wrapper so Cognito ID tokens and unauthorized redirects remain consistent.
- Preserve the static-export constraint: no runtime server routes, server actions, or image optimization that requires a Next.js server.
- Use existing CSS variables and dashboard/chat styles before introducing a new design system.
- Preserve keyboard focus styles, accessible names, responsive sizing, and reduced-motion behavior.

### Backend

- Keep infrastructure in focused constructs under `backend/lib/constructs/`.
- Keep Lambda request validation in the handler even when API Gateway also validates authentication.
- Use environment variables to pass resource identifiers into Lambdas.
- Scope IAM permissions to known resources. Document unavoidable wildcards.
- Use `Decimal` for floating-point values written through boto3 to DynamoDB.
- Preserve ISO-8601 UTC timestamps because they are sort keys and dashboard grouping inputs.
- Consider asynchronous failure handling and log retention for new event-driven Lambdas.

### Documentation

- Update `APIDoc.md` when a route, parameter, response, auth requirement, or throttle changes.
- Update `architectureDeepDive.md` and `architecture.dot` when services or data flows change.
- Regenerate `architecture.png` after editing its DOT source.
- Keep commands prefix-aware and avoid embedding environment-specific IDs, account numbers, tokens, or URLs.

## Test Matrix

### Frontend Lint And Build

```bash
cd frontend
npm run lint
npm run build
```

The production build must complete as a static export and create `frontend/out/` with nested route directories.

### CDK Tests And Synthesis

```bash
cd backend
npm test
npx cdk synth
```

Synthesis also runs `cdk-nag`. Review any new finding; do not add a suppression without a concrete reason and documented alternative.

### Python Lambda Tests

The Lambda runtime includes boto3, but a local Python installation usually does not. Use an isolated environment outside the repository:

```bash
cd backend
python3.13 -m venv /tmp/gcc-python-tests
source /tmp/gcc-python-tests/bin/activate
python -m pip install boto3
python -m unittest discover -s test -p 'test_*.py'
```

The bilingual tests mock AWS clients and verify Spanish prompt enforcement, unsupported-language rejection, and language persistence.

### Prefix Regression Check

To confirm generated names without deploying:

```bash
cd backend
RESOURCE_PREFIX=dev npx cdk synth >/tmp/gcc-template.yaml
```

Inspect the synthesized template for `dev-` resource names. Use a lowercase prefix containing only numbers and internal hyphens, at most 39 characters.

### Manual Browser Checks

For changes affecting the UI, verify desktop and mobile widths:

- Public chat starts, follows up, gives feedback, and reloads history.
- Settings applies dark mode, text size, and English/Spanish copy.
- A language change during an active chat requires confirmation and resets the session.
- `/admin` authenticates an admin and rejects a non-admin.
- Dashboard overview loads real metrics and opens rated conversations.
- Document upload reports progress and reaches a valid ingestion state.
- Nested URLs survive a direct browser refresh in the deployed CloudFront environment.

## Working With AWS Safely

Reading CDK output or calling `cdk synth` is different from changing a deployed environment. Commands that can create, update, upload, invalidate, or delete resources include:

- `./deploy.sh`
- `npx cdk deploy`
- `npx cdk destroy`
- `aws s3 sync`, `cp`, or `rm` against application buckets
- Cognito admin-user commands
- CloudFront invalidations
- Bedrock ingestion starts

Run those only against the intended account, region, stack, and resource prefix, and only after authorization.

Check identity before live operations:

```bash
aws sts get-caller-identity
aws configure get region
```

## Debugging

### Frontend Cannot Reach An API

1. Check `frontend/.env.local` for trailing or incorrect URLs.
2. Restart `npm run dev` after changing environment variables.
3. Inspect the browser Network panel for status and CORS headers.
4. Confirm whether the route belongs to the public or dashboard API.

### Dashboard Returns 401 Or 403

- `401` means the gateway/Lambda has no valid claims.
- `403` means the token is valid but lacks the `admin` group.
- Clear `gcc_admin_tokens`, sign in again, and verify the configured User Pool.

### CDK Synthesis Fails

- Run `npm ci` in `backend/`.
- Confirm the Node.js version.
- Check whether `RESOURCE_PREFIX` contains invalid characters.
- Review the first CDK or cdk-nag error rather than only the final stack trace.

### Python Test Cannot Import boto3

Create the isolated environment shown under **Python Lambda Tests** and install boto3 into it. The included test module then sets `AWS_EC2_METADATA_DISABLED=true` and mocks boto3 clients before importing the handler, so it does not call live AWS services.

## Pull Request Checklist

- [ ] Changes are on a non-main branch.
- [ ] No credentials, tokens, `.env.local`, deployment output, or ingestion data are staged.
- [ ] Frontend lint/build passed when frontend code changed.
- [ ] Jest/CDK synth passed when infrastructure changed.
- [ ] Python tests passed when Lambda code changed.
- [ ] English and Spanish copy are both updated for visible UI changes.
- [ ] API and architecture docs match contract changes.
- [ ] The PR describes whether deployment is required, but does not deploy without approval.

## Related Documentation

- [Modification Guide](./modificationGuide.md)
- [Deployment Guide](./deploymentGuide.md)
- [API Documentation](./APIDoc.md)
- [Architecture Deep Dive](./architectureDeepDive.md)
