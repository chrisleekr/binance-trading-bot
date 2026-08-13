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
behavior_fixtures="$fixtures/label-matchers"

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

# Build each focused case from the established valid tree. Keeping the metric
# catalogue and constructor corpus identical isolates rule discovery and matcher
# validation from emission discovery.
make_behavior_fixture() {
  local name="$1" tmp="$dir/.alert-metric-$1"
  rm -rf "$tmp"
  cp -R "$fixtures/pass" "$tmp"
  rm -f "$tmp/deploy/observability/alerts.yml"
  if [ -f "$behavior_fixtures/$name/alerts.yml" ]; then
    cp "$behavior_fixtures/$name/alerts.yml" "$tmp/deploy/observability/alerts.yml"
  fi
  if [ -d "$behavior_fixtures/$name/siblings" ]; then
    cp "$behavior_fixtures/$name/siblings/"* "$tmp/deploy/observability/"
  fi
  printf '%s\n' "$tmp"
}

expect_behavior_reject() {
  local name="$1"; shift
  local fixture out rc needle
  fixture="$(make_behavior_fixture "$name")"
  out="$(GUARD_ROOT="$fixture" bash "$gate" 2>&1)"
  rc=$?
  rm -rf "$fixture"
  if [ "$rc" -eq 0 ]; then
    echo "FAIL: $name expected a non-zero exit, got 0"
    fails=1
    return
  fi
  for needle in "$@"; do
    if ! grep -qF -- "$needle" <<<"$out"; then
      echo "FAIL: $name rejected, but not for '$needle' (rc=$rc)"
      fails=1
    fi
  done
}

expect_behavior_accept() {
  local name="$1"; shift
  local fixture out rc needle
  fixture="$(make_behavior_fixture "$name")"
  out="$(GUARD_ROOT="$fixture" bash "$gate" 2>&1)"
  rc=$?
  rm -rf "$fixture"
  if [ "$rc" -ne 0 ]; then
    echo "FAIL: $name expected exit 0, got $rc"
    fails=1
    return
  fi
  for needle in "$@"; do
    if ! grep -qF -- "$needle" <<<"$out"; then
      echo "FAIL: $name passed without evidence '$needle'"
      fails=1
    fi
  done
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

# Selector-label rejection identifies the complete operator-facing location.
# The valid cases cover catalogue, constructor, derived, default, global and
# scrape labels, plus quoted braces in direct and exact-name selectors.
expect_behavior_reject matcher-invalid \
  'deploy/observability/alerts.yml' 'InvalidWeightMatcher' \
  'binance_api_weight' 'accountId'
expect_behavior_reject backtick-invalid \
  'BacktickInvalidMatcher' 'binance_api_weight' 'accountId'
expect_behavior_reject nameless-selector \
  'deploy/observability/alerts.yml' 'NamelessSelector' \
  'selector with label keys has no exact metric name' 'accountId'
expect_behavior_accept matcher-valid
expect_behavior_reject brace-value-invalid \
  'deploy/observability/alerts.yml' 'BraceValueInvalidMatcher' \
  'metric binance_api_weight' 'key accountId'
expect_behavior_accept brace-value-valid

# Rule discovery is over every top-level YAML file, not one hard-coded path.
# Non-rule YAML must be explicitly classified so adding an accidentally skipped
# sibling cannot keep the walk green.
expect_behavior_reject malformed-sibling \
  'deploy/observability/secondary.yaml' 'flow-style rule entry'
expect_behavior_reject flow-hidden 'flow-style rule entry'
expect_behavior_reject quoted-key 'quoted rule key'
expect_behavior_accept non-rule-sibling \
  'deploy/observability/otel-collector.yaml' 'non-rule YAML'
expect_behavior_reject zero-yaml 'zero top-level observability YAML'
expect_behavior_reject non-rule-only \
  'deploy/observability/otel-collector.yaml' 'zero Prometheus rules files'

if [ "$fails" -ne 0 ]; then
  echo "no-phantom-alert-metric self-test: RED"
  exit 1
fi

echo "no-phantom-alert-metric self-test: OK"
