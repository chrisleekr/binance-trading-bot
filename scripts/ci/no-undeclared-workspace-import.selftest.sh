#!/usr/bin/env bash
# Self-test for no-undeclared-workspace-import.sh. Drives the real gate over the fixture trees under __fixtures__/workspace-import/ via the GUARD_ROOT override, so what is proven is the shipping gate and not a copy of it.
#
# This guard makes TWO listings, and they fail differently. The workspaces globs decide which packages exist at all — a package lost there is not merely unscanned, it is gone, and the floors below never hear about it. Each package src/ then decides which of its files are read. The `unscanned` list the gate already carried is a per-package floor over the second listing only, and a floor sees a src/ that yielded NOTHING; one that merely narrowed still yields files and its undeclared imports quietly stop being reported.
#
# There is no `pass` fixture here on purpose. The gate runs over the real tree on every lint pass and must exit 0 there, so the accepting case is already driven against every workspace anchor at once.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/no-undeclared-workspace-import.sh"
fixtures="$dir/__fixtures__/workspace-import"

fails=0

# expect_reject <fixture> <substring...>
#   Runs the gate over the fixture and requires a non-zero exit whose output contains every substring. Each case asserts its OWN sentence rather than a bare non-zero exit: this gate exits 1 for five different reasons, so an exit code alone would let a fixture that tripped the wrong branch read as a successful catch.
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

# Listing one, both stops. A glob parent that vanished entirely used to be skipped in silence, leaving the remaining globs to satisfy every floor below.
expect_reject reject-empty-glob 'scan matched no workspace directories under packages —'

# The narrowing case: real workspaces still expand, so the package count is healthy, and the one the layout is anchored on is simply absent along with every edge it would have contributed.
expect_reject reject-narrowed-glob 'walk narrowed' 'packages/core'

# Listing two, both stops. A declared workspace whose src/ is gone entirely.
expect_reject reject-empty-walk 'scan matched no .ts/.tsx files under packages/core/src —'

# The same workspace with files under src/ but not the entry point it promises to ship. The scanned count is healthy and every declared edge still resolves, so nothing but the anchor separates this from a fully scanned package.
expect_reject reject-narrowed-walk 'walk narrowed' 'packages/core/src/index.ts'

# A workspace this guard cannot anchor at all: no types, no main, no exports pointing into src/. Skipping it would drop the package from the scan silently, which is the same fail-open the anchors exist to close, so it is refused by name instead.
expect_reject reject-unanchorable-package 'no src/ entry point' 'packages/core'

# A no-source exemption must expire as soon as that package gains source, before the root-building loop can skip it permanently.
expect_reject reject-stale-no-src 'listed in NO_SRC but now carrying src/' 'packages/config'

if [ "$fails" -ne 0 ]; then
  echo "no-undeclared-workspace-import self-test: FAILED"
  exit 1
fi
echo "no-undeclared-workspace-import self-test: OK"
