#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start lint
bash "$(dirname "$0")/no-locks.sh"
# Publishing gate: this repo ships to a public GitHub repo, so a dump or a
# credential reaching the index is unrecoverable once pushed.
bash "$(dirname "$0")/no-publish-hazard.sh"
# Invariant gates formerly enforced by custom ESLint rules, moved to grep gates
# in the eslint→oxlint migration (#576): oxlint can't express these extensibly.
bash "$(dirname "$0")/no-plugin-leak.sh"
bash "$(dirname "$0")/no-missing-preview-export.sh"
bash "$(dirname "$0")/no-arbitrary-color-token.sh"
bash "$(dirname "$0")/no-undeclared-workspace-import.sh"
bash "$(dirname "$0")/no-phantom-env-var.selftest.sh"
bash "$(dirname "$0")/no-phantom-env-var.sh"
bash "$(dirname "$0")/no-invalid-mermaid.sh"
bash "$(dirname "$0")/no-busybox-incompatible-grep.sh"
bash "$(dirname "$0")/turbo-sees-strategy.sh"
bash "$(dirname "$0")/no-stale-comment-refs.sh"
bash "$(dirname "$0")/no-stale-migration-doc.sh"
bash "$(dirname "$0")/no-stale-config-table.selftest.sh"
bash "$(dirname "$0")/no-stale-config-table.sh"
# Self-test first, same reasoning as the pairs below: the gate is a single
# `--check` invocation, so a dropped flag makes it rewrite the file it is meant
# to compare and pass forever. The self-test is what says the gate can still
# fail.
bash "$(dirname "$0")/no-stale-env-contract.selftest.sh"
bash "$(dirname "$0")/no-stale-env-contract.sh"
bash "$(dirname "$0")/no-hyphenated-trailing-trade.sh"
bash "$(dirname "$0")/no-broken-admonition.sh"
bash "$(dirname "$0")/no-broken-admonition.selftest.sh"
bash "$(dirname "$0")/no-broken-grid-card.sh"
bash "$(dirname "$0")/no-broken-grid-card.selftest.sh"
bash "$(dirname "$0")/no-stale-screenshot.sh"
bash "$(dirname "$0")/no-stale-screenshot.selftest.sh"
bash "$(dirname "$0")/no-colocated-tests.sh"
bash "$(dirname "$0")/no-unwired-test-d.sh"
bash "$(dirname "$0")/no-stripped-err-log.sh"
bash "$(dirname "$0")/no-error-cast.sh"
bash "$(dirname "$0")/no-uncommented-coverage-ignore.sh"
bash "$(dirname "$0")/notify-conformance-coverage.sh"
# Self-test first: `set -e` aborts on the first failure, and on the one run where
# both would fail it is the self-test that says whether the rules file is wrong
# or the parser regressed. Then metric-name existence before PromQL syntax,
# because promtool accepts a rule over a series nothing emits.
bash "$(dirname "$0")/no-phantom-alert-metric.selftest.sh"
bash "$(dirname "$0")/no-phantom-alert-metric.sh"
bash "$(dirname "$0")/promtool-lint.selftest.sh"
bash "$(dirname "$0")/promtool-lint.sh"
# Sink width before rule syntax, and self-test first for the same reason as the
# pair above. A sink typed on `string` is what puts a metric outside the closed
# catalogue in the first place, which is the state the phantom-alert gate can
# only observe after the fact.
bash "$(dirname "$0")/no-wider-metrics-sink.selftest.sh"
bash "$(dirname "$0")/no-wider-metrics-sink.sh"
# Self-test first, same reasoning as the alert-metric pair above: on a run where
# both fail it says whether the config drifted or the gate itself broke.
bash "$(dirname "$0")/no-dropped-lint-rule.selftest.sh"
bash "$(dirname "$0")/no-dropped-lint-rule.sh"
# Whole-repo single-pass lint. One invocation (not per-package) so oxlint's
# multi-file analysis builds one project-wide module graph for import/no-cycle,
# rather than a per-package view blind to imports crossing package folders.
bunx oxlint
bunx prettier --check .
