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

if [ "$fails" -ne 0 ]; then
  echo "no-broken-grid-card self-test: RED"
  exit 1
fi

echo "no-broken-grid-card self-test: OK"
