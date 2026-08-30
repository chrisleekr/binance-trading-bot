#!/usr/bin/env bash
# Self-test for no-stripped-err-log.sh. Drives the real gate over the fixture trees under __fixtures__/stripped-err-log/ via the GUARD_ROOT override, so what is proven is the shipping gate and not a copy of it.
#
# Scope is the two walk stops, which is what this gate had no way to prove before: apps/ going dark still leaves the impure packages to keep a union floor healthy, while every logger call site in the three apps — which is where nearly all of them live — goes unread.
#
# There is no `pass` fixture here on purpose. The gate runs over the real tree on every lint pass and must exit 0 there, so the accepting case is already driven against the anchors that matter — a fixture copy of it would only pin a second tree nobody edits.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/no-stripped-err-log.sh"

fails=0

# ---------------------------------------------------------------------------
# The two walk stops. A count is not evidence: these are the two shapes a walk fails in, and only one of them is visible to a floor.
# ---------------------------------------------------------------------------
# Each asserts its OWN diagnostic rather than a bare non-zero exit. The gate exits 1 for a real violation, for a walk that returned nothing and for a walk that no longer reaches its anchor alike, so only the sentence says which branch ran — and a fixture that moved would otherwise trip a different branch and read as a successful catch.

# A tree with none of the scanned roots present: the walk returns nothing and the floor every gate already carried is what catches it.
empty_walk_out="$(GUARD_ROOT="$dir/__fixtures__/stripped-err-log/reject-empty-walk" bash "$gate" 2>&1)"
empty_walk_rc=$?
if [ "$empty_walk_rc" -eq 0 ] || ! grep -qF 'scan matched no .ts files under apps, packages —' <<<"$empty_walk_out"; then
  echo "FAIL: reject-empty-walk expected the zero-file stop (rc=$empty_walk_rc)"
  echo "$empty_walk_out"
  fails=1
fi

# Files under the scanned roots, but the module this rule is anchored on no longer reached. The walk still returns a healthy count, which is precisely what a floor reads as a clean tree.
narrowed_walk_out="$(GUARD_ROOT="$dir/__fixtures__/stripped-err-log/reject-narrowed-walk" bash "$gate" 2>&1)"
narrowed_walk_rc=$?
if [ "$narrowed_walk_rc" -eq 0 ] || ! grep -qF 'walk narrowed' <<<"$narrowed_walk_out" || ! grep -qF 'packages/binance/src/binance-rest.ts' <<<"$narrowed_walk_out"; then
  echo "FAIL: reject-narrowed-walk expected the anchor stop naming packages/binance/src/binance-rest.ts (rc=$narrowed_walk_rc)"
  echo "$narrowed_walk_out"
  fails=1
fi

if [ "$fails" -ne 0 ]; then
  echo "no-stripped-err-log self-test: FAILED"
  exit 1
fi
echo "no-stripped-err-log self-test: OK"
