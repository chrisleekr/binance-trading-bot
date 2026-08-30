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


# ---------------------------------------------------------------------------
# The two walk stops. A count is not evidence: these are the two shapes a walk fails in, and only one of them is visible to a floor.
# ---------------------------------------------------------------------------
# Each asserts its OWN diagnostic rather than a bare non-zero exit. The gate exits 1 for a real violation, for a walk that returned nothing and for a walk that no longer reaches its anchor alike, so only the sentence says which branch ran — and a fixture that moved would otherwise trip a different branch and read as a successful catch.

# A tree with no docs/ at all: the walk returns nothing and the floor every gate already carried is what catches it.
empty_walk_out="$(GUARD_ROOT="$dir/__fixtures__/admonition/reject-empty-walk" bash "$gate" 2>&1)"
empty_walk_rc=$?
if [ "$empty_walk_rc" -eq 0 ] || ! grep -qF 'scan matched no markdown files under docs —' <<<"$empty_walk_out"; then
  echo "FAIL: reject-empty-walk expected the zero-file stop (rc=$empty_walk_rc)"
  echo "$empty_walk_out"
  fails=1
fi

# Pages under docs/ but not the one this rule is anchored on. The walk still returns files, so a floor is satisfied and the gate would print a confident count over a tree it no longer reads.
narrowed_walk_out="$(GUARD_ROOT="$dir/__fixtures__/admonition/reject-narrowed-walk" bash "$gate" 2>&1)"
narrowed_walk_rc=$?
if [ "$narrowed_walk_rc" -eq 0 ] || ! grep -qF 'walk narrowed' <<<"$narrowed_walk_out" || ! grep -qF 'docs/index.md' <<<"$narrowed_walk_out"; then
  echo "FAIL: reject-narrowed-walk expected the anchor stop naming docs/index.md (rc=$narrowed_walk_rc)"
  echo "$narrowed_walk_out"
  fails=1
fi

if [ "$fails" -ne 0 ]; then
  echo "no-broken-admonition self-test: RED"
  exit 1
fi

echo "no-broken-admonition self-test: OK"
