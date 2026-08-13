#!/usr/bin/env bash
# Proves the env gate checks runtime reads back to ENV_CATALOGUE with an exact,
# reviewed exclusion set. Fixtures contain no dependencies and require no infra.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/no-phantom-env-var.sh"
fixtures="$dir/__fixtures__/env-catalogue"
fails=0

expect_reject() {
  local name="$1"; shift
  local out rc needle
  out="$(GUARD_ROOT="$fixtures/$name" bash "$gate" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "FAIL: $name expected a non-zero exit, got 0"
    fails=1
    return
  fi
  for needle in "$@"; do
    if ! grep -qF -- "$needle" <<<"$out"; then
      echo "FAIL: $name rejected without '$needle' evidence"
      fails=1
    fi
  done
}

expect_accept() {
  local name="$1" out rc
  out="$(GUARD_ROOT="$fixtures/$name" bash "$gate" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "FAIL: $name expected exit 0, got $rc"
    fails=1
  fi
}

expect_reject supported-reads \
  'DIRECT_UNDOCUMENTED' 'BRACKET_UNDOCUMENTED' 'ALIAS_UNDOCUMENTED' \
  'CAST_META_UNDOCUMENTED' 'CAST_BEFORE_META_UNDOCUMENTED' \
  'DESTRUCTURED_UNDOCUMENTED' 'AFTER_SHADOW_UNDOCUMENTED' \
  'apps/api/src/read-env.ts'
expect_accept exact-exclusions
expect_reject exclusion-near-miss \
  'API_PROXY_TARGET' 'apps/api/src/read-env.ts'
expect_reject vacuous 'zero environment reads'
expect_reject dynamic-read 'dynamic environment read is not supported' 'apps/api/src/read-env.ts'

if [ "$fails" -ne 0 ]; then
  echo 'no-phantom-env-var self-test: RED'
  exit 1
fi

echo 'no-phantom-env-var self-test: OK'
