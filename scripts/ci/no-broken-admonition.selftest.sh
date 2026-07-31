#!/usr/bin/env bash
# Self-test for no-broken-admonition.sh. Drives the real gate over a known-good
# and a known-bad fixture tree via the GUARD_ROOT override and asserts
# pass-root exits 0 (a fenced `!!!` and an indented `???+` are not flagged),
# fail-root exits non-zero (a flush-left `???+` body is flagged). Guards the
# gate's fence-tracking and `???+` marker handling against regression.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/no-broken-admonition.sh"
pass_root="$dir/__fixtures__/admonition/pass"
fail_root="$dir/__fixtures__/admonition/fail"

fails=0

GUARD_ROOT="$pass_root" bash "$gate" >/dev/null 2>&1
pass_rc=$?
if [ "$pass_rc" -ne 0 ]; then
  echo "FAIL: pass fixture expected exit 0, got $pass_rc"
  fails=1
fi

# Assert the fail fixture is rejected for the RIGHT reason: a flush-left body.
# A bare non-zero check would also pass on the gate's vacuity guard (e.g. if the
# fixture were moved and zero docs were scanned), letting the self-test go green
# while exercising nothing.
fail_out="$(GUARD_ROOT="$fail_root" bash "$gate" 2>&1)"
fail_rc=$?
if [ "$fail_rc" -eq 0 ] || ! grep -q 'flush-left' <<<"$fail_out"; then
  echo "FAIL: fail fixture not flagged for the expected flush-left reason (rc=$fail_rc)"
  fails=1
fi

if [ "$fails" -ne 0 ]; then
  echo "no-broken-admonition self-test: RED"
  exit 1
fi

echo "no-broken-admonition self-test: OK"
