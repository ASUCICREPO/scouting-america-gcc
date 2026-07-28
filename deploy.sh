#!/usr/bin/env bash
#
# deploy.sh — one-step deploy for the Scouting America GCC Chatbot.
#
# Deploys the CDK backend (ScoutingAmericaChatbot stack), captures the stack
# outputs, wires them into frontend/.env.local, and optionally seeds an admin
# Cognito user. Mirrors the one-step deploy pattern of the Cincinnati project.
#
# Usage:
#   ./deploy.sh [--region us-east-1] [--profile default] [--prefix dev]
#               [--admin-email you@example.com] [--admin-password 'Pass@123']
#               [--skip-frontend-env] [--ingest ./ingest]
#
# Prereqs: aws cli v2, node + npm, cdk (npx), a bootstrapped account/region.
set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────
STACK_NAME="ScoutingAmericaChatbot"
REGION="${AWS_REGION:-us-east-1}"
PROFILE=""
RESOURCE_PREFIX="${RESOURCE_PREFIX:-}"
ADMIN_EMAIL=""
ADMIN_PASSWORD=""
SKIP_FRONTEND_ENV="false"
INGEST_DIR=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_ENV="$SCRIPT_DIR/frontend/.env.local"

# ── Colors ───────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; NC=""
fi
info()  { echo "${BLUE}==>${NC} $*"; }
ok()    { echo "${GREEN}✓${NC} $*"; }
warn()  { echo "${YELLOW}!${NC} $*"; }
die()   { echo "${RED}✗ $*${NC}" >&2; exit 1; }

# ── Args ─────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)          REGION="$2"; shift 2;;
    --profile)         PROFILE="$2"; shift 2;;
    --prefix)          RESOURCE_PREFIX="$2"; shift 2;;
    --admin-email)     ADMIN_EMAIL="$2"; shift 2;;
    --admin-password)  ADMIN_PASSWORD="$2"; shift 2;;
    --skip-frontend-env) SKIP_FRONTEND_ENV="true"; shift;;
    --ingest)          INGEST_DIR="$2"; shift 2;;
    -h|--help)         grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) die "Unknown argument: $1";;
  esac
done

