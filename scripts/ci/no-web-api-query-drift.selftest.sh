#!/usr/bin/env bash
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/no-web-api-query-drift.ts"
fixtures="$dir/__fixtures__/web-api-query-drift"
failed=0

expect_accept() {
  local name="$1" needle="$2" out rc
  out="$(GUARD_ROOT="$fixtures/$name" bun "$gate" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ] || ! grep -qF -- "$needle" <<<"$out"; then
    echo "FAIL: $name expected success containing '$needle' (rc=$rc)"
    echo "$out"
    failed=1
  fi
}

expect_reject() {
  local name="$1" needle="$2" out rc
  out="$(GUARD_ROOT="$fixtures/$name" bun "$gate" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ] || ! grep -qF -- "$needle" <<<"$out"; then
    echo "FAIL: $name expected rejection containing '$needle' (rc=$rc)"
    echo "$out"
    failed=1
  fi
}

expect_reject_all() {
  local name="$1" out rc needle
  shift
  out="$(GUARD_ROOT="$fixtures/$name" bun "$gate" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "FAIL: $name expected rejection (rc=$rc)"
    echo "$out"
    failed=1
    return
  fi
  for needle in "$@"; do
    if ! grep -qF -- "$needle" <<<"$out"; then
      echo "FAIL: $name expected rejection containing '$needle' (rc=$rc)"
      echo "$out"
      failed=1
    fi
  done
}

expect_accept pass 'query-bearing HTTP API sites: 2; sent keys: 3'
expect_reject undeclared 'apps/web/src/features/backtest/api/backtest.ts:4 POST /api/accounts/{}/profiles/{}/backtests sends undeclared query key "unknownKey"; API operation: apps/api/src/routes/backtests.ts'
expect_reject_all unsupported \
  'unsupported default API helper import' \
  'unsupported apiFetch import alias' \
  'unsupported API helper namespace import' \
  'unsupported indirect apiFetch reference' \
  'unsupported indirect global fetch reference' \
  'legacy.jsx:1 unsupported indirect global fetch reference' \
  'query must be an inline object literal' \
  'query must be an explicit inline object literal' \
  'computed query keys are unsupported' \
  'spread query keys are unsupported' \
  'query-bearing apiFetch requires an explicit literal HTTP method' \
  'API path must be a direct static path expression' \
  'raw query strings are unsupported' \
  'URLSearchParams is unsupported' \
  'URL.searchParams mutation is unsupported' \
  'raw fetch URL must be an inline query-free literal or template' \
  'alternate API navigation sink is unsupported' \
  'alternate API download URL is unsupported'
expect_reject narrowed 'scan did not reach apps/web/src/main.tsx'
expect_reject empty-walk 'scan matched no web runtime source files under apps/web/src'
expect_reject vacuous 'zero query-bearing HTTP API sites found'

if [ "$failed" -ne 0 ]; then
  echo 'no-web-api-query-drift self-test: FAILED'
  exit 1
fi
echo 'no-web-api-query-drift self-test: OK'
