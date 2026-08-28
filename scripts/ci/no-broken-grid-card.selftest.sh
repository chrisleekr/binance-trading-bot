#!/usr/bin/env bash
# Self-test for no-broken-grid-card.sh. Drives the real gate over a known-good
# and a known-bad fixture tree via the GUARD_ROOT override.
#
# pass-root must exit 0 over every legal shape the gate has to tolerate: a
# 4-space complex grid, a body-less simple grid, a multi-paragraph card, a grid
# nested inside an admonition (cards at 4, bodies at 8), a card wrapping its body
# in its own <div>, a lazily-continued card title, and a fenced code sample of
# the BROKEN form. fail-root must exit non-zero on the 2-space body prettier
# produces.
#
# Every shape in the pass fixture was rendered through Python-Markdown with the
# site extension set and confirmed to keep its body INSIDE the card; the fail
# fixture was confirmed to leak its body out. The fixtures assert what the
# renderer does, not what the spec suggests it should.
#
# Without this the gate could go vacuous — the docs corpus has a single card
# grid, so a scan-path or regex regression would look green forever.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/no-broken-grid-card.sh"
pass_root="$dir/__fixtures__/grid-card/pass"
fail_root="$dir/__fixtures__/grid-card/fail"

fails=0

pass_out="$(GUARD_ROOT="$pass_root" bash "$gate" 2>&1)"
pass_rc=$?
# Assert it actually SAW a grid: the pass fixture would also exit 0 if the open
# regex stopped matching, which is the vacuity this fixture exists to catch.
if [ "$pass_rc" -ne 0 ] || ! grep -q '6 card grid(s)' <<<"$pass_out"; then
  echo "FAIL: pass fixture expected exit 0 over 6 grids, got rc=$pass_rc: $pass_out"
  fails=1
fi

fail_out="$(GUARD_ROOT="$fail_root" bash "$gate" 2>&1)"
fail_rc=$?
if [ "$fail_rc" -eq 0 ] || ! grep -q 'under-indented' <<<"$fail_out"; then
  echo "FAIL: fail fixture not flagged for the expected under-indent reason (rc=$fail_rc)"
  fails=1
fi


# ---------------------------------------------------------------------------
# The two walk stops. A count is not evidence: these are the two shapes a walk fails in, and only one of them is visible to a floor.
# ---------------------------------------------------------------------------
# Each asserts its OWN diagnostic rather than a bare non-zero exit. The gate exits 1 for a real violation, for a walk that returned nothing and for a walk that no longer reaches its anchor alike, so only the sentence says which branch ran — and a fixture that moved would otherwise trip a different branch and read as a successful catch.

# A tree with no docs/ at all: the walk returns nothing and the floor every gate already carried is what catches it.
empty_walk_out="$(GUARD_ROOT="$dir/__fixtures__/grid-card/reject-empty-walk" bash "$gate" 2>&1)"
empty_walk_rc=$?
if [ "$empty_walk_rc" -eq 0 ] || ! grep -qF 'scan matched no markdown files under docs —' <<<"$empty_walk_out"; then
  echo "FAIL: reject-empty-walk expected the zero-file stop (rc=$empty_walk_rc)"
  echo "$empty_walk_out"
  fails=1
fi

# Pages under docs/ but not the one this rule is anchored on. The walk still returns files, so a floor is satisfied and the gate would print a confident count over a tree it no longer reads.
narrowed_walk_out="$(GUARD_ROOT="$dir/__fixtures__/grid-card/reject-narrowed-walk" bash "$gate" 2>&1)"
narrowed_walk_rc=$?
if [ "$narrowed_walk_rc" -eq 0 ] || ! grep -qF 'walk narrowed' <<<"$narrowed_walk_out" || ! grep -qF 'docs/index.md' <<<"$narrowed_walk_out"; then
  echo "FAIL: reject-narrowed-walk expected the anchor stop naming docs/index.md (rc=$narrowed_walk_rc)"
  echo "$narrowed_walk_out"
  fails=1
fi

if [ "$fails" -ne 0 ]; then
  echo "no-broken-grid-card self-test: RED"
  exit 1
fi

echo "no-broken-grid-card self-test: OK"
