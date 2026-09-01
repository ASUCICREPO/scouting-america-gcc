#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=stack-resolution.sh
source "$SCRIPT_DIR/stack-resolution.sh"

die() {
  echo "Stack preflight failed: $*" >&2
  exit 1
}

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
ACCOUNT_ID="${CDK_DEFAULT_ACCOUNT:-}"
REQUESTED_STACK_NAME="${REQUESTED_STACK_NAME:-}"
RESOURCE_PREFIX="${RESOURCE_PREFIX:-}"

[[ -n "$REGION" ]] || die "AWS_REGION is required"
[[ "$ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || die "CDK_DEFAULT_ACCOUNT must be a 12-digit AWS account ID"
if [[ -n "$REQUESTED_STACK_NAME" ]] && ! gcc_is_supported_stack_name "$REQUESTED_STACK_NAME"; then
  die "Unsupported stack name '$REQUESTED_STACK_NAME'"
fi

NAME_PREFIX="${RESOURCE_PREFIX:+${RESOURCE_PREFIX}-}"
aws_cli() { aws "$@" --region "$REGION" --no-cli-pager; }

get_stack_status() {
  local candidate="$1"
  local output
  if output="$(aws_cli cloudformation describe-stacks \
    --stack-name "$candidate" \
    --query 'Stacks[0].StackStatus' \
    --output text 2>&1)"; then
    printf '%s' "$output"
    return 0
  fi

  if [[ "$output" == *"Stack with id"*"does not exist"* ]]; then
    return 0
  fi
  die "Cannot inspect CloudFormation stack $candidate. AWS CLI: $output"
}

application_bucket_exists() {
  local bucket_name="$1"
  local output
  if output="$(aws_cli s3api head-bucket --bucket "$bucket_name" 2>&1)"; then
    return 0
  fi
  if [[ "$output" == *"(404)"* || "$output" == *"Not Found"* || "$output" == *"NoSuchBucket"* ]]; then
    return 1
  fi
  die "Cannot verify whether S3 bucket $bucket_name exists. AWS CLI: $output"
}

application_role_exists() {
  local role_name="$1"
  local output
  if output="$(aws_cli iam get-role --role-name "$role_name" 2>&1)"; then
    return 0
  fi
  if [[ "$output" == *"NoSuchEntity"* ]]; then
    return 1
  fi
  die "Cannot verify whether IAM role $role_name exists. AWS CLI: $output"
}

CURRENT_STACK_STATUS="$(get_stack_status "$GCC_CURRENT_STACK_NAME")"
LEGACY_STACK_STATUS="$(get_stack_status "$GCC_LEGACY_STACK_NAME")"
if ! STACK_RESOLUTION="$(gcc_resolve_stack_name \
  "$REQUESTED_STACK_NAME" \
  "$CURRENT_STACK_STATUS" \
  "$LEGACY_STACK_STATUS" 2>&1)"; then
  die "$STACK_RESOLUTION"
fi
IFS='|' read -r RESOLVED_STACK_NAME STACK_STATUS <<<"$STACK_RESOLUTION"

if [[ "$RESOLVED_STACK_NAME" == "$GCC_LEGACY_STACK_NAME" && "$CURRENT_STACK_STATUS" == "REVIEW_IN_PROGRESS" ]]; then
  echo "$GCC_CURRENT_STACK_NAME is an incomplete REVIEW_IN_PROGRESS placeholder; using the existing legacy stack." >&2
elif [[ "$RESOLVED_STACK_NAME" == "$GCC_CURRENT_STACK_NAME" && "$LEGACY_STACK_STATUS" == "REVIEW_IN_PROGRESS" ]]; then
  echo "$GCC_LEGACY_STACK_NAME is an incomplete REVIEW_IN_PROGRESS placeholder; using the existing current stack." >&2
fi

if [[ "$STACK_STATUS" == "NEW" ]]; then
  EXISTING_CORE_RESOURCES=()
  for bucket_name in \
    "${NAME_PREFIX}gcc-document-store-${ACCOUNT_ID}" \
    "${NAME_PREFIX}gcc-knowledge-base-data-${ACCOUNT_ID}" \
    "${NAME_PREFIX}gcc-chat-audit-archive-${ACCOUNT_ID}"; do
    if application_bucket_exists "$bucket_name"; then
      EXISTING_CORE_RESOURCES+=("S3 bucket $bucket_name")
    fi
  done
  if application_role_exists "${NAME_PREFIX}GCC-BedrockKB-Role"; then
    EXISTING_CORE_RESOURCES+=("IAM role ${NAME_PREFIX}GCC-BedrockKB-Role")
  fi

  if (( ${#EXISTING_CORE_RESOURCES[@]} > 0 )); then
    echo "No deployable $RESOLVED_STACK_NAME stack exists, but named application resources already exist:" >&2
    for existing_resource in "${EXISTING_CORE_RESOURCES[@]}"; do
      echo "  - $existing_resource" >&2
    done
    die "Identify the CloudFormation owner. Do not delete retained client data to make deployment pass."
  fi
fi

echo "Resolved deployment target: $RESOLVED_STACK_NAME ($STACK_STATUS)" >&2
printf '%s\n' "$RESOLVED_STACK_NAME"
