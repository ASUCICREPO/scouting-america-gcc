#!/usr/bin/env bash
#
# deploy.sh — one-command AWS sandbox deployment for the Scouting America GCC chatbot.
#
# The caller packages the reviewed Git commit and starts one AWS CodeBuild job.
# CodeBuild bootstraps CDK, deploys GCC's backend, builds the frontend, publishes
# the isolated public/admin S3 origins, and invalidates both CloudFront distributions.
# The caller then creates the first Cognito administrator.
#
# Usage:
#   ./deploy.sh [--region us-west-2] [--profile gcc-sandbox] [--prefix demo]
#               [--admin-email you@example.org] [--admin-password 'Pass@123']
#               [--mock-deploy] [--skip-admin] [--yes]
#
# Prerequisites: AWS CLI v2, Bash, Git, jq, and an administrator-capable AWS
# CLI session in an approved sandbox account. This is not a production installer.
set -euo pipefail

STACK_NAME="ScoutingAmericaChatbot"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-west-2}}"
PROFILE=""
RESOURCE_PREFIX="${RESOURCE_PREFIX:-}"
ADMIN_EMAIL=""
ADMIN_PASSWORD="${GCC_ADMIN_PASSWORD:-}"
SKIP_ADMIN="false"
ASSUME_YES="false"
MOCK_DEPLOY="false"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP_DIR=""

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
      require_value "$1" "${2:-}"; REGION="$2"; shift 2;;
    --profile)
      require_value "$1" "${2:-}"; PROFILE="$2"; shift 2;;
    --prefix)
      require_value "$1" "${2:-}"; RESOURCE_PREFIX="$2"; shift 2;;
    --admin-email)
      require_value "$1" "${2:-}"; ADMIN_EMAIL="$2"; shift 2;;
    --admin-password)
      require_value "$1" "${2:-}"; ADMIN_PASSWORD="$2"; shift 2;;
    --mock-deploy)
      MOCK_DEPLOY="true"; shift;;
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

if [[ "$MOCK_DEPLOY" == "true" ]]; then
  if [[ -n "$RESOURCE_PREFIX" && "$RESOURCE_PREFIX" != "mock-deploy" ]]; then
    die "--mock-deploy cannot be combined with a different --prefix"
  fi
  RESOURCE_PREFIX="mock-deploy"
  STACK_NAME="mock-deploy-ScoutingAmericaChatbot"
fi

