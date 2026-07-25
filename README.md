# Grand Canyon Council Scout AI

Scout AI is a bilingual English/Spanish support assistant for Scouting America's Grand Canyon Council (GCC). It answers volunteer and family questions from approved council documents, records response quality signals, escalates safety or low-confidence conversations, and gives GCC administrators an authenticated analytics and document-management dashboard.

## Architecture

![Grand Canyon Council Scout AI architecture](./docs/media/architecture.png)

The Next.js application is exported into separate private S3/CloudFront public and admin surfaces. Public chat requests use API Gateway, Lambda, Bedrock Guardrails, and an Amazon Bedrock Knowledge Base backed by S3 Vectors. Admin routes use a separate Cognito-protected API and origin. Uploaded documents enter a bounded SQS worker before Bedrock ingestion.

See the [Architecture Deep Dive](./docs/architectureDeepDive.md) for component, data-flow, security, scaling, and architectural-decision details.

## Features

- Public retrieval-augmented chat grounded in one consistent set of GCC and Scouting America source chunks
- English and Spanish interface and response generation
- Markdown answers, citations, voice input, text-to-speech, feedback, and browser-local chat history
- Safety-keyword and low-confidence escalation through SNS and SES
- Cognito-protected admin dashboard with usage, feedback, confidence, and escalation metrics
- Size-enforced multi-file and folder-preserving document upload, download, deletion, and queued ingestion status
- Object-locked chat audit archive plus CloudWatch DLQ alarms and operations dashboard
- Light/dark themes, text-size controls, responsive layouts, and installable PWA behavior
- Prefix-aware AWS deployments so demo and other environments can coexist

## Repository Layout

```text
backend/
  bin/                         CDK application entry point
  lib/                         Stack and reusable CDK constructs
  lambda/                      Python 3.13 Lambda handlers
  test/                        CDK and Lambda contract tests
frontend/
  app/                         Chat, login, and dashboard routes
  components/                  Shared chat and interface components
  context/                     Shared language state
  lib/                         API, auth, settings, and translation modules
  public/                      PWA and GCC visual assets
docs/                          User, development, deployment, API, and architecture guides
deploy.sh                      One-step backend and frontend deployment
buildspec.yml                  AWS CodeBuild backend build/test/deploy workflow
```

## Local Development

Requirements: Node.js 20+, npm, Python 3.13 for Python tests, and AWS credentials when synthesizing or deploying the CDK stack.

```bash
cd frontend
npm ci
npm run dev
```

The frontend requires these build-time values in `frontend/.env.local` to call deployed services:

```dotenv
NEXT_PUBLIC_API_URL=https://example.execute-api.us-east-1.amazonaws.com/prod
NEXT_PUBLIC_DASHBOARD_API_URL=https://example.execute-api.us-east-1.amazonaws.com/prod
NEXT_PUBLIC_USER_POOL_ID=us-east-1_example
NEXT_PUBLIC_CLIENT_ID=exampleclientid
NEXT_PUBLIC_AWS_REGION=us-east-1
```

For backend validation:

```bash
cd backend
npm ci
npm test
npx cdk synth
python3.13 -m venv /tmp/gcc-python-tests
source /tmp/gcc-python-tests/bin/activate
python -m pip install boto3 -r lambda/python-dependencies/requirements.txt
python -m unittest discover -s test -p 'test_*.py'
```

See the [Development Guide](./docs/developmentGuide.md) for the complete workflow.

## Deployment

The deployment script installs dependencies, deploys the `ScoutingAmericaChatbot` CDK stack, writes the frontend environment, builds the static export, publishes isolated public/admin S3 origins, and invalidates both CloudFront distributions.

```bash
RESOURCE_PREFIX=demo ./deploy.sh
```

Always use the same `RESOURCE_PREFIX` when updating an existing prefixed environment. Deployment changes AWS resources and should be run only by an authorized operator after review. See the [Deployment Guide](./docs/deploymentGuide.md) before deploying or removing infrastructure.

## Documentation

| Document | Audience | Purpose |
| --- | --- | --- |
| [User Guide](./docs/userGuide.md) | Volunteers and GCC administrators | Chat, language, accessibility, dashboard, and document workflows |
| [Development Guide](./docs/developmentGuide.md) | Developers | Local setup, tests, branch workflow, and code organization |
| [Modification Guide](./docs/modificationGuide.md) | Maintainers | Safely extend the UI, translations, APIs, model, and data layer |
| [Deployment Guide](./docs/deploymentGuide.md) | Operators | Prefix-aware deployment, verification, troubleshooting, and cleanup |
| [IAM Policies Reference](./docs/iamPolicies.md) | Client cloud administrators and operators | Deployment identity, CDK bootstrap, runtime roles, and pre-deployment checklist |
| [API Documentation](./docs/APIDoc.md) | Integrators | Public chat and protected dashboard API contracts |
| [Architecture Deep Dive](./docs/architectureDeepDive.md) | Engineers and reviewers | AWS components, data flows, security, scaling, and decisions |
| [Project Closure](./docs/projectClosure.md) | Client and delivery teams | Scope, deliverables, implementation summary, and future work |

## Safety And Privacy

Scout AI is an informational tool, not an emergency reporting channel. Users should not submit medical information, youth-protection reports, or other sensitive personal information. The application logs chat turns for quality and analytics; administrators can review rated conversations in the protected dashboard.

## License

See [LICENSE](./LICENSE).
