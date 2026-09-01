#!/usr/bin/env bash
#
# deploy.sh — one-command AWS sandbox deployment for GCC Chat.
#
# The caller packages the reviewed Git commit and starts one AWS CodeBuild job.
# CodeBuild bootstraps CDK, deploys GCC's backend, builds the frontend, publishes
# the shared private S3 origin, and invalidates its CloudFront distribution.
# The caller then creates the first Cognito administrator.
#
# Usage:
#   ./deploy.sh [--region us-west-2] [--profile gcc-sandbox] [--prefix demo]
#               [--stack-name GrandCanyonCouncilChatbot]
#               [--admin-email you@example.org] [--admin-password 'Pass@123']
#               [--skip-admin] [--yes]
#
# Prerequisites: AWS CLI v2, Bash, Git, jq, and either AdministratorAccess or
# the scoped policy in deployment/gcc-deployer-policy.json.
set -euo pipefail

STACK_NAME="${STACK_NAME:-}"
STACK_NAME_EXPLICIT="false"
[[ -n "$STACK_NAME" ]] && STACK_NAME_EXPLICIT="true"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
REGION_SET_BY_FLAG="false"
PROFILE=""
RESOURCE_PREFIX="${RESOURCE_PREFIX:-}"
ADMIN_EMAIL=""
ADMIN_PASSWORD="${GCC_ADMIN_PASSWORD:-}"
SKIP_ADMIN="false"
ASSUME_YES="false"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP_DIR=""

# shellcheck source=deployment/stack-resolution.sh
source "$SCRIPT_DIR/deployment/stack-resolution.sh"

if [[ -t 1 ]]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; NC=""
fi
info()  { echo "${BLUE}==>${NC} $*"; }
ok()    { echo "${GREEN}✓${NC} $*"; }
warn()  { echo "${YELLOW}!${NC} $*"; }
die()   { echo "${RED}✗ $*${NC}" >&2; exit 1; }

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf -- "$TEMP_DIR"
  fi
}
trap cleanup EXIT

require_value() {
  [[ $# -ge 2 && -n "${2:-}" ]] || die "$1 requires a value"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)
      require_value "$1" "${2:-}"; REGION="$2"; REGION_SET_BY_FLAG="true"; shift 2;;
    --profile)
      require_value "$1" "${2:-}"; PROFILE="$2"; shift 2;;
    --prefix)
      require_value "$1" "${2:-}"; RESOURCE_PREFIX="$2"; shift 2;;
    --stack-name)
      require_value "$1" "${2:-}"; STACK_NAME="$2"; STACK_NAME_EXPLICIT="true"; shift 2;;
    --admin-email)
      require_value "$1" "${2:-}"; ADMIN_EMAIL="$2"; shift 2;;
    --admin-password)
      require_value "$1" "${2:-}"; ADMIN_PASSWORD="$2"; shift 2;;
    --skip-admin)
      SKIP_ADMIN="true"; shift;;
    -y|--yes)
      ASSUME_YES="true"; shift;;
    -h|--help)
      sed -n '2,18s/^# \{0,1\}//p' "$0"; exit 0;;
    *)
      die "Unknown argument: $1";;
  esac
done

if [[ "$REGION_SET_BY_FLAG" != "true" && -t 0 ]]; then
  DEFAULT_REGION="${REGION:-us-west-2}"
  read -r -p "AWS Region [$DEFAULT_REGION]: " REGION_INPUT
  REGION="${REGION_INPUT:-$DEFAULT_REGION}"
else
  REGION="${REGION:-us-west-2}"
fi

