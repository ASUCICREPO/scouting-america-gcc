#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../stack-resolution.sh
source "$TEST_DIR/../stack-resolution.sh"

assert_resolution() {
  local expected="$1"
  shift
  local actual
  actual="$(gcc_resolve_stack_name "$@")"
  [[ "$actual" == "$expected" ]] || {
    echo "Expected '$expected', got '$actual'" >&2
    exit 1
  }
}

assert_failure() {
  if gcc_resolve_stack_name "$@" >/dev/null 2>&1; then
    echo "Expected stack resolution to fail for: $*" >&2
    exit 1
  fi
}

assert_resolution "GrandCanyonCouncilChatbot|NEW" "" "" ""
assert_resolution "GrandCanyonCouncilChatbot|UPDATE_COMPLETE" "" "UPDATE_COMPLETE" ""
assert_resolution "ScoutingAmericaChatbot|CREATE_COMPLETE" "" "" "CREATE_COMPLETE"
assert_resolution "ScoutingAmericaChatbot|UPDATE_ROLLBACK_COMPLETE" "" "REVIEW_IN_PROGRESS" "UPDATE_ROLLBACK_COMPLETE"
assert_resolution "GrandCanyonCouncilChatbot|CREATE_COMPLETE" "GrandCanyonCouncilChatbot" "CREATE_COMPLETE" "CREATE_COMPLETE"
assert_resolution "ScoutingAmericaChatbot|NEW" "ScoutingAmericaChatbot" "" ""

assert_failure "" "CREATE_COMPLETE" "UPDATE_COMPLETE"
assert_failure "" "REVIEW_IN_PROGRESS" ""
assert_failure "" "UPDATE_ROLLBACK_FAILED" ""
assert_failure "GrandCanyonCouncilChatbot" "" "CREATE_COMPLETE"
assert_failure "UnknownStack" "" ""

echo "Stack-resolution tests passed"
