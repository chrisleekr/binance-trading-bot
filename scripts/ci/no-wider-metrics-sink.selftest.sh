#!/usr/bin/env bash
# Self-test for no-wider-metrics-sink.sh. Drives the real gate over the fixture
# trees under __fixtures__/wider-metrics-sink/ via the GUARD_ROOT override.
#
# Every failing case asserts its OWN diagnostic, never a bare non-zero exit: the
# gate exits 1 for a widened declaration, for a widened catalogue, and for a scan
# that found nothing, so a moved fixture would trip a different branch and a
# non-zero-means-caught check would read that as a successful catch. Matching the
# message is what makes each case prove the path it names.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/no-wider-metrics-sink.sh"
fixtures="$dir/__fixtures__/wider-metrics-sink"

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
      fails=1
    fi
  done
}

expect_accept() {
  local name="$1" out rc
  out="$(GUARD_ROOT="$fixtures/$name" bash "$gate" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "FAIL: $name fixture expected exit 0, got $rc"
    echo "$out"
    fails=1
  fi
}

# The accept tree carries every shape a false positive would break: the adapter
# that IMPLEMENTS the sink (its parameters carry no annotation), a `record` whose
# first parameter is a client order id and is legitimately a string, and a
# catalogue whose own sink is narrow. Rejecting any of these is what gets a gate
# switched off.
expect_accept pass

# Both spellings of the same widening. A gate that reads only method signatures
# leaves the property form as a way through, so each is asserted by name.
expect_reject reject-method \
  'apps/worker/src/boot/metrics-sink.ts' \
  'record(name: string'
expect_reject reject-property \
  'apps/worker/src/boot/metrics-sink.ts' \
  'record: (name: string'

# The sink is not one method. `forget` retires a gauge child, and a name in no
# catalogue retires nothing — the child keeps exporting its last value, which is
# the stale-series bug the sink grew a `forget` to fix. The gate reads its method
# list off the interface rather than naming `record`, and this is what proves it:
# `record` here is narrow, so a gate matching only `record` calls this file clean.
expect_reject reject-forget \
  'apps/worker/src/boot/metrics-sink.ts' \
  'forget(name: string'

# The widening written as a union, in both the file scan and the catalogue's own
# declaration. `MetricName | string` accepts every string exactly as `string`
# does, so a check pinned to the literal spelling catches only the authors who
# were not trying. Both halves are asserted because they read the annotation
# through different expressions and only one of them was blind in each direction.
expect_reject reject-method-union \
  'apps/worker/src/boot/metrics-sink.ts' \
  "record(name: 'tick_latency_ms' | string"
expect_reject catalog-widened-union 'metrics/catalog.ts must type its sink on MetricName'

# Vacuity floor: a scan that matched no files reports every file as clean, which
# is the failure mode a path or extension change produces silently.
expect_reject empty 'scan matched no .ts/.tsx files under apps —'

# The other half of the same failure, and the half no floor can see: files under both roots, but the boot-time sink builder — the module this rule exists to keep typed on MetricName — no longer reached. The file count stays healthy, so only the anchor sentence tells this from a clean tree.
expect_reject reject-narrowed-walk 'walk narrowed' 'apps/worker/src/boot/metrics-sink.ts'

# The catalogue moving out from under the gate. The fixture carries a widened
# declaration, so passing here would mean the gate walked a real offence and
# reported OK because it could not find the file it measures against.
expect_reject no-catalog 'not found — catalogue path regression'

# The declaration renamed rather than moved. The gate derives the guarded method
# names from `export interface MetricsSink`; with no such declaration it has an
# empty list and matches nothing, so it has to stop rather than report clean.
expect_reject no-sink-interface 'declares no `export interface MetricsSink`'

# The catalogue is exempt from the file scan because it is the one module allowed
# to declare the sink — so it needs its own check, or widening the invariant's own
# source legalises every call site at once and the file scan still passes.
expect_reject catalog-widened 'metrics/catalog.ts must type its sink on MetricName'

# A sink member carrying its metric name under another spelling. The whole gate
# keys on the parameter being named `name`, so this member would drop out of the
# guarded list silently — the same fail-open the derivation exists to end, one
# level further down. It has to stop rather than guard a subset and report OK.
expect_reject sink-off-spelling 'declares MetricsSink members this gate cannot guard'

# The committed tree, with no GUARD_ROOT at all. The fixture accept case proves
# the gate can say yes; this proves it says yes to the repo it actually guards,
# which is the difference between a gate and a gate someone has to disable on the
# first run.
tree_out="$(bash "$gate" 2>&1)"
tree_rc=$?
if [ "$tree_rc" -ne 0 ]; then
  echo "FAIL: the committed tree is rejected by its own gate (rc=$tree_rc)"
  echo "$tree_out"
  fails=1
fi

if [ "$fails" -ne 0 ]; then
  echo "no-wider-metrics-sink self-test: RED"
  exit 1
fi

echo "no-wider-metrics-sink self-test: OK"
