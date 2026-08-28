#!/usr/bin/env bash
# Self-test for no-stale-comment-refs.sh. Drives the real gate over the fixture trees under __fixtures__/comment-refs/ via the GUARD_ROOT override, so what is proven is the shipping gate and not a copy of it.
#
# Two independent things need proving, and neither is visible from an exit code.
#
# The MATCHING. The gate carries two patterns and three carve-outs, and a green run cannot tell any of them apart: with one dead the others still print the same heading over the same non-zero exit. Each fail root is therefore asserted on its OWN reason line and on every shape it contains, and the pass root pins the shapes that must NOT match — colour hex in both lengths, an issue-shaped string literal on a code line, the charter's `invariant #N` idiom both inline and split across a hard wrap, a vendored upstream `@see`, and a `__tests__` file keeping a reference on purpose.
#
# The WALK. A count is not evidence. The gate exits 1 for a real violation, for a walk that returned nothing and for a walk that no longer reaches an anchor alike, so only the sentence says which branch ran — and a fixture that moved would otherwise trip a walk stop and read as a successful pattern catch. Both stops are driven here, each on its own diagnostic.
#
# Every fixture tree therefore carries a scaffold file under each declared root plus each anchor, because the walk stops run BEFORE any matching: without them the pattern roots would all fail on the zero-file stop and prove nothing about the patterns.
#
# Helper shape borrowed from no-unreviewed-tofixed.selftest.sh: expect_reject takes the needles it demands as evidence, which is what makes a shape-specific assertion cheap enough to write for every spelling the bare form has to catch.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/no-stale-comment-refs.sh"
fixtures="$dir/__fixtures__/comment-refs"
fails=0

if [ ! -f "$gate" ]; then
  echo "FAIL: gate script not found at $gate"
  echo 'no-stale-comment-refs self-test: RED'
  exit 1
fi

# Reject `$1` and require every remaining argument to appear in the gate's output.
expect_reject() {
  local name="$1"; shift
  local out rc needle
  out="$(GUARD_ROOT="$fixtures/$name" bash "$gate" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "FAIL: $name expected a non-zero exit, got 0"
    fails=1
    return
  fi
  for needle in "$@"; do
    if ! grep -qF -- "$needle" <<<"$out"; then
      echo "FAIL: $name rejected without '$needle' evidence"
      echo "--- gate output ---"
      echo "$out"
      echo "-------------------"
      fails=1
    fi
  done
}

expect_accept() {
  local name="$1" out rc
  out="$(GUARD_ROOT="$fixtures/$name" bash "$gate" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "FAIL: $name expected exit 0, got $rc"
    echo "--- gate output ---"
    echo "$out"
    echo "-------------------"
    fails=1
  fi
}

# ---------------------------------------------------------------------------
# The matching.
# ---------------------------------------------------------------------------

# Every live false-positive pin sits in this one root, so a widened pattern that
# starts matching colours, prose, vendored code, test traceability or the
# numbered-invariant idiom fails here rather than in the repo sweep months later.
expect_accept pass

# The bare form has no keyword to key on, so it must be reported under its own
# heading and quote the offending line. Both digit widths, because the shortest
# live references in the repo are two-digit ones: a bound narrowed to 3-4 digits
# still rejects this root on the (#436) line while going blind to exactly those.
expect_reject fail-bare \
  'bare-form' \
  'apps/api/src/orders.ts' \
  '(#436)' \
  '(#34)'

# One spelling per line, each demanded by name. The first cut of this gate matched
# only a number in its own parentheses closing on the digit, so every one of these
# passed while the gate reported OK over 65 in-scope references. A needle missing
# from the output means that spelling stopped matching, whatever the exit code says.
expect_reject fail-shapes \
  'bare-form' \
  'apps/api/src/shapes.ts' \
  '(issue #407)' \
  '(tracker #267)' \
  'epic #561' \
  '#496 combined' \
  '(#534, audit F6)' \
  'scripts/tool.ts' \
  'plan #909'

# The keyword form must stay independently live; sharing a heading with the bare
# form would let either pattern die unnoticed.
expect_reject fail-keyword \
  'keyword-form' \
  'packages/db/src/repo.ts' \
  '@see'

# YAML is reached three different ways -- the .github walk, the deploy walk, and a
# repo-root listing for files under no scanned directory at all -- so each is
# demanded by name. Losing any one of them is invisible from the exit code, which
# the other two still drive to 1. The `#` leader is also the sigil a reference
# starts with, so this root is what proves the YAML form matches a leader AND a
# later `#NNN` rather than the leader alone.
expect_reject fail-yaml \
  'bare-form' \
  '.gitlab-ci.yml' \
  '(accepted, #577)' \
  '.github/workflows/nightly.yml' \
  '(#51)' \
  'deploy/compose/docker-compose.scale.yml' \
  'epic #561'

# ---------------------------------------------------------------------------
# The walk. These are the two shapes a walk fails in, and only one of them is visible to a floor.
# ---------------------------------------------------------------------------

# A tree with none of the scanned roots present: the walk returns nothing and the
# floor every gate already carried is what catches it. Asserted on the sentence
# and on the full root list, so a root silently dropped from the declaration is a
# failure here rather than a quieter scan later.
expect_reject empty-walk \
  'scan matched no source or YAML files under apps, packages, scripts, .github, deploy'

# Files under every scanned root, but the module this rule is anchored on no
# longer reached. The walk still returns a healthy count, which is precisely what
# a floor reads as a clean tree.
expect_reject narrowed-walk \
  'walk narrowed, count is not evidence.' \
  'packages/contracts/src/decimal.ts'

if [ "$fails" -ne 0 ]; then
  echo 'no-stale-comment-refs self-test: RED'
  exit 1
fi

echo 'no-stale-comment-refs self-test: OK'
