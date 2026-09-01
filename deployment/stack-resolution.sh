#!/usr/bin/env bash

# Pure stack-selection helpers shared by deploy.sh and its regression tests.
# AWS lookups remain in deploy.sh so these rules can be tested without an AWS
# account.

GCC_CURRENT_STACK_NAME="GrandCanyonCouncilChatbot"
GCC_LEGACY_STACK_NAME="ScoutingAmericaChatbot"

gcc_is_supported_stack_name() {
  case "${1:-}" in
    "$GCC_CURRENT_STACK_NAME"|"$GCC_LEGACY_STACK_NAME") return 0 ;;
    *) return 1 ;;
  esac
}

gcc_stack_status_kind() {
  case "${1:-}" in
    "") echo "missing" ;;
    CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE|IMPORT_COMPLETE|IMPORT_ROLLBACK_COMPLETE)
      echo "deployable" ;;
    REVIEW_IN_PROGRESS) echo "review" ;;
    *) echo "blocked" ;;
  esac
}

# Prints "<stack-name>|<existing-status-or-NEW>" on success.
# Arguments: requested stack (empty for automatic), current status, legacy status.
gcc_resolve_stack_name() {
  local requested="${1:-}"
  local current_status="${2:-}"
  local legacy_status="${3:-}"
  local requested_status=""
  local other_status=""
  local requested_kind=""

  if [[ -n "$requested" ]]; then
    if ! gcc_is_supported_stack_name "$requested"; then
      echo "Unsupported stack name '$requested'. Use $GCC_CURRENT_STACK_NAME or $GCC_LEGACY_STACK_NAME." >&2
      return 1
    fi

    if [[ "$requested" == "$GCC_CURRENT_STACK_NAME" ]]; then
      requested_status="$current_status"
      other_status="$legacy_status"
    else
      requested_status="$legacy_status"
      other_status="$current_status"
    fi
    requested_kind="$(gcc_stack_status_kind "$requested_status")"

    case "$requested_kind" in
      deployable)
        printf '%s|%s\n' "$requested" "$requested_status"
        return 0
        ;;
      missing)
        if [[ -n "$other_status" ]]; then
          echo "Requested stack $requested does not exist, but the other supported stack has status $other_status. Target the existing stack instead." >&2
          return 1
        fi
        printf '%s|NEW\n' "$requested"
        return 0
        ;;
      review)
        echo "Stack $requested is REVIEW_IN_PROGRESS from an incomplete deployment. Inspect it before retrying; deploy.sh will not assume ownership." >&2
        return 1
        ;;
      *)
        echo "Stack $requested is not safe to update while its status is $requested_status." >&2
        return 1
        ;;
    esac
  fi

  local current_kind
  local legacy_kind
  current_kind="$(gcc_stack_status_kind "$current_status")"
  legacy_kind="$(gcc_stack_status_kind "$legacy_status")"

  if [[ "$current_kind" == "blocked" ]]; then
    echo "Stack $GCC_CURRENT_STACK_NAME is not safe to update while its status is $current_status." >&2
    return 1
  fi
  if [[ "$legacy_kind" == "blocked" ]]; then
    echo "Stack $GCC_LEGACY_STACK_NAME is not safe to update while its status is $legacy_status." >&2
    return 1
  fi

  if [[ "$current_kind" == "deployable" && "$legacy_kind" == "deployable" ]]; then
    echo "Both supported stacks exist. Re-run with --stack-name after confirming which stack owns this environment." >&2
    return 1
  fi
  if [[ "$current_kind" == "deployable" ]]; then
    printf '%s|%s\n' "$GCC_CURRENT_STACK_NAME" "$current_status"
    return 0
  fi
  if [[ "$legacy_kind" == "deployable" ]]; then
    printf '%s|%s\n' "$GCC_LEGACY_STACK_NAME" "$legacy_status"
    return 0
  fi

  if [[ "$current_kind" == "review" || "$legacy_kind" == "review" ]]; then
    echo "An incomplete REVIEW_IN_PROGRESS stack exists and no deployable GCC stack was found. Inspect that stack before retrying; deploy.sh will not assume ownership." >&2
    return 1
  fi

  printf '%s|NEW\n' "$GCC_CURRENT_STACK_NAME"
}
