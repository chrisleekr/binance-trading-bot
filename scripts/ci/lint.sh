#!/usr/bin/env bash
set -euo pipefail

# Scrubbed once for the whole run, so a gate added later is not exposed by default the way a per-invocation `env -u` leaves it.
#
# Four are live ambient seams, read by a gate as `${VAR:-default}`: GUARD_ROOT (eleven gates), MIGRATIONS_DIR and MIGRATIONS_RUNNER (the two migration gates), OXLINT_CONFIG (no-dropped-lint-rule). They exist so a paired self-test can aim its gate at a fixture, and every self-test sets them per command — none inherits one from here — but left in the job environment they re-point a gate at a tree that is clean by construction and it reports OK over a repo it never read.
# GUARD_DIR and GUARD_RUNNER are named for defence only: both migration gates reassign them unconditionally on the `bun -e` line, so an ambient value cannot reach the script today. Unsetting them costs nothing and keeps that a property of this line rather than of two call sites.
# PROMTOOL_VERSION is not a self-test seam at all — it is the version pin promtool-lint.sh downloads, defaulted in the script and set by no pipeline. It is scrubbed so an ambient value cannot choose which release CI fetches.
# WALK_GATE_MANIFEST replaces no-blind-walk's pinned gate set with whatever file it names, so an ambient value swaps that gate's vacuity floor for a shorter one and every drift check then passes by construction.
#
# `no-blind-walk` reads this exact line and refuses a run where any `${VAR:-}` seam a gate carries is neither named here nor declared an ambient input, so a seam added later cannot go unswept by being overlooked.
unset GUARD_ROOT GUARD_DIR GUARD_RUNNER WALK_GATE_MANIFEST MIGRATIONS_DIR MIGRATIONS_RUNNER OXLINT_CONFIG PROMTOOL_VERSION

# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start lint
# Walk integrity first, because nearly every gate below reads its verdict off a tree walk and a walk that quietly narrowed reports OK. The self-tests come before the gate for the usual reason — on the one run where both fail, they say whether the tree drifted or the checker did — and `env -u` clears the manifest override so a value left in the environment cannot replace the pinned gate set with a shorter one.
bash "$(dirname "$0")/walk-lib.selftest.sh"
bash "$(dirname "$0")/no-blind-walk.selftest.sh"
env -u WALK_GATE_MANIFEST bash "$(dirname "$0")/no-blind-walk.sh"
bash "$(dirname "$0")/no-locks.selftest.sh"
bash "$(dirname "$0")/no-locks.sh"
# Publishing gate: this repo ships to a public GitHub repo, so a dump or a
# credential reaching the index is unrecoverable once pushed.
bash "$(dirname "$0")/no-publish-hazard.sh"
# Invariant gates formerly enforced by custom ESLint rules, moved to grep gates
# in the eslint→oxlint migration (#576): oxlint can't express these extensibly.
bash "$(dirname "$0")/no-plugin-leak.selftest.sh"
bash "$(dirname "$0")/no-plugin-leak.sh"
bash "$(dirname "$0")/no-missing-preview-export.sh"
bash "$(dirname "$0")/no-arbitrary-color-token.selftest.sh"
bash "$(dirname "$0")/no-arbitrary-color-token.sh"
# Self-test first, same reasoning as the pairs below: this gate's whole value is
# that it can still see a NEW `.toFixed(` site, and a walk that silently matches
# nothing reports OK over an inventory it never compared.
bash "$(dirname "$0")/no-unreviewed-tofixed.selftest.sh"
bash "$(dirname "$0")/no-unreviewed-tofixed.sh"
bash "$(dirname "$0")/no-undeclared-workspace-import.selftest.sh"
bash "$(dirname "$0")/no-undeclared-workspace-import.sh"
bash "$(dirname "$0")/no-phantom-env-var.selftest.sh"
bash "$(dirname "$0")/no-phantom-env-var.sh"
# Web query keys are an HTTP contract: require canonical apiFetch and apiDownloadUrl forms, then compare their static keys with mounted OpenAPI operations.
bash "$(dirname "$0")/no-web-api-query-drift.selftest.sh"
env -u GUARD_ROOT bun "$(dirname "$0")/no-web-api-query-drift.ts"
bash "$(dirname "$0")/no-invalid-mermaid.selftest.sh"
bash "$(dirname "$0")/no-invalid-mermaid.sh"
bash "$(dirname "$0")/no-busybox-incompatible-grep.selftest.sh"
bash "$(dirname "$0")/no-busybox-incompatible-grep.sh"
# Self-test first, same reasoning as the pairs below: a consistency gate whose
# pattern stops matching one site keeps reporting OK over the sites it can still
# see, so the self-test is what says the gate still reads all of them.
bash "$(dirname "$0")/no-bun-version-skew.selftest.sh"
bash "$(dirname "$0")/no-bun-version-skew.sh"
bash "$(dirname "$0")/turbo-sees-strategy.selftest.sh"
bash "$(dirname "$0")/turbo-sees-strategy.sh"
# Self-test first, same reasoning as the pairs below: this gate now carries two
# independent patterns and a green run cannot tell them apart — with one dead the
# other still prints the same heading over the same non-zero exit. The self-test
# is what says both are still matching, and that the pass-root false-positive
# pins still hold.
bash "$(dirname "$0")/no-stale-comment-refs.selftest.sh"
bash "$(dirname "$0")/no-stale-comment-refs.sh"
bash "$(dirname "$0")/no-stale-migration-doc.selftest.sh"
bash "$(dirname "$0")/no-stale-migration-doc.sh"
# Self-test first, same reasoning as the pairs below: this gate reasons from the
# directory listing alone, so a walk that stops seeing files reports OK over a
# sequence it never read. Ordered before the immutability pair because numbering
# is what decides where a migration RUNS; the checksum pair only decides whether
# an already-placed one may change.
bash "$(dirname "$0")/no-backfilled-migration.selftest.sh"
bash "$(dirname "$0")/no-backfilled-migration.sh"
bash "$(dirname "$0")/no-mutated-applied-migration.selftest.sh"
bash "$(dirname "$0")/no-mutated-applied-migration.sh"
bash "$(dirname "$0")/no-stale-config-table.selftest.sh"
bash "$(dirname "$0")/no-stale-config-table.sh"
# Self-test first, same reasoning as the pairs below: the gate is a single
# `--check` invocation, so a dropped flag makes it rewrite the file it is meant
# to compare and pass forever. The self-test is what says the gate can still
# fail.
bash "$(dirname "$0")/no-stale-env-contract.selftest.sh"
bash "$(dirname "$0")/no-stale-env-contract.sh"
bash "$(dirname "$0")/no-hyphenated-trailing-trade.selftest.sh"
bash "$(dirname "$0")/no-hyphenated-trailing-trade.sh"
bash "$(dirname "$0")/no-broken-admonition.sh"
bash "$(dirname "$0")/no-broken-admonition.selftest.sh"
bash "$(dirname "$0")/no-broken-grid-card.sh"
bash "$(dirname "$0")/no-broken-grid-card.selftest.sh"
bash "$(dirname "$0")/no-stale-screenshot.sh"
bash "$(dirname "$0")/no-stale-screenshot.selftest.sh"
bash "$(dirname "$0")/no-colocated-tests.sh"
bash "$(dirname "$0")/no-unwired-test-d.selftest.sh"
bash "$(dirname "$0")/no-unwired-test-d.sh"
bash "$(dirname "$0")/no-stripped-err-log.selftest.sh"
bash "$(dirname "$0")/no-stripped-err-log.sh"
# Self-test first: this gate shipped both a line-shift and a fail-open in one stripper — block comments were deleted rather than blanked, so every violation under a JSDoc was reported at the wrong line, and an unclosed `/*` inside a string literal blanked the code below it and the gate exited 0. Neither is visible from a green run, so the gate is only evidence once the matcher has been driven over trees it must reject.
bash "$(dirname "$0")/no-error-cast.selftest.sh"
bash "$(dirname "$0")/no-error-cast.sh"
# Self-test first: this gate has shipped two fail-open bugs (an unclosed `/*`
# in a string literal blanking real code, and a `String(...)` match that could
# not cross a nested call), so a green gate is only evidence once the matcher
# has been driven over trees it must reject.
bash "$(dirname "$0")/no-decimal-tostring-cast.selftest.sh"
bash "$(dirname "$0")/no-decimal-tostring-cast.sh"
bash "$(dirname "$0")/no-uncommented-coverage-ignore.selftest.sh"
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
