#!/usr/bin/env bash
# Self-test for no-stale-screenshot.sh. Drives the real gate over fixture trees
# via the GUARD_ROOT override and asserts each of its four drift branches fires
# for its own reason — matching its full label, not merely a non-zero exit. A
# bare exit-code check would also be satisfied by the gate's vacuity guard, and a
# partial substring is shared between two of the branches, so either shortcut
# would let this go green while exercising nothing.
#
# Fixtures are built in a temp dir rather than committed: they need `.png` files,
# and `.gitignore` excludes every PNG outside `docs/assets/screenshots/`.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/no-stale-screenshot.sh"
tmp="$(mktemp -d -t no-stale-screenshot-selftest.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

fails=0

# Build one fixture root: $1 root, $2 manifest destinations (JS array body),
# $3 committed PNG names (space-separated), $4 destinations embedded by a doc.
make_root() {
  local root="$1" manifest_dests="$2" committed="$3" embedded="$4"
  mkdir -p "$root/docs/assets/screenshots/user-guide" "$root/e2e"
  {
    echo "export const SHOTS = ["
    echo "  { name: 'shot', route: '{acc}', dest: [$manifest_dests] },"
    echo "];"
  } >"$root/e2e/docs-screenshots.manifest.mjs"
  for png in $committed; do
    : >"$root/docs/assets/screenshots/$png"
  done
  {
    echo "# Fixture"
    for dest in $embedded; do
      echo "![shot](../../assets/screenshots/$dest)"
      echo ""
      echo "_A fixture screen. Seeded demo data, not a real account._"
    done
  } >"$root/docs/page.md"
}

# Assert the gate's outcome for a fixture: $1 label, $2 root, $3 expected rc
# (0 or 1), $4 substring the output must contain (empty when expecting a pass).
assert_gate() {
  local label="$1" root="$2" want_rc="$3" want_msg="$4" out rc
  out="$(GUARD_ROOT="$root" bash "$gate" 2>&1)"
  rc=$?
  if [ "$want_rc" -eq 0 ]; then
    if [ "$rc" -ne 0 ]; then
      echo "FAIL: $label expected exit 0, got $rc"
      echo "$out"
      fails=1
    fi
    return
  fi
  if [ "$rc" -eq 0 ] || ! grep -q "$want_msg" <<<"$out"; then
    echo "FAIL: $label not flagged for the expected reason \"$want_msg\" (rc=$rc)"
    echo "$out"
    fails=1
  fi
}

# Everything agrees: manifest declares it, it is committed, a page embeds it.
make_root "$tmp/pass" "'user-guide/a.png'" "user-guide/a.png" "user-guide/a.png"
assert_gate "pass fixture" "$tmp/pass" 0 ""

# A page embeds a PNG nobody committed. The label is asserted in full: both this
# branch and the manifest-declared one contain the words "not committed", so a
# substring match would still pass if either were deleted from the gate.
make_root "$tmp/missing" "'user-guide/a.png'" "" "user-guide/a.png"
assert_gate "missing fixture" "$tmp/missing" 1 "Embedded by a docs page but not committed"

# A manifest destination that is neither committed nor embedded, isolating the
# manifest branch — the other three stay quiet because a.png agrees everywhere.
make_root "$tmp/promised" "'user-guide/a.png', 'user-guide/b.png'" "user-guide/a.png" \
  "user-guide/a.png"
assert_gate "promised fixture" "$tmp/promised" 1 "Declared in the capture manifest but not committed"

# A committed, embedded PNG that no capture writes — it can never be refreshed.
make_root "$tmp/uncaptured" "'user-guide/b.png'" "user-guide/a.png user-guide/b.png" \
  "user-guide/a.png user-guide/b.png"
assert_gate "uncaptured fixture" "$tmp/uncaptured" 1 "no capture writes it"

# A committed PNG no page embeds.
make_root "$tmp/orphan" "'user-guide/a.png'" "user-guide/a.png user-guide/orphan.png" \
  "user-guide/a.png"
assert_gate "orphan fixture" "$tmp/orphan" 1 "embedded by no docs page"

# An embed whose caption does not disclose the data is seeded. Built by stripping
# the disclosure back out of the passing fixture, so this asserts the caption
# check alone — every other branch stays quiet.
make_root "$tmp/undisclosed" "'user-guide/a.png'" "user-guide/a.png" "user-guide/a.png"
{
  echo "# Fixture"
  echo "![shot](../../assets/screenshots/user-guide/a.png)"
  echo ""
  echo "_A fixture screen._"
} >"$tmp/undisclosed/docs/page.md"
assert_gate "undisclosed fixture" "$tmp/undisclosed" 1 "without a caption saying the data is seeded"

if [ "$fails" -ne 0 ]; then
  echo "no-stale-screenshot self-test: RED"
  exit 1
fi

echo "no-stale-screenshot self-test: OK"