if [[ -n "$RESOURCE_PREFIX" ]]; then
  [[ "$RESOURCE_PREFIX" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] \
    || die "Prefix must contain only lowercase letters, numbers, and internal hyphens"
  [[ ${#RESOURCE_PREFIX} -le 39 ]] \
    || die "Prefix must be 39 characters or fewer to keep generated S3 bucket names valid"
fi

# CDK inherits RESOURCE_PREFIX at synth time. Keep its deployment environment
# aligned with the region used for CloudFormation output reads and S3 publishing.
export RESOURCE_PREFIX
export AWS_REGION="$REGION"
export AWS_DEFAULT_REGION="$REGION"
export CDK_DEFAULT_REGION="$REGION"

AWS_ARGS=(--region "$REGION")
[[ -n "$PROFILE" ]] && AWS_ARGS+=(--profile "$PROFILE")

# ── Prereqs ──────────────────────────────────────────────────────────────────
info "Checking prerequisites"
command -v aws  >/dev/null || die "aws CLI not found"
command -v node >/dev/null || die "node not found"
command -v npm  >/dev/null || die "npm not found"
aws sts get-caller-identity "${AWS_ARGS[@]}" >/dev/null 2>&1 \
  || die "AWS credentials not configured (region=$REGION${PROFILE:+, profile=$PROFILE})"
ok "Prerequisites present"
ok "Resource prefix: ${RESOURCE_PREFIX:-<none>}"

# ── Deploy ───────────────────────────────────────────────────────────────────
info "Installing backend dependencies"
( cd "$BACKEND_DIR" && npm ci --silent || npm install --silent )

info "Deploying CDK stack: $STACK_NAME (region=$REGION)"
CDK_ARGS=(--require-approval never)
[[ -n "$PROFILE" ]] && CDK_ARGS+=(--profile "$PROFILE")
( cd "$BACKEND_DIR" && npx cdk deploy "$STACK_NAME" "${CDK_ARGS[@]}" )
ok "Stack deployed"

# ── Capture outputs ──────────────────────────────────────────────────────────
info "Reading stack outputs"
get_output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" "${AWS_ARGS[@]}" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

CHAT_API_URL="$(get_output ChatApiUrl)"
DASHBOARD_API_URL="$(get_output DashboardApiUrl)"
USER_POOL_ID="$(get_output UserPoolId)"
CLIENT_ID="$(get_output UserPoolClientId)"
DOCUMENT_BUCKET="$(get_output DocumentStoreBucket)"
KB_BUCKET="$(get_output KnowledgeBaseBucket)"
PUBLIC_FRONTEND_BUCKET="$(get_output PublicFrontendBucket)"
PUBLIC_FRONTEND_DIST_ID="$(get_output PublicFrontendDistributionId)"
PUBLIC_FRONTEND_URL="$(get_output PublicFrontendUrl)"
ADMIN_FRONTEND_BUCKET="$(get_output AdminFrontendBucket)"
ADMIN_FRONTEND_DIST_ID="$(get_output AdminFrontendDistributionId)"
ADMIN_FRONTEND_URL="$(get_output AdminFrontendUrl)"

[[ -n "$CHAT_API_URL" && "$CHAT_API_URL" != "None" ]] || die "Could not read ChatApiUrl output"

# API Gateway URLs already end with a trailing slash; strip it for cleanliness.
CHAT_API_URL="${CHAT_API_URL%/}"
DASHBOARD_API_URL="${DASHBOARD_API_URL%/}"

echo
ok "Chat API URL:      $CHAT_API_URL"
ok "Dashboard API URL: $DASHBOARD_API_URL"
ok "User Pool ID:      $USER_POOL_ID"
ok "User Pool Client:  $CLIENT_ID"
ok "Document bucket:   $DOCUMENT_BUCKET"
ok "KB bucket:         $KB_BUCKET"
ok "Public bucket:     $PUBLIC_FRONTEND_BUCKET"
ok "Public URL:        $PUBLIC_FRONTEND_URL"
ok "Admin bucket:      $ADMIN_FRONTEND_BUCKET"
ok "Admin URL:         $ADMIN_FRONTEND_URL"
echo

# ── Write frontend/.env.local ────────────────────────────────────────────────
if [[ "$SKIP_FRONTEND_ENV" == "true" ]]; then
  warn "Skipping frontend/.env.local (--skip-frontend-env)"
else
  info "Writing $FRONTEND_ENV"
  cat > "$FRONTEND_ENV" <<EOF
# Generated by deploy.sh — points the frontend at the deployed
# $STACK_NAME stack ($REGION, prefix=${RESOURCE_PREFIX:-none}).
# Regenerate by re-running ./deploy.sh with the same deployment options.
NEXT_PUBLIC_API_URL=$CHAT_API_URL
NEXT_PUBLIC_DASHBOARD_API_URL=$DASHBOARD_API_URL
NEXT_PUBLIC_USER_POOL_ID=$USER_POOL_ID
NEXT_PUBLIC_CLIENT_ID=$CLIENT_ID
NEXT_PUBLIC_AWS_REGION=$REGION
EOF
  ok "Frontend environment written"
fi

# ── Seed admin user (optional) ───────────────────────────────────────────────
if [[ -n "$ADMIN_EMAIL" && -n "$ADMIN_PASSWORD" ]]; then
  info "Seeding admin user: $ADMIN_EMAIL"
  aws cognito-idp admin-create-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$ADMIN_EMAIL" \
    --user-attributes Name=email,Value="$ADMIN_EMAIL" Name=email_verified,Value=true \
    --message-action SUPPRESS "${AWS_ARGS[@]}" >/dev/null 2>&1 \
    || warn "User may already exist — continuing"
  aws cognito-idp admin-set-user-password \
    --user-pool-id "$USER_POOL_ID" \
    --username "$ADMIN_EMAIL" \
    --password "$ADMIN_PASSWORD" \
    --permanent "${AWS_ARGS[@]}"
  # Ensure the 'admin' group exists, then add the user to it.
  aws cognito-idp create-group \
    --user-pool-id "$USER_POOL_ID" --group-name admin "${AWS_ARGS[@]}" >/dev/null 2>&1 || true
  aws cognito-idp admin-add-user-to-group \
    --user-pool-id "$USER_POOL_ID" --username "$ADMIN_EMAIL" --group-name admin "${AWS_ARGS[@]}"
  ok "Admin user ready (group: admin)"
else
  warn "No admin user seeded (pass --admin-email and --admin-password to seed one)"
fi

# ── Ingest documents (optional) ──────────────────────────────────────────────
if [[ -n "$INGEST_DIR" ]]; then
  [[ -d "$INGEST_DIR" ]] || die "Ingest directory not found: $INGEST_DIR"
  info "Syncing documents from $INGEST_DIR to s3://$DOCUMENT_BUCKET/uploads/"
  aws s3 sync "$INGEST_DIR" "s3://$DOCUMENT_BUCKET/uploads/" "${AWS_ARGS[@]}"
  ok "Documents uploaded (S3 event triggers doc-processor → KB ingestion)"
fi

# ── Build & publish frontend to CloudFront/S3 ────────────────────────────────
# Requires frontend/.env.local (written above unless --skip-frontend-env), since
# NEXT_PUBLIC_* values are baked in at build time for the static export.
if [[ -n "$PUBLIC_FRONTEND_BUCKET" && "$PUBLIC_FRONTEND_BUCKET" != "None" && \
      -n "$ADMIN_FRONTEND_BUCKET" && "$ADMIN_FRONTEND_BUCKET" != "None" ]]; then
  info "Building frontend (Next.js static export)"
  ( cd "$SCRIPT_DIR/frontend" && ( npm ci --silent || npm install --silent ) && npm run build )
  [[ -d "$SCRIPT_DIR/frontend/out" ]] || die "Frontend build did not produce frontend/out (is output:'export' set?)"

  info "Publishing public chat → s3://$PUBLIC_FRONTEND_BUCKET"
  aws s3 sync "$SCRIPT_DIR/frontend/out" "s3://$PUBLIC_FRONTEND_BUCKET" \
    --delete --exclude "dashboard/*" --exclude "login/*" "${AWS_ARGS[@]}"
  # Defense in depth for a bucket that may have existed before the surfaces
  # were split. These exact prefixes must never be present on the public origin.
  aws s3 rm "s3://$PUBLIC_FRONTEND_BUCKET/dashboard/" --recursive "${AWS_ARGS[@]}"
  aws s3 rm "s3://$PUBLIC_FRONTEND_BUCKET/login/" --recursive "${AWS_ARGS[@]}"

  info "Publishing admin dashboard → s3://$ADMIN_FRONTEND_BUCKET"
  aws s3 sync "$SCRIPT_DIR/frontend/out" "s3://$ADMIN_FRONTEND_BUCKET" \
    --delete "${AWS_ARGS[@]}"

  if [[ -n "$PUBLIC_FRONTEND_DIST_ID" && "$PUBLIC_FRONTEND_DIST_ID" != "None" ]]; then
    info "Invalidating public CloudFront distribution $PUBLIC_FRONTEND_DIST_ID"
    aws cloudfront create-invalidation \
      --distribution-id "$PUBLIC_FRONTEND_DIST_ID" --paths "/*" "${AWS_ARGS[@]}" >/dev/null
  fi
  if [[ -n "$ADMIN_FRONTEND_DIST_ID" && "$ADMIN_FRONTEND_DIST_ID" != "None" ]]; then
    info "Invalidating admin CloudFront distribution $ADMIN_FRONTEND_DIST_ID"
    aws cloudfront create-invalidation \
      --distribution-id "$ADMIN_FRONTEND_DIST_ID" --paths "/*" "${AWS_ARGS[@]}" >/dev/null
  fi
  ok "Public and admin frontends published to isolated origins"
else
  warn "Missing frontend bucket output — skipping frontend publish"
fi

echo
ok "Deploy complete."
if [[ -n "$PUBLIC_FRONTEND_URL" && "$PUBLIC_FRONTEND_URL" != "None" ]]; then
  echo "Public chat: ${GREEN}$PUBLIC_FRONTEND_URL${NC}"
fi
if [[ -n "$ADMIN_FRONTEND_URL" && "$ADMIN_FRONTEND_URL" != "None" ]]; then
  echo "Admin dashboard: ${GREEN}$ADMIN_FRONTEND_URL${NC}"
fi
echo "Local dev: cd frontend && npm install && npm run dev"
