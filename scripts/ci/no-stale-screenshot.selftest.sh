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
  # The anchor page the gate walks for. Present in every fixture root so a case here fails for the reason it names rather than for a walk stop.
  printf '# Fixture home page\n' >"$root/docs/index.md"
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


# ---------------------------------------------------------------------------
# The two walk stops. A count is not evidence: these are the two shapes a walk fails in, and only one of them is visible to a floor.
# ---------------------------------------------------------------------------
# Each asserts its OWN diagnostic rather than a bare non-zero exit. The gate exits 1 for a real violation, for a walk that returned nothing and for a walk that no longer reaches its anchor alike, so only the sentence says which branch ran — and a fixture that moved would otherwise trip a different branch and read as a successful catch.

# A manifest with captures declared and no docs/ tree at all: the walk returns nothing, and with no page read there is no embed to be missing, so without this stop the gate would report only orphans.
empty_walk_out="$(GUARD_ROOT="$dir/__fixtures__/screenshot/reject-empty-walk" bash "$gate" 2>&1)"
empty_walk_rc=$?
if [ "$empty_walk_rc" -eq 0 ] || ! grep -qF 'scan matched no markdown files under docs —' <<<"$empty_walk_out"; then
  echo "FAIL: reject-empty-walk expected the zero-file stop (rc=$empty_walk_rc)"
  echo "$empty_walk_out"
  fails=1
fi

# Markdown under docs/ but not the anchor page. The page count is healthy, and an embed the walk never reads is an embed this gate never checks.
narrowed_walk_out="$(GUARD_ROOT="$dir/__fixtures__/screenshot/reject-narrowed-walk" bash "$gate" 2>&1)"
narrowed_walk_rc=$?
if [ "$narrowed_walk_rc" -eq 0 ] || ! grep -qF 'walk narrowed' <<<"$narrowed_walk_out" || ! grep -qF 'docs/index.md' <<<"$narrowed_walk_out"; then
  echo "FAIL: reject-narrowed-walk expected the anchor stop naming docs/index.md (rc=$narrowed_walk_rc)"
  echo "$narrowed_walk_out"
  fails=1
fi

if [ "$fails" -ne 0 ]; then
  echo "no-stale-screenshot self-test: RED"
  exit 1
fi

echo "no-stale-screenshot self-test: OK"
