# Restructure Implementation Plan — Cincinnati Alignment

**Branch:** `restructure`
**Goal:** align the backend with the Cincinnati gold-standard: Python 3.13 lambdas, a project-named stack, one-step `deploy.sh` + `buildspec.yml`, and repo cleanup. CDK stays TypeScript.
**Nature:** breaking for the current deployed environment (stack rename + fixed resource names) → intended to run against a **fresh deploy** with a one-time re-ingest at the end.

Reference pattern (Cincinnati `backend/lib/backend-stack.ts`):
```ts
new lambda.Function(this, "X", {
  runtime: lambda.Runtime.PYTHON_3_13,
  handler: "index.handler",
  code: lambda.Code.fromAsset("lambda/x"),   // boto3 is in the runtime; no bundling
});
```
Only a lambda with extra pip deps needs `bundling` with `PYTHON_3_13.bundlingImage`. Our 4 lambdas use only boto3 → plain assets, no Docker.

---

## Phase 0 — Conventions (no code)
- Python **3.13**, handler `index.handler` → `def handler(event, context):`.
- boto3 clients module-scoped; env vars via `os.environ`.
- Responses: helper `respond(status, body)` returning API Gateway proxy dict.
- No external pip packages (boto3 only). If any lambda later needs deps, add `requirements.txt` + bundling.

## Phase 1 — Rename the stack to a project name
- `backend/lib/backend-stack.ts`: rename class `BackendStack` → `ScoutingAmericaChatbot`.
- `backend/bin/backend.ts`: `new ScoutingAmericaChatbot(app, "ScoutingAmericaChatbot", {...})` (construct id changes → new CloudFormation stack name; acceptable on fresh deploy).
- `backend/test/backend.test.ts`: update import + instantiation.
- Verify: `npx jest`, `npx cdk synth`.

## Phase 2 — Migrate lambdas to Python (one at a time, simplest → hardest)
Each step: write `backend/lambda/<name>/index.py`, delete `index.ts`, switch the construct from `NodejsFunction` → `lambda.Function` (PYTHON_3_13, `Code.fromAsset`), drop the `aws-lambda-nodejs` import + `bundling`, keep env vars + IAM + logGroup + DLQ. Run `npx cdk synth` after each.
- [x] 2a. **escalation-router** (SNS, SES, DynamoDB) — simplest.
- [x] 2b. **doc-processor** (S3 copy, bedrock-agent StartIngestionJob, DynamoDB; S3 event).
- [x] 2c. **dashboard** (DynamoDB scan/query, S3 list/get/put/delete, presigned URLs via `generate_presigned_url`, bedrock-agent).
- [x] 2d. **chat-handler** (bedrock-agent-runtime RetrieveAndGenerate + Retrieve, Secrets Manager, Lambda invoke, DynamoDB) — most complex.

## Phase 3 — Tests ✅
- [x] Update `backend.test.ts` for the renamed stack; add assertion that every function `Runtime` is `python3.13`.
- [x] `npx jest` green (4/4); `npx cdk synth` clean (cdk-nag passes).

## Phase 4 — One-step deploy + CI
- [ ] `deploy.sh` (Cincinnati-style): `cdk deploy`, capture outputs (chat API URL, dashboard API URL, Cognito pool/client), write `frontend/.env.local`, seed an admin Cognito user in the `admin` group, optionally kick a KB ingestion.
- [ ] `buildspec.yml` for CodeBuild.

## Phase 5 — Repo cleanup
- [ ] Remove root clutter: `*-review.md`, `hardening-plan.md`, `next-cleanup-plan.md`, `restructure-plan.md`, `ai_dlc_*`, stray images — as the final commit.

## Phase 6 — Fresh deploy + re-ingest (ops, documented in deploy.sh)
- Fresh `cdk deploy` (new stack name), then `aws s3 sync` docs → KB bucket + one `start-ingestion-job`.

---

## Sequencing / commits
One commit per lambda migration + one for the stack rename + one for deploy/CI + one for cleanup. Verify `jest` + `cdk synth` after every step so the branch is always green.
