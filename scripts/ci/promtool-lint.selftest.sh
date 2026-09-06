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

# The base PATH ships a real sha256sum on linux and a real shasum on macOS, so a fixture
# that must prove a digest-tool fallback needs a PATH assembled from an explicit tool list
# rather than one that merely shadows names.
strict_bin="$dir/.promtool-strict-bin"
build_strict_bin() {
  rm -rf "$strict_bin"
  mkdir -p "$strict_bin"
  local tool resolved
  for tool in awk bash chmod cp date dirname find grep mkdir rm sort tr; do
    resolved="$(PATH="$base_path" command -v "$tool" 2>/dev/null || true)"
    if [ -z "$resolved" ]; then
      echo "FAIL: cannot assemble a digest-tool fixture PATH without $tool"
      return 1
    fi
    ln -sf "$resolved" "$strict_bin/$tool"
  done
}

# run_gate <name> <cache fixture or -> <shim dir> <download payload> <binary the tar shim
# extracts> <PATH tail> <1 to make the curl shim fail>. Leaves the promtool call log, the
# tar call log and the surviving cache listing beside the self-test for assertions.
run_gate() {
  local name="$1" cache_fixture="$2" shim="$3" payload="$4" extracted="$5" path_tail="$6" curl_fails="${7:-0}"
  local tmp="$dir/.promtool-$name"
  rm -f "$dir/.promtool-last.calls" "$dir/.promtool-last.tar" "$dir/.promtool-last.cache"
  rm -rf "$tmp"
  mkdir -p "$tmp/node_modules/.cache/promtool-3.4.1"
  cp -R "$fixtures/complete/." "$tmp/"
  if [ "$cache_fixture" != '-' ]; then
    cp -R "$fixtures/$cache_fixture/." "$tmp/node_modules/.cache/promtool-3.4.1/"
  fi
  (
    cd "$tmp" || exit 97
    PATH="$fixtures/$shim:$path_tail" PROMTOOL_CALL_LOG="$tmp/promtool.calls" \
      PROMTOOL_CURL_FAIL="$curl_fails" PROMTOOL_DOWNLOAD_ARCHIVE="$fixtures/$payload" \
      PROMTOOL_GOOD_BIN="$fixtures/$extracted" PROMTOOL_TAR_LOG="$tmp/tar.calls" bash "$gate"
  )
  local rc=$?
  cp "$tmp/promtool.calls" "$dir/.promtool-last.calls" 2>/dev/null || true
  cp "$tmp/tar.calls" "$dir/.promtool-last.tar" 2>/dev/null || true
  ls -A "$tmp/node_modules/.cache/promtool-3.4.1" >"$dir/.promtool-last.cache" 2>/dev/null || true
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

# A warm run must prove what it is about to execute without re-reading an archive, so the
# cached executable carries the pin. Nothing is fetched and nothing is extracted.
warm_hit_out="$(run_gate warm-hit cache-valid-executable integrity-bin download-archives/valid.tgz good-promtool "$base_path" 2>&1)"
warm_hit_rc=$?
warm_hit_calls="$(cat "$dir/.promtool-last.calls" 2>/dev/null || true)"
warm_hit_tar="$(cat "$dir/.promtool-last.tar" 2>/dev/null || true)"
warm_hit_cache="$(cat "$dir/.promtool-last.cache" 2>/dev/null || true)"
if [ "$warm_hit_rc" -ne 0 ]; then
  echo "FAIL: a cached executable matching the pin was not reused (rc=$warm_hit_rc)"
  echo "$warm_hit_out"
  fails=1
elif grep -qF 'NETWORK CALLED' <<<"$warm_hit_out" || [ -n "$warm_hit_tar" ]; then
  echo 'FAIL: a warm run re-fetched or re-extracted an archive it did not need'
  fails=1
elif ! grep -qF 'check rules' <<<"$warm_hit_calls" || ! grep -qF 'test rules' <<<"$warm_hit_calls"; then
  echo 'FAIL: the reused cached executable did not run both validations'
  fails=1
elif [ "$warm_hit_cache" != 'promtool' ]; then
  echo "FAIL: a warm run left something other than the executable in the cache ($warm_hit_cache)"
  fails=1
fi

# A cached executable that fails the pin is the case that used to wedge the gate forever.
# It must be discarded and refetched, not re-verified into the same failure every run.
warm_repair_out="$(run_gate warm-repair cache-tampered-executable cold-download-bin download-archives/valid.tgz good-promtool "$base_path" 2>&1)"
warm_repair_rc=$?
warm_repair_calls="$(cat "$dir/.promtool-last.calls" 2>/dev/null || true)"
warm_repair_tar="$(cat "$dir/.promtool-last.tar" 2>/dev/null || true)"
if [ "$warm_repair_rc" -ne 0 ]; then
  echo "FAIL: a tampered cached executable was not replaced from a verified download (rc=$warm_repair_rc)"
  echo "$warm_repair_out"
  fails=1
elif [ "$warm_repair_tar" != 'tar' ]; then
  echo 'FAIL: a tampered cached executable was accepted without a fresh extraction'
  fails=1
elif grep -qF 'TAMPERED EXECUTABLE RAN' <<<"$warm_repair_out"; then
  echo 'FAIL: the tampered cached executable ran'
  fails=1
elif ! grep -qF 'check rules' <<<"$warm_repair_calls" || ! grep -qF 'test rules' <<<"$warm_repair_calls"; then
  echo 'FAIL: the replaced executable did not run both validations'
  fails=1
fi

cold_valid_out="$(run_gate cold-valid - cold-download-bin download-archives/valid.tgz good-promtool "$base_path" 2>&1)"
cold_valid_rc=$?
cold_valid_calls="$(cat "$dir/.promtool-last.calls" 2>/dev/null || true)"
cold_valid_tar="$(cat "$dir/.promtool-last.tar" 2>/dev/null || true)"
cold_valid_cache="$(cat "$dir/.promtool-last.cache" 2>/dev/null || true)"
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
elif [ "$cold_valid_cache" != 'promtool' ]; then
  # node_modules is one shared CI cache slot. A retained ~117MB tarball is pushed once and
  # then pulled by every later job in the pipeline.
  echo "FAIL: a cold run left the release archive in the shared cache ($cold_valid_cache)"
  fails=1
fi

# curl fails here so the rejection is proven on the wget path the alpine lane actually takes.
cold_bad_out="$(run_gate cold-bad - cold-download-bin download-archives/tampered.tgz good-promtool "$base_path" 1 2>&1)"
cold_bad_rc=$?
cold_bad_calls="$(cat "$dir/.promtool-last.calls" 2>/dev/null || true)"
cold_bad_tar="$(cat "$dir/.promtool-last.tar" 2>/dev/null || true)"
cold_bad_cache="$(cat "$dir/.promtool-last.cache" 2>/dev/null || true)"
if [ "$cold_bad_rc" -eq 0 ]; then
  echo 'FAIL: a mismatched cold archive was accepted'
  fails=1
elif ! grep -qF 'checksum mismatch' <<<"$cold_bad_out"; then
  echo 'FAIL: a mismatched cold archive failed without checksum-mismatch evidence'
  fails=1
elif [ -n "$cold_bad_tar" ] || [ -n "$cold_bad_calls" ]; then
  echo 'FAIL: a mismatched cold archive reached extraction or execution before rejection'
  fails=1
elif [ -n "$cold_bad_cache" ]; then
  echo "FAIL: a rejected archive was left in the cache for the next run to re-reject ($cold_bad_cache)"
  fails=1
fi

# The archive digest only covers the bytes on the wire. What runs is the extracted file, so
# it carries its own pin.
bad_binary_out="$(run_gate bad-binary - cold-download-bin download-archives/valid.tgz cache-tampered-executable/promtool "$base_path" 2>&1)"
bad_binary_rc=$?
bad_binary_calls="$(cat "$dir/.promtool-last.calls" 2>/dev/null || true)"
bad_binary_cache="$(cat "$dir/.promtool-last.cache" 2>/dev/null || true)"
if [ "$bad_binary_rc" -eq 0 ]; then
  echo 'FAIL: an executable that does not match its pin was accepted out of a verified archive'
  fails=1
elif ! grep -qF 'extracted binary checksum mismatch' <<<"$bad_binary_out"; then
  echo 'FAIL: a mismatched extracted executable failed without binary-checksum evidence'
  fails=1
elif [ -n "$bad_binary_calls" ]; then
  echo 'FAIL: a mismatched extracted executable was run anyway'
  fails=1
elif [ -n "$bad_binary_cache" ]; then
  echo "FAIL: a rejected executable was left in the cache ($bad_binary_cache)"
  fails=1
fi

if build_strict_bin; then
  # macOS ships shasum and no sha256sum, so the fallback is the only path a developer run
  # takes. It is unreachable on a PATH that still carries the linux tool.
  shasum_out="$(run_gate shasum-fallback - shasum-bin download-archives/valid.tgz good-promtool "$strict_bin" 2>&1)"
  shasum_rc=$?
  shasum_calls="$(cat "$dir/.promtool-last.calls" 2>/dev/null || true)"
  if [ "$shasum_rc" -ne 0 ]; then
    echo "FAIL: the shasum fallback did not verify and run the extracted executable (rc=$shasum_rc)"
    echo "$shasum_out"
    fails=1
  elif ! grep -qF 'check rules' <<<"$shasum_calls" || ! grep -qF 'test rules' <<<"$shasum_calls"; then
    echo 'FAIL: the shasum fallback ran the gate without both validations'
    fails=1
  fi

  # Refusing before the fetch is the point: a host that cannot verify must not spend the
  # download only to throw the bytes away unverified.
  no_digest_out="$(run_gate no-digest-tool - no-digest-bin download-archives/valid.tgz good-promtool "$strict_bin" 2>&1)"
  no_digest_rc=$?
  no_digest_tar="$(cat "$dir/.promtool-last.tar" 2>/dev/null || true)"
  if [ "$no_digest_rc" -eq 0 ]; then
    echo 'FAIL: the gate ran with no way to verify what it downloaded'
    fails=1
  elif ! grep -qF 'neither sha256sum nor shasum' <<<"$no_digest_out"; then
    echo 'FAIL: a host with no digest tool failed without naming the missing tools'
    fails=1
  elif grep -qF 'NETWORK CALLED' <<<"$no_digest_out" || [ -n "$no_digest_tar" ]; then
    echo 'FAIL: a host with no digest tool downloaded or extracted before refusing'
    fails=1
  fi
else
  fails=1
fi
rm -rf "$strict_bin"
rm -f "$dir/.promtool-last.calls" "$dir/.promtool-last.tar" "$dir/.promtool-last.cache"

expected_digests='07b0442f50aed883afbcc5ca3136ce45bef99aa73b7aa2e8fa4247b26f2d523f  prometheus-3.4.1.darwin-amd64.tar.gz
7a6372e2b6a1a498a6aa4e9936878ff8b42c9ed818305b915133600182e2051e  prometheus-3.4.1.darwin-arm64.tar.gz
09203151c132f36b004615de1a3dea22117ad17e6d7a59962e34f3abf328f312  prometheus-3.4.1.linux-amd64.tar.gz
2a85be1dff46238c0d799674e856c8629c8526168dd26c3de2cecfbfc6f9a0a2  prometheus-3.4.1.linux-arm64.tar.gz
fcff7d070c6fb96b2b0744448c236babd5a89484060b0193966e61a7dc01c4ea  prometheus-3.4.1.darwin-amd64/promtool
ecd398561f7ee26278f508f922d5d2c745b862e26e30873f052ecb516f623ccc  prometheus-3.4.1.darwin-arm64/promtool
15e75af9417292b58d8b116640a27c60c2b71c70da386887ad3b356fe5df75cd  prometheus-3.4.1.linux-amd64/promtool
ac164096721c34e18d1e187d26d0f39434b6ab0eba8c9a3838f3610b7c197717  prometheus-3.4.1.linux-arm64/promtool'
actual_digests="$(cat "$dir/prometheus-3.4.1.sha256" 2>/dev/null || true)"
if [ "$actual_digests" != "$expected_digests" ]; then
  echo 'FAIL: prometheus-3.4.1.sha256 does not match the archive and promtool digests of the four supported upstream releases'
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
