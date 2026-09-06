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
  rm -f "$dir/.promtool-last.calls" "$dir/.promtool-last.tar"
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

run_cached_fixture() {
  local name="$1" cache_fixture="$2"
  local tmp="$dir/.promtool-$name"
  rm -f "$dir/.promtool-last.calls" "$dir/.promtool-last.tar"
  rm -rf "$tmp"
  mkdir -p "$tmp/node_modules/.cache/promtool-3.4.1"
  cp -R "$fixtures/complete/." "$tmp/"
  cp -R "$fixtures/$cache_fixture/." "$tmp/node_modules/.cache/promtool-3.4.1/"
  (
    cd "$tmp" || exit 97
    PATH="$fixtures/integrity-bin:$base_path" PROMTOOL_CALL_LOG="$tmp/promtool.calls" PROMTOOL_GOOD_BIN="$fixtures/good-promtool" \
      PROMTOOL_TAR_LOG="$tmp/tar.calls" bash "$gate"
  )
  local rc=$?
  cp "$tmp/promtool.calls" "$dir/.promtool-last.calls" 2>/dev/null || true
  cp "$tmp/tar.calls" "$dir/.promtool-last.tar" 2>/dev/null || true
  rm -rf "$tmp"
  return "$rc"
}

run_cold_fixture() {
  local name="$1" archive_fixture="$2" curl_fails="$3"
  local tmp="$dir/.promtool-$name"
  rm -f "$dir/.promtool-last.calls" "$dir/.promtool-last.tar"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  cp -R "$fixtures/complete/." "$tmp/"
  (
    cd "$tmp" || exit 97
    PATH="$fixtures/cold-download-bin:$base_path" PROMTOOL_CALL_LOG="$tmp/promtool.calls" \
      PROMTOOL_CURL_FAIL="$curl_fails" PROMTOOL_DOWNLOAD_ARCHIVE="$fixtures/$archive_fixture/prom.tgz" \
      PROMTOOL_GOOD_BIN="$fixtures/good-promtool" PROMTOOL_TAR_LOG="$tmp/tar.calls" bash "$gate"
  )
  local rc=$?
  cp "$tmp/promtool.calls" "$dir/.promtool-last.calls" 2>/dev/null || true
  cp "$tmp/tar.calls" "$dir/.promtool-last.tar" 2>/dev/null || true
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
# The shim shadows BOTH fetchers. With only curl shadowed the case would pass on
# a host that has no curl anyway, and would never reach the wget branch that the
# alpine CI image actually takes.
expect_closed download-failure complete download-fail-bin 'cannot reach'
# `check rules` accepts an expression that can never evaluate true, so the rules
# unit tests are the only half of this gate that can catch a rule made silent by
# how Prometheus samples a counter. A deleted or renamed suite must fail the gate,
# not quietly reduce it to a syntax check.
expect_closed no-rule-tests no-tests promtool-bin 'no rule unit tests found'

unsupported_arch_out="$(run_fixture unsupported-arch complete unsupported-bin 2>&1)"
unsupported_arch_rc=$?
if [ "$unsupported_arch_rc" -eq 0 ] || ! grep -qF 'unsupported platform' <<<"$unsupported_arch_out"; then
  echo 'FAIL: unsupported architecture did not fail with an unsupported-platform diagnostic'
  fails=1
elif grep -qF 'NETWORK CALLED' <<<"$unsupported_arch_out"; then
  echo 'FAIL: unsupported architecture reached a network fetcher before failing'
  fails=1
fi

unsupported_os_out="$(run_fixture unsupported-os complete unsupported-os-bin 2>&1)"
unsupported_os_rc=$?
if [ "$unsupported_os_rc" -eq 0 ] || ! grep -qF 'unsupported platform' <<<"$unsupported_os_out"; then
  echo 'FAIL: unsupported OS did not fail with an unsupported-platform diagnostic'
  fails=1
elif grep -qF 'NETWORK CALLED' <<<"$unsupported_os_out"; then
  echo 'FAIL: unsupported OS reached a network fetcher before failing'
  fails=1
fi

tampered_archive_out="$(run_cached_fixture tampered-archive cache-tampered-archive 2>&1)"
tampered_archive_rc=$?
tampered_archive_calls="$(cat "$dir/.promtool-last.calls" 2>/dev/null || true)"
tampered_archive_tar="$(cat "$dir/.promtool-last.tar" 2>/dev/null || true)"
rm -f "$dir/.promtool-last.calls" "$dir/.promtool-last.tar"
if [ "$tampered_archive_rc" -eq 0 ]; then
  echo 'FAIL: a tampered warm archive was executed instead of rejected'
  fails=1
elif ! grep -qF 'checksum mismatch' <<<"$tampered_archive_out"; then
  echo 'FAIL: a tampered warm archive failed without checksum-mismatch evidence'
  fails=1
elif [ -n "$tampered_archive_tar" ] || [ -n "$tampered_archive_calls" ]; then
  echo 'FAIL: a tampered warm archive reached extraction or execution before rejection'
  fails=1
fi

restored_out="$(run_cached_fixture restore-executable cache-tampered-executable 2>&1)"
restored_rc=$?
restored_calls="$(cat "$dir/.promtool-last.calls" 2>/dev/null || true)"
rm -f "$dir/.promtool-last.calls" "$dir/.promtool-last.tar"
if [ "$restored_rc" -ne 0 ]; then
  echo "FAIL: a valid warm archive did not replace the tampered executable (rc=$restored_rc)"
  echo "$restored_out"
  fails=1
elif ! grep -qF 'check rules' <<<"$restored_calls" || ! grep -qF 'test rules' <<<"$restored_calls"; then
  echo 'FAIL: the executable restored from the verified archive did not run both validations'
  fails=1
fi

cold_valid_out="$(run_cold_fixture cold-valid cache-tampered-executable 0 2>&1)"
cold_valid_rc=$?
cold_valid_calls="$(cat "$dir/.promtool-last.calls" 2>/dev/null || true)"
cold_valid_tar="$(cat "$dir/.promtool-last.tar" 2>/dev/null || true)"
rm -f "$dir/.promtool-last.calls" "$dir/.promtool-last.tar"
if [ "$cold_valid_rc" -ne 0 ]; then
  echo "FAIL: a valid cold archive did not populate and execute the cache (rc=$cold_valid_rc)"
  echo "$cold_valid_out"
  fails=1
elif [ "$cold_valid_tar" != 'tar' ]; then
  echo 'FAIL: a verified cold archive was not extracted'
  fails=1
elif ! grep -qF 'check rules' <<<"$cold_valid_calls" || ! grep -qF 'test rules' <<<"$cold_valid_calls"; then
  echo 'FAIL: the executable extracted from a valid cold archive did not run both validations'
  fails=1
fi

cold_bad_out="$(run_cold_fixture cold-bad cache-tampered-archive 1 2>&1)"
cold_bad_rc=$?
cold_bad_calls="$(cat "$dir/.promtool-last.calls" 2>/dev/null || true)"
cold_bad_tar="$(cat "$dir/.promtool-last.tar" 2>/dev/null || true)"
rm -f "$dir/.promtool-last.calls" "$dir/.promtool-last.tar"
if [ "$cold_bad_rc" -eq 0 ]; then
  echo 'FAIL: a mismatched cold archive was accepted'
  fails=1
elif ! grep -qF 'checksum mismatch' <<<"$cold_bad_out"; then
  echo 'FAIL: a mismatched cold archive failed without checksum-mismatch evidence'
  fails=1
elif [ -n "$cold_bad_tar" ] || [ -n "$cold_bad_calls" ]; then
  echo 'FAIL: a mismatched cold archive reached extraction or execution before rejection'
  fails=1
fi

expected_digests='07b0442f50aed883afbcc5ca3136ce45bef99aa73b7aa2e8fa4247b26f2d523f  prometheus-3.4.1.darwin-amd64.tar.gz
7a6372e2b6a1a498a6aa4e9936878ff8b42c9ed818305b915133600182e2051e  prometheus-3.4.1.darwin-arm64.tar.gz
09203151c132f36b004615de1a3dea22117ad17e6d7a59962e34f3abf328f312  prometheus-3.4.1.linux-amd64.tar.gz
2a85be1dff46238c0d799674e856c8629c8526168dd26c3de2cecfbfc6f9a0a2  prometheus-3.4.1.linux-arm64.tar.gz'
actual_digests="$(cat "$dir/prometheus-3.4.1.sha256" 2>/dev/null || true)"
if [ "$actual_digests" != "$expected_digests" ]; then
  echo 'FAIL: prometheus-3.4.1.sha256 does not match the four supported upstream release digests'
  fails=1
fi

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
