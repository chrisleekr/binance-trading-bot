#!/usr/bin/env bash
# Self-test for no-stale-migration-doc.sh. Drives the real gate over the fixture trees under __fixtures__/migration-doc/ via the GUARD_ROOT override, so what is proven is the shipping gate and not a copy of it.
#
# This gate reads two sources that fail differently. The docs tree is a walk, so it can narrow while still returning pages; CLAUDE.md is a fixed path, so it can only vanish. All three refusals are driven below and each is asserted by its own sentence.
#
# There is no `pass` fixture here on purpose. The gate runs over the real tree on every lint pass and must exit 0 there, so the accepting case is already driven with the anchors that matter.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/no-stale-migration-doc.sh"

fails=0

# ---------------------------------------------------------------------------
# The two walk stops. A count is not evidence: these are the two shapes a walk fails in, and only one of them is visible to a floor.
# ---------------------------------------------------------------------------
# Each asserts its OWN diagnostic rather than a bare non-zero exit. The gate exits 1 for a real violation, for a walk that returned nothing and for a walk that no longer reaches its anchor alike, so only the sentence says which branch ran — and a fixture that moved would otherwise trip a different branch and read as a successful catch.

# A tree with no docs/ at all: the walk returns nothing and the floor every gate already carried is what catches it.
empty_walk_out="$(GUARD_ROOT="$dir/__fixtures__/migration-doc/reject-empty-walk" bash "$gate" 2>&1)"
empty_walk_rc=$?
if [ "$empty_walk_rc" -eq 0 ] || ! grep -qF 'scan matched no markdown files under docs —' <<<"$empty_walk_out"; then
  echo "FAIL: reject-empty-walk expected the zero-file stop (rc=$empty_walk_rc)"
  echo "$empty_walk_out"
  fails=1
fi

# Pages under docs/ but not the one this rule is anchored on. The walk still returns files, so a floor is satisfied and the gate would print a confident count over a tree it no longer reads.
narrowed_walk_out="$(GUARD_ROOT="$dir/__fixtures__/migration-doc/reject-narrowed-walk" bash "$gate" 2>&1)"
narrowed_walk_rc=$?
if [ "$narrowed_walk_rc" -eq 0 ] || ! grep -qF 'walk narrowed' <<<"$narrowed_walk_out" || ! grep -qF 'docs/index.md' <<<"$narrowed_walk_out"; then
  echo "FAIL: reject-narrowed-walk expected the anchor stop naming docs/index.md (rc=$narrowed_walk_rc)"
  echo "$narrowed_walk_out"
  fails=1
fi

# A healthy docs walk with the charter renamed away. The count of pages scanned is unchanged and every walk stop is satisfied, so nothing but this refusal can tell that the file stating the migration convention is no longer read.
charter_out="$(GUARD_ROOT="$dir/__fixtures__/migration-doc/reject-missing-charter" bash "$gate" 2>&1)"
charter_rc=$?
if [ "$charter_rc" -eq 0 ] || ! grep -qF 'CLAUDE.md not found' <<<"$charter_out"; then
  echo "FAIL: reject-missing-charter expected the charter refusal (rc=$charter_rc)"
  echo "$charter_out"
  fails=1
fi

if [ "$fails" -ne 0 ]; then
  echo "no-stale-migration-doc self-test: FAILED"
  exit 1
fi
echo "no-stale-migration-doc self-test: OK"