if [[ -n "$RESOURCE_PREFIX" ]]; then
  [[ "$RESOURCE_PREFIX" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] \
    || die "Prefix must contain only lowercase letters, numbers, and internal hyphens"
  # The longest account-suffixed S3 name must remain within the 63-character
  # bucket-name limit.
  [[ ${#RESOURCE_PREFIX} -le 26 ]] \
    || die "Prefix must be 26 characters or fewer for S3 bucket names"
fi
[[ "$REGION" =~ ^[a-z0-9-]+$ ]] || die "Invalid AWS Region: $REGION"
if [[ -n "$STACK_NAME" ]] && ! gcc_is_supported_stack_name "$STACK_NAME"; then
  die "Unsupported stack name '$STACK_NAME'. Use $GCC_CURRENT_STACK_NAME or $GCC_LEGACY_STACK_NAME."
fi

command -v aws >/dev/null || die "AWS CLI not found"
command -v git >/dev/null || die "Git not found"
command -v jq >/dev/null || die "jq not found"
git -C "$SCRIPT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || die "deploy.sh must be run from a Git checkout"

AWS_ARGS=(--region "$REGION" --no-cli-pager)
[[ -n "$PROFILE" ]] && AWS_ARGS+=(--profile "$PROFILE")
aws_cli() { aws "$@" "${AWS_ARGS[@]}"; }

info "Validating AWS identity and reviewed source"
CALLER_JSON="$(aws_cli sts get-caller-identity --output json)" \
  || die "AWS credentials are not configured for $REGION"
ACCOUNT_ID="$(jq -r '.Account' <<<"$CALLER_JSON")"
CALLER_ARN="$(jq -r '.Arn' <<<"$CALLER_JSON")"
[[ "$ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || die "Could not determine the AWS account ID"

if ! git -C "$SCRIPT_DIR" diff --quiet --ignore-submodules -- || \
   ! git -C "$SCRIPT_DIR" diff --cached --quiet --ignore-submodules --; then
  die "Tracked changes are present. Commit or discard them before deploying a reviewed build."
fi

DEPLOY_COMMIT="$(git -C "$SCRIPT_DIR" rev-parse HEAD)"
NAME_PREFIX="${RESOURCE_PREFIX:+${RESOURCE_PREFIX}-}"
PROJECT_NAME="${NAME_PREFIX}gcc-chatbot-deployment"
ROLE_NAME="${NAME_PREFIX}gcc-codebuild-deployment-role"
DEPLOYMENT_POLICY_NAME="GCC-Chatbot-DeploymentPolicy"
DEPLOYMENT_POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${DEPLOYMENT_POLICY_NAME}"
DEPLOYMENT_POLICY_FILE="$SCRIPT_DIR/deployment/gcc-codebuild-policy.json"
SOURCE_BUCKET="gcc-chatbot-deploy-${ACCOUNT_ID}-${REGION}"
SOURCE_KEY="${NAME_PREFIX}releases/$(date -u +%Y%m%dT%H%M%SZ)-${DEPLOY_COMMIT:0:12}.zip"
LOG_GROUP="/aws/codebuild/${PROJECT_NAME}"
REQUESTED_STACK_NAME=""
[[ "$STACK_NAME_EXPLICIT" == "true" ]] && REQUESTED_STACK_NAME="$STACK_NAME"

echo
echo "AWS sandbox deployment target"
echo "  Caller:   $CALLER_ARN"
echo "  Account:  $ACCOUNT_ID"
echo "  Region:   $REGION"
echo "  Stack:    ${REQUESTED_STACK_NAME:-<auto-detect in CodeBuild>}"
echo "  Commit:   $DEPLOY_COMMIT"
echo "  Prefix:   ${RESOURCE_PREFIX:-<none>}"
echo "  Policy:   $DEPLOYMENT_POLICY_ARN"
echo
warn "The deployment policy is scoped to the AWS services and GCC/CDK resources managed by this repository."

if [[ "$ASSUME_YES" != "true" ]]; then
  [[ -t 0 ]] || die "Use --yes for a non-interactive deployment"
  read -r -p "Deploy this reviewed commit to the account above? [y/N] " CONFIRM
  [[ "$CONFIRM" =~ ^[Yy]$ ]] || die "Deployment cancelled"
fi

if [[ "$SKIP_ADMIN" != "true" ]]; then
  if [[ -z "$ADMIN_EMAIL" ]]; then
    if [[ -t 0 ]]; then
      read -r -p "Initial administrator email: " ADMIN_EMAIL
    else
      die "Use --admin-email or --skip-admin for a non-interactive deployment"
    fi
  fi
  [[ "$ADMIN_EMAIL" == *@*.* ]] || die "Enter a valid initial administrator email"

  if [[ -z "$ADMIN_PASSWORD" ]]; then
    if [[ -t 0 ]]; then
      read -r -s -p "Initial administrator password: " ADMIN_PASSWORD
      echo
    else
      die "Set GCC_ADMIN_PASSWORD or use --admin-password for a non-interactive deployment"
    fi
  fi
  [[ ${#ADMIN_PASSWORD} -ge 8 ]] || die "The administrator password must be at least eight characters"
fi

TEMP_DIR="$(mktemp -d)"
SOURCE_ARCHIVE="$TEMP_DIR/gcc-source.zip"

[[ -f "$DEPLOYMENT_POLICY_FILE" ]] \
  || die "Missing deployment policy: $DEPLOYMENT_POLICY_FILE"
CODEBUILD_POLICY_JSON="$(jq -c . "$DEPLOYMENT_POLICY_FILE")"

TRUST_POLICY_JSON="$(cat <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "codebuild.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
JSON
)"


info "Creating or updating the scoped GCC deployment policy"
if aws_cli iam get-policy --policy-arn "$DEPLOYMENT_POLICY_ARN" >/dev/null 2>&1; then
  POLICY_VERSIONS_JSON="$(aws_cli iam list-policy-versions \
    --policy-arn "$DEPLOYMENT_POLICY_ARN" \
    --output json)"
  if (( $(jq '.Versions | length' <<<"$POLICY_VERSIONS_JSON") >= 5 )); then
    OLDEST_NONDEFAULT_VERSION="$(jq -r \
      '[.Versions[] | select(.IsDefaultVersion == false)] | sort_by(.CreateDate) | first | .VersionId // empty' \
      <<<"$POLICY_VERSIONS_JSON")"
    [[ -n "$OLDEST_NONDEFAULT_VERSION" ]] \
      || die "Cannot rotate versions for $DEPLOYMENT_POLICY_NAME"
    aws_cli iam delete-policy-version \
      --policy-arn "$DEPLOYMENT_POLICY_ARN" \
      --version-id "$OLDEST_NONDEFAULT_VERSION"
  fi
  aws_cli iam create-policy-version \
    --policy-arn "$DEPLOYMENT_POLICY_ARN" \
    --policy-document "$CODEBUILD_POLICY_JSON" \
    --set-as-default >/dev/null
  aws_cli iam tag-policy \
    --policy-arn "$DEPLOYMENT_POLICY_ARN" \
    --tags Key=Project,Value=GrandCanyonCouncilChatbot Key=ManagedBy,Value=deploy.sh
else
  aws_cli iam create-policy \
    --policy-name "$DEPLOYMENT_POLICY_NAME" \
    --description "Scoped CDK and CodeBuild deployment access for GCC Chat" \
    --policy-document "$CODEBUILD_POLICY_JSON" \
    --tags Key=Project,Value=GrandCanyonCouncilChatbot Key=ManagedBy,Value=deploy.sh >/dev/null
fi
ok "Deployment policy ready: $DEPLOYMENT_POLICY_ARN"

info "Creating or updating the scoped CodeBuild service role"
if aws_cli iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws_cli iam update-assume-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-document "$TRUST_POLICY_JSON"
  aws_cli iam tag-role \
    --role-name "$ROLE_NAME" \
    --tags Key=Project,Value=GrandCanyonCouncilChatbot Key=ManagedBy,Value=deploy.sh
else
  aws_cli iam create-role \
    --role-name "$ROLE_NAME" \
    --description "Sandbox deployment role for GCC Chat" \
    --assume-role-policy-document "$TRUST_POLICY_JSON" \
    --tags Key=Project,Value=GrandCanyonCouncilChatbot Key=ManagedBy,Value=deploy.sh >/dev/null
fi
aws_cli iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn "$DEPLOYMENT_POLICY_ARN"

# Remove permissions left by older sandbox installers after the scoped policy
# is attached, so updates do not silently retain administrator access.
if aws_cli iam list-attached-role-policies \
  --role-name "$ROLE_NAME" \
  --query "AttachedPolicies[?PolicyArn=='arn:aws:iam::aws:policy/AdministratorAccess'].PolicyArn | [0]" \
  --output text | grep -qx 'arn:aws:iam::aws:policy/AdministratorAccess'; then
  aws_cli iam detach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
fi

LEGACY_INLINE_POLICY="${NAME_PREFIX}gcc-sandbox-administrator"
if aws_cli iam list-role-policies \
  --role-name "$ROLE_NAME" \
  --query "PolicyNames[?@=='$LEGACY_INLINE_POLICY'] | [0]" \
  --output text | grep -qx "$LEGACY_INLINE_POLICY"; then
  aws_cli iam delete-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name "$LEGACY_INLINE_POLICY"
fi
ROLE_ARN="$(aws_cli iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"
ok "CodeBuild role ready: $ROLE_ARN"

info "Preparing the private CodeBuild source bucket"
if ! aws_cli s3api head-bucket --bucket "$SOURCE_BUCKET" >/dev/null 2>&1; then
  if [[ "$REGION" == "us-east-1" ]]; then
    aws_cli s3api create-bucket --bucket "$SOURCE_BUCKET" >/dev/null
  else
    aws_cli s3api create-bucket \
      --bucket "$SOURCE_BUCKET" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
fi
aws_cli s3api put-public-access-block \
  --bucket "$SOURCE_BUCKET" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws_cli s3api put-bucket-encryption \
  --bucket "$SOURCE_BUCKET" \
  --server-side-encryption-configuration \
    'Rules=[{ApplyServerSideEncryptionByDefault={SSEAlgorithm=AES256},BucketKeyEnabled=true}]'
aws_cli s3api put-bucket-versioning \
  --bucket "$SOURCE_BUCKET" \
  --versioning-configuration Status=Enabled
LIFECYCLE_JSON="$(cat <<'JSON'
{
  "Rules": [
    {
      "ID": "ExpireDeploymentArchives",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "Expiration": { "Days": 30 },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 7 }
    }
  ]
}
JSON
)"
aws_cli s3api put-bucket-lifecycle-configuration \
  --bucket "$SOURCE_BUCKET" \
  --lifecycle-configuration "$LIFECYCLE_JSON"

git -C "$SCRIPT_DIR" archive --format=zip --output "$SOURCE_ARCHIVE" HEAD
aws_cli s3 cp "$SOURCE_ARCHIVE" "s3://$SOURCE_BUCKET/$SOURCE_KEY" --only-show-errors
ok "Uploaded reviewed source: s3://$SOURCE_BUCKET/$SOURCE_KEY"

PROJECT_JSON="$(cat <<JSON
{
  "name": "${PROJECT_NAME}",
  "description": "Unified sandbox deployment for GCC Chat",
  "source": {
    "type": "S3",
    "location": "${SOURCE_BUCKET}/${SOURCE_KEY}",
    "buildspec": "buildspec.yml"
  },
  "artifacts": { "type": "NO_ARTIFACTS" },
  "environment": {
    "type": "LINUX_CONTAINER",
    "image": "aws/codebuild/standard:7.0",
    "computeType": "BUILD_GENERAL1_LARGE",
    "privilegedMode": false,
    "imagePullCredentialsType": "CODEBUILD",
    "environmentVariables": [
      { "name": "AWS_REGION", "value": "${REGION}", "type": "PLAINTEXT" },
      { "name": "AWS_DEFAULT_REGION", "value": "${REGION}", "type": "PLAINTEXT" },
      { "name": "CDK_DEFAULT_REGION", "value": "${REGION}", "type": "PLAINTEXT" },
      { "name": "CDK_DEFAULT_ACCOUNT", "value": "${ACCOUNT_ID}", "type": "PLAINTEXT" },
      { "name": "RESOURCE_PREFIX", "value": "${RESOURCE_PREFIX}", "type": "PLAINTEXT" },
      { "name": "REQUESTED_STACK_NAME", "value": "${REQUESTED_STACK_NAME}", "type": "PLAINTEXT" },
      { "name": "DEPLOYMENT_POLICY_ARN", "value": "${DEPLOYMENT_POLICY_ARN}", "type": "PLAINTEXT" }
    ]
  },
  "serviceRole": "${ROLE_ARN}",
  "timeoutInMinutes": 60,
  "queuedTimeoutInMinutes": 60,
  "logsConfig": {
    "cloudWatchLogs": {
      "status": "ENABLED",
      "groupName": "${LOG_GROUP}"
    }
  },
  "tags": [
    { "key": "Project", "value": "GrandCanyonCouncilChatbot" },
    { "key": "ManagedBy", "value": "deploy.sh" }
  ]
}
JSON
)"

info "Creating or updating CodeBuild project: $PROJECT_NAME"
if [[ "$(aws_cli codebuild batch-get-projects \
  --names "$PROJECT_NAME" \
  --query 'projects[0].name' \
  --output text 2>/dev/null || true)" == "$PROJECT_NAME" ]]; then
  aws_cli codebuild update-project --cli-input-json "$PROJECT_JSON" >/dev/null
else
  # New IAM roles can take a few seconds to become assumable by CodeBuild.
  sleep 10
  aws_cli codebuild create-project --cli-input-json "$PROJECT_JSON" >/dev/null
fi
ok "CodeBuild project ready"

info "Starting the unified GCC deployment"
BUILD_ID="$(aws_cli codebuild start-build \
  --project-name "$PROJECT_NAME" \
  --query 'build.id' \
  --output text)"
[[ -n "$BUILD_ID" && "$BUILD_ID" != "None" ]] || die "CodeBuild did not return a build ID"
LOG_STREAM="${BUILD_ID#*:}"
ok "Build started: $BUILD_ID"
echo "AWS console: https://${REGION}.console.aws.amazon.com/codesuite/codebuild/${ACCOUNT_ID}/projects/${PROJECT_NAME}/build/${BUILD_ID}/log?region=${REGION}"
echo

BUILD_STATUS="IN_PROGRESS"
LAST_TOKEN=""
while [[ "$BUILD_STATUS" == "IN_PROGRESS" ]]; do
  if [[ -z "$LAST_TOKEN" ]]; then
    LOG_JSON="$(aws_cli logs get-log-events \
      --log-group-name "$LOG_GROUP" \
      --log-stream-name "$LOG_STREAM" \
      --start-from-head \
      --output json 2>/dev/null || true)"
  else
    LOG_JSON="$(aws_cli logs get-log-events \
      --log-group-name "$LOG_GROUP" \
      --log-stream-name "$LOG_STREAM" \
      --next-token "$LAST_TOKEN" \
      --output json 2>/dev/null || true)"
  fi

  if [[ -n "$LOG_JSON" ]]; then
    jq -r '.events[]?.message' <<<"$LOG_JSON"
    NEXT_TOKEN="$(jq -r '.nextForwardToken // empty' <<<"$LOG_JSON")"
    [[ -n "$NEXT_TOKEN" ]] && LAST_TOKEN="$NEXT_TOKEN"
  fi

  BUILD_STATUS="$(aws_cli codebuild batch-get-builds \
    --ids "$BUILD_ID" \
    --query 'builds[0].buildStatus' \
    --output text)"
  [[ "$BUILD_STATUS" == "IN_PROGRESS" ]] && sleep 5
done

if [[ -n "$LAST_TOKEN" ]]; then
  FINAL_LOG_JSON="$(aws_cli logs get-log-events \
    --log-group-name "$LOG_GROUP" \
    --log-stream-name "$LOG_STREAM" \
    --next-token "$LAST_TOKEN" \
    --output json 2>/dev/null || true)"
  [[ -n "$FINAL_LOG_JSON" ]] && jq -r '.events[]?.message' <<<"$FINAL_LOG_JSON"
fi

[[ "$BUILD_STATUS" == "SUCCEEDED" ]] \
  || die "CodeBuild deployment ended with status $BUILD_STATUS. Review $LOG_GROUP / $LOG_STREAM."
ok "CodeBuild deployment succeeded"

FINAL_BUILD_JSON="$(aws_cli codebuild batch-get-builds --ids "$BUILD_ID" --output json)"
get_exported_value() {
  jq -r --arg name "$1" \
    '[.builds[0].exportedEnvironmentVariables[]? | select(.name == $name) | .value] | first // empty' \
    <<<"$FINAL_BUILD_JSON"
}

STACK_NAME="$(get_exported_value RESOLVED_STACK_NAME)"
CHAT_API_URL="$(get_exported_value CHAT_API_URL)"
DASHBOARD_API_URL="$(get_exported_value DASHBOARD_API_URL)"
USER_POOL_ID="$(get_exported_value USER_POOL_ID)"
CLIENT_ID="$(get_exported_value CLIENT_ID)"
DOCUMENT_BUCKET="$(get_exported_value DOCUMENT_BUCKET)"
KB_BUCKET="$(get_exported_value KB_BUCKET)"
FRONTEND_URL="$(get_exported_value FRONTEND_URL)"
OPERATIONS_DASHBOARD="$(get_exported_value OPERATIONS_DASHBOARD)"

for required_value in \
  "$STACK_NAME" "$CHAT_API_URL" "$DASHBOARD_API_URL" "$USER_POOL_ID" \
  "$CLIENT_ID" "$DOCUMENT_BUCKET" "$KB_BUCKET" "$FRONTEND_URL" "$OPERATIONS_DASHBOARD"; do
  [[ -n "$required_value" && "$required_value" != "None" ]] \
    || die "CodeBuild succeeded but did not export all deployment outputs"
done

if [[ "$SKIP_ADMIN" != "true" ]]; then
  info "Creating or updating initial administrator: $ADMIN_EMAIL"
  aws_cli cognito-idp admin-create-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$ADMIN_EMAIL" \
    --user-attributes Name=email,Value="$ADMIN_EMAIL" Name=email_verified,Value=true \
    --message-action SUPPRESS >/dev/null 2>&1 \
    || warn "The Cognito user may already exist; setting its password and group"
  aws_cli cognito-idp admin-set-user-password \
    --user-pool-id "$USER_POOL_ID" \
    --username "$ADMIN_EMAIL" \
    --password "$ADMIN_PASSWORD" \
    --permanent
  aws_cli cognito-idp admin-add-user-to-group \
    --user-pool-id "$USER_POOL_ID" \
    --username "$ADMIN_EMAIL" \
    --group-name admin
  ok "Administrator is ready"
fi

echo
ok "Complete GCC sandbox deployment finished"
echo "Public chat:          ${GREEN}$FRONTEND_URL${NC}"
echo "Admin login:          ${GREEN}${FRONTEND_URL%/}/admin${NC}"
echo "Admin dashboard:      ${GREEN}${FRONTEND_URL%/}/dashboard${NC}"
echo "Chat API:             $CHAT_API_URL"
echo "Dashboard API:        $DASHBOARD_API_URL"
echo "Cognito user pool:    $USER_POOL_ID"
echo "Cognito client:       $CLIENT_ID"
echo "Document bucket:      $DOCUMENT_BUCKET"
echo "Knowledge-base data:  $KB_BUCKET"
echo "Operations dashboard: $OPERATIONS_DASHBOARD"