if [[ -n "$RESOURCE_PREFIX" ]]; then
  [[ "$RESOURCE_PREFIX" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] \
    || die "Prefix must contain only lowercase letters, numbers, and internal hyphens"
  [[ ${#RESOURCE_PREFIX} -le 30 ]] \
    || die "Prefix must be 30 characters or fewer for IAM and CodeBuild names"
fi
[[ "$REGION" =~ ^[a-z0-9-]+$ ]] || die "Invalid AWS Region: $REGION"
[[ "$STACK_NAME" =~ ^[A-Za-z][A-Za-z0-9-]{0,127}$ ]] \
  || die "Invalid CloudFormation stack name: $STACK_NAME"

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
SOURCE_BUCKET="gcc-chatbot-deploy-${ACCOUNT_ID}-${REGION}"
SOURCE_KEY="${NAME_PREFIX}releases/$(date -u +%Y%m%dT%H%M%SZ)-${DEPLOY_COMMIT:0:12}.zip"
LOG_GROUP="/aws/codebuild/${PROJECT_NAME}"
ADMIN_POLICY_ARN="arn:aws:iam::aws:policy/AdministratorAccess"

echo
echo "AWS sandbox deployment target"
echo "  Caller:   $CALLER_ARN"
echo "  Account:  $ACCOUNT_ID"
echo "  Region:   $REGION"
echo "  Commit:   $DEPLOY_COMMIT"
echo "  Stack:    $STACK_NAME"
echo "  Prefix:   ${RESOURCE_PREFIX:-<none>}"
echo
warn "This sandbox installer gives the CodeBuild deployment role AdministratorAccess."

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
TRUST_POLICY_FILE="$TEMP_DIR/codebuild-trust.json"
PROJECT_FILE="$TEMP_DIR/codebuild-project.json"
SOURCE_ARCHIVE="$TEMP_DIR/gcc-source.zip"
LIFECYCLE_FILE="$TEMP_DIR/source-lifecycle.json"

cat > "$TRUST_POLICY_FILE" <<'JSON'
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

info "Creating or updating the administrator-capable CodeBuild service role"
if aws_cli iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws_cli iam update-assume-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-document "file://$TRUST_POLICY_FILE"
  aws_cli iam tag-role \
    --role-name "$ROLE_NAME" \
    --tags Key=Project,Value=ScoutingAmericaGCC Key=ManagedBy,Value=deploy.sh \
      Key=Deployment,Value="${RESOURCE_PREFIX:-default}"
else
  aws_cli iam create-role \
    --role-name "$ROLE_NAME" \
    --description "Sandbox deployment role for the GCC chatbot" \
    --assume-role-policy-document "file://$TRUST_POLICY_FILE" \
    --tags Key=Project,Value=ScoutingAmericaGCC Key=ManagedBy,Value=deploy.sh \
      Key=Deployment,Value="${RESOURCE_PREFIX:-default}" >/dev/null
fi
aws_cli iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn "$ADMIN_POLICY_ARN"
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
cat > "$LIFECYCLE_FILE" <<'JSON'
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
aws_cli s3api put-bucket-lifecycle-configuration \
  --bucket "$SOURCE_BUCKET" \
  --lifecycle-configuration "file://$LIFECYCLE_FILE"

git -C "$SCRIPT_DIR" archive --format=zip --output "$SOURCE_ARCHIVE" HEAD
aws_cli s3 cp "$SOURCE_ARCHIVE" "s3://$SOURCE_BUCKET/$SOURCE_KEY" --only-show-errors
ok "Uploaded reviewed source: s3://$SOURCE_BUCKET/$SOURCE_KEY"

cat > "$PROJECT_FILE" <<JSON
{
  "name": "${PROJECT_NAME}",
  "description": "Unified sandbox deployment for the Scouting America GCC chatbot",
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
      { "name": "STACK_NAME", "value": "${STACK_NAME}", "type": "PLAINTEXT" }
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
    { "key": "Project", "value": "ScoutingAmericaGCC" },
    { "key": "ManagedBy", "value": "deploy.sh" },
    { "key": "Deployment", "value": "${RESOURCE_PREFIX:-default}" }
  ]
}
JSON

info "Creating or updating CodeBuild project: $PROJECT_NAME"
if [[ "$(aws_cli codebuild batch-get-projects \
  --names "$PROJECT_NAME" \
  --query 'projects[0].name' \
  --output text 2>/dev/null || true)" == "$PROJECT_NAME" ]]; then
  aws_cli codebuild update-project --cli-input-json "file://$PROJECT_FILE" >/dev/null
else
  # New IAM roles can take a few seconds to become assumable by CodeBuild.
  sleep 10
  aws_cli codebuild create-project --cli-input-json "file://$PROJECT_FILE" >/dev/null
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

get_output() {
  aws_cli cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text
}

CHAT_API_URL="$(get_output ChatApiUrl)"
DASHBOARD_API_URL="$(get_output DashboardApiUrl)"
USER_POOL_ID="$(get_output UserPoolId)"
CLIENT_ID="$(get_output UserPoolClientId)"
DOCUMENT_BUCKET="$(get_output DocumentStoreBucket)"
KB_BUCKET="$(get_output KnowledgeBaseBucket)"
PUBLIC_FRONTEND_URL="$(get_output PublicFrontendUrl)"
ADMIN_FRONTEND_URL="$(get_output AdminFrontendUrl)"
OPERATIONS_DASHBOARD="$(get_output OperationsDashboardName)"

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
echo "CloudFormation stack: $STACK_NAME"
echo "Resource prefix:      ${RESOURCE_PREFIX:-<none>}"
echo "Public chat:          ${GREEN}$PUBLIC_FRONTEND_URL${NC}"
echo "Admin dashboard:      ${GREEN}$ADMIN_FRONTEND_URL${NC}"
echo "Chat API:             $CHAT_API_URL"
echo "Dashboard API:        $DASHBOARD_API_URL"
echo "Cognito user pool:    $USER_POOL_ID"
echo "Cognito client:       $CLIENT_ID"
echo "Document bucket:      $DOCUMENT_BUCKET"
echo "Knowledge-base data:  $KB_BUCKET"
echo "Operations dashboard: $OPERATIONS_DASHBOARD"
