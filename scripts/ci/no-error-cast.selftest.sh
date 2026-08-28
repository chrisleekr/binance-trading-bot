#!/usr/bin/env bash
# Self-test for no-error-cast.sh. Drives the real gate over the fixture trees under __fixtures__/error-cast/ via the GUARD_ROOT override, so what is proven is the shipping matcher and not a copy of it.
#
# This gate earns a self-test because its comment stripper shipped two defects that a green run cannot distinguish from a clean tree: block comments were deleted along with their newlines, so every violation below a JSDoc block was reported at the wrong line, and the `/*` was unanchored, so an unclosed `/*` inside a string literal blanked the real code up to the next `*/` anywhere later in the file and the gate exited 0 over a live violation.
#
# Each failing case asserts its OWN diagnostic rather than a bare non-zero exit — the gate exits 1 for a violation, for an empty walk and for a narrowed walk alike, and all three are driven below — so a moved fixture would trip a different branch and a non-zero-means-caught check would read that as a successful catch.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/no-error-cast.sh"
fixtures="$dir/__fixtures__/error-cast"

fails=0

# expect_reject <fixture> <substring...>
#   Runs the gate over the fixture and requires a non-zero exit whose output contains every substring given.
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

# expect_accept_known_gap <fixture> <substring...>
#   An accept whose OUTPUT says it is an accepted residual, not a clean tree. A green run otherwise reads identically for both, and a pinned gap that has silently stopped pinning anything looks exactly like a pass.
expect_accept_known_gap() {
  local name="$1"
  expect_accept "$@"
  echo "KNOWN GAP (accepted): $name"
}

# The accept tree carries every shape a false positive would break: the cast quoted as prose inside a JSDoc block, the same text in a line comment, a self-closing glob (`src/**/*.ts`), and a legitimate `errorMessage(err)` call. Flagging any of these is what gets a gate switched off.
#
# The needle only asserts the gate reached its success line and printed a count; it matches any number, including one, so it is NOT what rules out a pass over a tree the walk never entered. The gate's own zero-file and anchor stops do that, and both are driven below.
expect_accept pass 'files scanned'

# The cast sitting under a multi-line JSDoc. The line number is the assertion: a stripper that DELETES block comments instead of blanking them reports line 2 here, which sends the reader four lines above the code that is actually wrong — and in a real file, with a long licence header or a wrapped JSDoc, arbitrarily further.
#
# The same tree carries the two shapes a per-line, .ts-only matcher cannot see: a cast prettier reflowed across three lines (reported on line 8, where the value is read, not on line 10 where `.message` landed), and a cast in a `.tsx` file, which is where the two violations this widening found on the way in actually lived.
expect_reject reject-cast 'apps/api/src/route.ts:5' '(err as Error).message'
expect_reject reject-cast 'apps/api/src/route.ts:8'
expect_reject reject-cast 'apps/web/src/panel.tsx:2'

# An unclosed `/*` inside a string literal, with a real violation below it and a closing `*/` further down. Un-anchored block-comment stripping blanks the violation along with the "comment" and the gate exits 0 over live code.
expect_reject reject-hidden-by-unclosed-comment 'apps/api/src/route.ts:2'

# A tree the walk cannot enter at all: no `apps/`, no `packages/`. Distinct from the narrowed walk below, and it has its own diagnostic, so asserting the message is what proves this branch rather than that one. The diagnostic names every empty root, which is what separates this case from the half-walk below.
expect_reject reject-empty-walk 'no .ts/.tsx files under apps, packages —'

# Half a walk: `packages/` is populated and carries its anchor, `apps/` is gone. This is the case a UNION walk with one shared floor and one shared anchor cannot see — hundreds of files still come back and the anchor is still found, so the gate prints a confident count having never examined apps/api, apps/worker or apps/web. Asserting the root name is what proves the per-root floor rather than the whole-walk one.
expect_reject reject-half-walk 'no .ts/.tsx files under apps —'

# A tree that scans real files under BOTH roots but no longer reaches the module this rule points people at. A count-only floor reports a confident OK here.
expect_reject reject-narrowed-walk 'walk narrowed' 'packages/core/src/error/error-message.ts'

# Both roots populated, both `.ts` anchors present, `apps/web` gone — which is also the tree a walk that stopped scanning `.tsx` produces. Asserting the `.tsx` anchor by name is what pins the extension widening: with `.ts` anchors only, every floor and every anchor is satisfied while the gate examines zero `.tsx` files.
expect_reject reject-missing-tsx-anchor 'walk narrowed' 'apps/web/src/main.tsx'

# A KNOWN GAP, pinned as current behaviour rather than as a fix. Line-anchored block-comment stripping cannot tell a comment from a template-literal continuation line that begins with `/*`, so an unclosed opener inside a template blanks the live violation below it and the gate exits 0. Encoded as an accept so the residual is observed rather than assumed; closing it needs a real tokeniser, not a wider regex, and flipping this case to a reject is how that work announces itself.
#
# Pinned as a PAIR, because the accept alone asserts nothing the ordinary `pass` case does not: delete the hidden cast and this stays green forever as a second copy of it. The control tree carries the identical cast with the template literal removed and is rejected on its exact line, so the two jointly prove that the cast IS a violation and that the template literal is what hides it, and the control goes red the moment the cast leaves either tree.
expect_accept_known_gap known-gap-template-literal 'files scanned'
expect_reject known-gap-template-literal-control 'apps/api/src/route.ts:4' '(err as Error).message'

# The pair argues jointly only if the two trees really do carry the same cast on the same line, and neither the accept nor the reject can see the other tree. Asserting the identity is what makes "edit the cast out of EITHER tree and this goes red" true rather than a description of intent: on its own the accepting case cannot tell a pinned gap from an empty file.
gap_cast="$(grep -n 'as Error' "$fixtures/known-gap-template-literal/apps/api/src/route.ts" || true)"
control_cast="$(grep -n 'as Error' "$fixtures/known-gap-template-literal-control/apps/api/src/route.ts" || true)"
if [ -z "$gap_cast" ] || [ "$gap_cast" != "$control_cast" ]; then
  echo "FAIL: the known-gap pair diverged — the accepted gap and its control must carry the identical cast on the identical line"
  echo "  known-gap-template-literal:         ${gap_cast:-<none>}"
  echo "  known-gap-template-literal-control: ${control_cast:-<none>}"
  fails=1
fi

if [ "$fails" -ne 0 ]; then
  echo "no-error-cast self-test: FAILED"
  exit 1
fi
echo "no-error-cast self-test: OK"
