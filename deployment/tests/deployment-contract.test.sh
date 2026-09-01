#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$TEST_DIR/../.." && pwd)"

jq -e '.. | strings | select(. == "cloudwatch:ListTagsForResource")' \
  "$REPO_DIR/deployment/gcc-codebuild-policy.json" >/dev/null
jq -e '.. | strings | select(contains("ScoutingAmericaChatbot"))' \
  "$REPO_DIR/deployment/gcc-codebuild-policy.json" >/dev/null
jq -e '.. | strings | select(contains("ScoutingAmericaChatbot"))' \
  "$REPO_DIR/deployment/gcc-deployer-policy.json" >/dev/null
jq -e '.. | strings | select(. == "ApplicationResourcePreflight")' \
  "$REPO_DIR/deployment/gcc-deployer-policy.json" >/dev/null

grep -Fq 'npx cdk deploy "$STACK_NAME"' "$REPO_DIR/buildspec.yml"
grep -Fq 'aws-stack-preflight.sh' "$REPO_DIR/buildspec.yml"
grep -Fq 'exported-variables:' "$REPO_DIR/buildspec.yml"
grep -Fq "process.env.STACK_NAME || 'GrandCanyonCouncilChatbot'" \
  "$REPO_DIR/backend/bin/backend.ts"

echo "Deployment-contract tests passed"
