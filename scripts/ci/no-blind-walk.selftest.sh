#!/usr/bin/env bash
# Self-test for no-blind-walk.sh. Drives the real gate over the fixture trees under __fixtures__/blind-walk/ via the GUARD_ROOT override, so what is proven is the shipping meta-gate and not a copy of it.
#
# Every branch here fails the build for a different reason and they all exit 1, so each case asserts its OWN sentence. A bare non-zero check would be satisfied by any of them, and this gate is precisely the one that must not be believed on an exit code alone: a recogniser that silently stopped matching reports zero offenders, which reads exactly like a fully migrated tree.
#
# The manifest is supplied per fixture through WALK_GATE_MANIFEST, which is why lint.sh clears that variable before the real run: a value left in the environment would otherwise replace the pinned floor with whatever it points at.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/no-blind-walk.sh"
fixtures="$dir/__fixtures__/blind-walk"

fails=0

run_fixture() {
  WALK_GATE_MANIFEST="$fixtures/$1/manifest.txt" GUARD_ROOT="$fixtures/$1" bash "$gate" 2>&1
}

# expect_reject <fixture> <substring...>
expect_reject() {
  local name="$1"; shift
  local out rc needle
  out="$(run_fixture "$name")"
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

# A commented-out gate invocation must not be taken as the first gate, or a correctly-placed sweep is reported as a late one. What this pins is the leading anchor on the gate-line pattern: drop the `^\s*` and a `#`-leading line matches, firstGate moves above the sweep, and this correct tree is refused. An ACCEPTING case because that is the only direction the anchor can be driven in.
pass_commented_out="$(run_fixture pass-commented-gate)"
if [ $? -ne 0 ]; then
  echo "FAIL: pass-commented-gate fixture expected exit 0"
  echo "$pass_commented_out"
  fails=1
fi

# The accepting case. Without it every assertion below is also satisfied by a gate that refuses everything, and a meta-gate that can never pass is a meta-gate nobody keeps.
pass_out="$(run_fixture pass)"
pass_rc=$?
if [ "$pass_rc" -ne 0 ] || ! grep -qF '3 walk gates, all routed through the shared helper' <<<"$pass_out"; then
  echo "FAIL: pass fixture expected exit 0 over 3 routed walk gates (rc=$pass_rc)"
  echo "$pass_out"
  fails=1
fi

# The defect this gate exists for: a gate that reads the tree itself, so it carries whatever stops its author remembered rather than the two the helper enforces.
expect_reject reject-blind-gate 'BLIND WALK' 'scripts/ci/no-stale-screenshot.sh'

# Manifest drift, both directions. One direction alone is the more dangerous half to leave out: without the "only in the tree" check a NEW walk gate joins unnoticed, and without "only in the manifest" a gate that stopped walking leaves the floor quietly overstated.
expect_reject reject-manifest-extra 'only in the tree' 'no-locks.sh'
expect_reject reject-manifest-missing 'only in the manifest' 'no-locks.sh'

# A raw directory read is allowed only where it is registered with a reason. An unregistered one is the blind walk under another name, and it is caught even though the gate also routes a walk through the helper.
expect_reject reject-unregistered-raw-walk 'registered raw-walk set drifted' 'no-locks.sh'

# A gate that takes its walk from the helper and still pins the repo root. It inherits both stops and neither can ever be driven, so its self-test can only ever assert the accepting case — which is the shape a stop nobody has watched fire has. Asserted by its own sentence because this gate exits 1 for six reasons and the blind-walk one is a different defect.
expect_reject reject-no-seam 'NO OVERRIDE SEAM' 'scripts/ci/no-locks.sh'

# The scan was shell-only when this gate was written, and a TypeScript gate that walks was simply invisible to it: not reported as blind, not counted, absent from the manifest floor, so the printed total read as a fully routed tree over a walk the gate had never seen. Both spellings of routing and of the seam are asserted here because each is language-specific, and matching only the shell one classifies every TypeScript gate as not walking at all.
expect_reject reject-blind-ts-gate 'BLIND WALK' 'scripts/ci/no-web-api-query-drift.ts'
expect_reject reject-ts-no-seam 'NO OVERRIDE SEAM' 'scripts/ci/no-web-api-query-drift.ts'

# The seam half of the self-exclusion, which is dominated by the routing check above it unless the stub satisfies that check first. The gate pays for excluding itself from its own scan with two direct assertions over its own file, and a stub missing both only ever proves the first.
expect_reject reject-self-seamless 'no longer carries the override seam it requires of every other gate'

# The library floor. Only the "declared but absent" direction is drivable, and deliberately so: classification reads FROM the pinned list, so a module can never appear in the live set without already being in the expected one. A library that joins undeclared is therefore caught by the walk-gate manifest instead, as an unrouted blind walk. This case also proves the lib: prefix is parsed rather than pasted, since a wrong slice would leave the name unmatched.
expect_reject reject-library-missing 'registered library-walker set drifted' 'only in the manifest: workspaces.ts'

# The seam every gate reads is only a seam while something clears it. Left set in the environment it redirects all of them at once, and a substitute tree carrying the anchors passes both stops, so this branch is what keeps every override point from becoming a silent redirect. The count in that diagnostic is derived from the tree rather than written down, because a number maintained by hand goes stale the first time a gate is added and then misstates the blast radius in the one message that has to be believed.
expect_reject reject-unswept-seam 'UNSWEPT SEAM' 'does not clear GUARD_ROOT'

# The ways a sweep is present to a substring test and clears nothing that matters. Position carries its own sentence; the partial, commented-out and conditional sweeps all reach the same "no clearing found" arm, so they differ by input rather than by diagnostic and are listed separately for that reason rather than because each prints something unique.
expect_reject reject-late-sweep 'UNSWEPT SEAM' 'runs after the first gate at line'
expect_reject reject-partial-sweep 'UNSWEPT SEAM' 'No top-level line clearing GUARD_ROOT GUARD_DIR GUARD_RUNNER WALK_GATE_MANIFEST MIGRATIONS_DIR MIGRATIONS_RUNNER OXLINT_CONFIG PROMTOOL_VERSION'
expect_reject reject-commented-sweep 'UNSWEPT SEAM' 'No top-level line clearing GUARD_ROOT GUARD_DIR GUARD_RUNNER WALK_GATE_MANIFEST MIGRATIONS_DIR MIGRATIONS_RUNNER OXLINT_CONFIG PROMTOOL_VERSION'
# An `unset` indented inside a branch that is not taken. It survives every liveness test that reads one line at a time, which is why the finder requires column 0 instead.
expect_reject reject-conditional-sweep 'UNSWEPT SEAM' 'No top-level line clearing GUARD_ROOT GUARD_DIR GUARD_RUNNER WALK_GATE_MANIFEST MIGRATIONS_DIR MIGRATIONS_RUNNER OXLINT_CONFIG PROMTOOL_VERSION'

# The position half used to be skipped whenever no gate line could be found, so tidying lint.sh to the `dirname -- "$0"` spelling this repo already uses elsewhere turned it off and a bottom-of-file sweep passed. Refusing instead is the difference between a check that stops applying and one that says so.
expect_reject reject-unlocatable-gate 'UNSWEPT SEAM' 'no gate invocation could be located'

# The sweep is only as complete as the set of seams it is measured against, and that set was three names somebody typed. A gate reading a fourth is stopped until it is classified as swept or as an ambient input.
expect_reject reject-unclassified-seam 'UNCLASSIFIED ENVIRONMENT SEAM' 'RULES_DIR (scripts/ci/no-locks.sh)'

# A gate in a language neither recogniser table knows. Two files, and the second is the one that matters: it routes through the helper and calls no directory primitive, so a check that first asks "does it walk" in JavaScript vocabulary answers no and never classifies it. Only deciding the file class by EXTENSION, before the walk test, reaches it.
expect_reject reject-untaught-extension 'UNTAUGHT FILE CLASS' 'scripts/ci/no-orphan-fixture.js' 'scripts/ci/no-routed-orphan.mjs'

# This gate is excluded from its own scan because it names the walk API in its recogniser. That exclusion is only sound while it still routes its own walk through the helper and carries the seam it demands of everyone else, so both are asserted directly rather than assumed.
expect_reject reject-self-unrouted 'no longer routes its own walk through the shared helper'

# Its own two walk stops. The meta-gate reads its verdict off a listing of scripts/ci, so it is subject to exactly the failure it exists to forbid.
expect_reject reject-empty-walk 'scan matched no CI gate scripts under scripts/ci —'
expect_reject reject-narrowed-walk 'walk narrowed' 'scripts/ci/lint.sh'

if [ "$fails" -ne 0 ]; then
  echo "no-blind-walk self-test: FAILED"
  exit 1
fi
echo "no-blind-walk self-test: OK"
