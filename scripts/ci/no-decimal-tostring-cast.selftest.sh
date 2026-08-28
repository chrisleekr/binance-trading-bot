#!/usr/bin/env bash
# Self-test for no-decimal-tostring-cast.sh. Drives the real gate over the
# fixture trees under __fixtures__/decimal-tostring-cast/ via the GUARD_ROOT
# override, so what is proven is the shipping matcher and not a copy of it.
#
# This gate earns a self-test where the other regex gates do not, because two of
# its stops were silently fail-open before anyone drove them: an unclosed `/*`
# inside a string literal blanked the real code below it, and the `String(...)`
# pattern could not cross a nested call. Both are asserted below, and each
# failing case asserts its OWN diagnostic rather than a bare non-zero exit — the
# gate exits 1 for a violation, for an empty walk and for a narrowed walk alike —
# all three are driven below — so a moved fixture would trip a different branch
# and a non-zero-means-caught check would read that as a successful catch.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/no-decimal-tostring-cast.sh"
fixtures="$dir/__fixtures__/decimal-tostring-cast"

fails=0

# expect_reject <fixture> <substring...>
#   Runs the gate over the fixture and requires a non-zero exit whose output
#   contains every substring given.
expect_reject() {
  local name="$1"; shift
  local out rc needle
  out="$(GUARD_ROOT="$fixtures/$name" bash "$gate" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "FAIL: $name fixture expected a non-zero exit, got 0"
    fails=1
    return
  fi
  for needle in "$@"; do
    if ! grep -qF -- "$needle" <<<"$out"; then
      echo "FAIL: $name fixture rejected, but not for '$needle' (rc=$rc)"
      echo "$out"
      fails=1
    fi
  done
}

# expect_accept <fixture> <substring...>
expect_accept() {
  local name="$1"; shift
  local out rc needle
  out="$(GUARD_ROOT="$fixtures/$name" bash "$gate" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "FAIL: $name fixture expected exit 0, got $rc"
    echo "$out"
    fails=1
    return
  fi
  for needle in "$@"; do
    if ! grep -qF -- "$needle" <<<"$out"; then
      echo "FAIL: $name fixture passed, but without '$needle'"
      fails=1
    fi
  done
}

# The accept tree carries every shape a false positive would break: the rule
# stated verbatim as prose in the module that owns it, the same text inside a
# JSDoc block, a self-closing glob (`src/**/*.ts`), a legitimate re-brand of an
# already-formatted value, and a real `asDecimalString` call. Flagging any of
# these is what gets a gate switched off.
#
# The needle only asserts the gate reached its success line and printed a count;
# it matches any number, including one, so it is NOT what rules out a pass over a
# tree the walk never entered. The gate's own zero-file and anchor stops do that,
# and both are driven below.
expect_accept pass 'files scanned'

# The plain cast, sitting under a multi-line JSDoc. The line number is asserted:
# a stripper that DELETES block comments instead of blanking them reports line 1
# here, which sends the reader to the wrong place in a real file.
expect_reject reject-tostring 'apps/api/src/route.ts:5' '.toString() as DecimalString'

# The same cast after a prettier reflow, with `as DecimalString` on the next
# line. Two properties in one: the match crosses the newline, and the violation
# is reported on line 10 where the value is built, not line 11 where the
# annotation landed.
expect_reject reject-tostring 'apps/api/src/route.ts:10'

# The `String(...)` spelling wrapped around a nested call — the natural way to
# write it, since the value is almost always a Decimal. A `[^)]*` argument match
# cannot cross the inner `)` and misses this entirely.
expect_reject reject-string-nested 'apps/api/src/route.ts:1' 'String(new Decimal(x))'

# An unclosed `/*` inside a string literal, with a real violation below it and a
# closing `*/` further down. Un-anchored block-comment stripping blanks the
# violation along with the "comment" and the gate exits 0.
expect_reject reject-hidden-by-unclosed-comment 'apps/api/src/route.ts:2'

# A tree the walk cannot enter at all: no `apps/`, no `packages/`. Distinct from
# the narrowed walk below, and it has its own diagnostic, so asserting the
# message is what proves this branch rather than that one.
expect_reject reject-empty-walk 'scan matched no .ts/.tsx files under apps, packages —'

# A tree that scans real files but no longer reaches the module this rule
# protects — the shape a widened skip-list produces. A count-only floor reports
# a confident OK here.
expect_reject reject-narrowed-walk 'walk narrowed' 'packages/contracts/src/decimal.ts'

# The apps anchor is a .tsx on purpose, and until now nothing drove it: every fixture with an apps/ tree carried main.tsx, and the one without had no apps/ tree at all, so it stopped on the zero-file branch instead. This is the tree a reverted .tsx clause actually produces — both roots populated, both .ts anchors reached, and only the .tsx one missed, which is why the zero-file floor stays quiet and every component in apps/web goes silently out of scope.
expect_reject reject-missing-tsx-anchor 'walk narrowed' 'apps/web/src/main.tsx'

if [ "$fails" -ne 0 ]; then
  echo "no-decimal-tostring-cast self-test: FAILED"
  exit 1
fi
echo "no-decimal-tostring-cast self-test: OK"
