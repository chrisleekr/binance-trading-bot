#!/usr/bin/env bash
# Self-test for no-phantom-alert-metric.sh. Drives the real gate over the fixture
# trees under __fixtures__/alert-metric/ via the GUARD_ROOT override.
#
# Every failing case asserts its OWN diagnostic, never a bare non-zero exit. The
# gate has five vacuity floors and four hard parse errors that all exit 1, so a
# moved fixture or a parser regression would trip one of them and a
# non-zero-means-caught check would read that as a successful catch. Matching the
# message is what makes each case prove the path it names.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/no-phantom-alert-metric.sh"
fixtures="$dir/__fixtures__/alert-metric"

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

# The pass tree exercises every accepted syntax at once, because a false positive
# here rejects legitimate rules and is what gets a gate switched off: synthesised
# `up`, a histogram-derived `_count`, a `_bucket` off the one default histogram, a
# declared gauge, a constructor name, a default process metric, a `by (…)` label
# list, a compound `offset 1h30m`, the non-decimal float literals, a quoted
# scalar with a trailing YAML comment, a
# `#` inside quotes that is content, a `__name__` equality matcher, the bare
# binary operator `atan2`, a Go-template `- {{ … }}` bullet inside an annotation
# block scalar, an entry whose first key is `expr:`, and a recording rule.
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

expect_accept pass

# A watchdog names no metric on purpose, so the per-expr floor needs an opt-out.
# It is per-rule and has to be typed: the `vacuous` tree is the same shape without
# the marker and is still rejected, which is what keeps silence failing.
expect_accept watchdog

# Six phantom shapes, each asserted by name. Together they pin the parts of
# resolution easiest to regress into silence: exact-match allowlists (up_wrong),
# kind-aware suffix derivation (decision_count_sum off a counter), reading
# through YAML quoting and through a __name__ matcher, and a constructor scan
# that stops at its own call instead of running on into unrelated literals.
expect_reject fail \
  tick_latnecy_ms_count \
  up_wrong \
  decision_count_sum \
  phantom_behind_quotes \
  phantom_behind_name_matcher \
  not_a_metric_name \
  nodejs_heap_space_size_used_bytes \
  'sum (rule OperatorNamedMetric)'

# One fixture per vacuity floor, so no floor is left as an unexercised branch.
expect_reject vacuous 'names no metric'
expect_reject empty-catalog 'zero metric names parsed'
expect_reject no-ctor 'zero prom-client metric constructors'
expect_reject no-rules 'zero alert rules parsed'
expect_reject no-exprs 'zero expr values parsed'

# Hard parse errors: shapes the gate refuses rather than guesses at.
expect_reject union-drift 'union only: declared_in_union_only'
expect_reject head-expr-skew 'rule entries with no expr key: MissingExpr'
expect_reject name-regex '__name__=~'
expect_reject flow-style 'flow-style rule entry'

if [ "$fails" -ne 0 ]; then
  echo "no-phantom-alert-metric self-test: RED"
  exit 1
fi

echo "no-phantom-alert-metric self-test: OK"
