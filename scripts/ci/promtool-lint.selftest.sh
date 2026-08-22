#!/usr/bin/env bash
# Proves promtool-lint fails closed and validates every discovered rules file.
# All runs use local fixtures and shims. This self-test never downloads a tool.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/promtool-lint.sh"
fixtures="$dir/__fixtures__/promtool"
base_path="/usr/bin:/bin:/usr/sbin:/sbin"
fails=0

run_fixture() {
  local name="$1" fixture="$2" shim="$3"
  local tmp="$dir/.promtool-$name"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  cp -R "$fixtures/$fixture/." "$tmp/"
  (
    cd "$tmp" || exit 97
    PATH="$fixtures/$shim:$base_path" PROMTOOL_CALL_LOG="$tmp/promtool.calls" \
      bash "$gate"
  )
  local rc=$?
  cp "$tmp/promtool.calls" "$dir/.promtool-last.calls" 2>/dev/null || true
  rm -rf "$tmp"
  return "$rc"
}

expect_closed() {
  local name="$1" fixture="$2" shim="$3" diagnostic="$4" out rc
  out="$(run_fixture "$name" "$fixture" "$shim" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "FAIL: $name returned success while validation was unavailable"
    fails=1
  elif ! grep -qF -- "$diagnostic" <<<"$out"; then
    echo "FAIL: $name failed without '$diagnostic' evidence"
    fails=1
  fi
}

expect_closed missing missing empty-bin 'not found'
expect_closed unsupported complete unsupported-bin 'unsupported arch'
# The shim shadows BOTH fetchers. With only curl shadowed the case would pass on
# a host that has no curl anyway, and would never reach the wget branch that the
# alpine CI image actually takes.
expect_closed download-failure complete download-fail-bin 'cannot reach'
# `check rules` accepts an expression that can never evaluate true, so the rules
# unit tests are the only half of this gate that can catch a rule made silent by
# how Prometheus samples a counter. A deleted or renamed suite must fail the gate,
# not quietly reduce it to a syntax check.
expect_closed no-rule-tests no-tests promtool-bin 'no rule unit tests found'

out="$(run_fixture complete complete promtool-bin 2>&1)"
rc=$?
calls="$(cat "$dir/.promtool-last.calls" 2>/dev/null || true)"
rm -f "$dir/.promtool-last.calls"
if [ "$rc" -ne 0 ]; then
  echo "FAIL: complete fixture failed before the promtool invocation (rc=$rc)"
  fails=1
elif ! grep -qF 'deploy/observability/alerts.yml' <<<"$calls" || \
  ! grep -qF 'deploy/observability/secondary.yaml' <<<"$calls"; then
  echo "FAIL: promtool did not receive the complete discovered rules-file set"
  fails=1
elif grep -qF 'deploy/observability/otel-collector.yaml' <<<"$calls"; then
  echo 'FAIL: promtool received YAML explicitly classified as non-rule configuration'
  fails=1
elif ! grep -qF 'test rules deploy/observability/tests/alerts.test.yml' <<<"$calls"; then
  echo 'FAIL: promtool was never asked to RUN the rules unit tests, only to parse the rules'
  fails=1
fi

if [ "$fails" -ne 0 ]; then
  echo 'promtool-lint self-test: RED'
  exit 1
fi

echo 'promtool-lint self-test: OK'
