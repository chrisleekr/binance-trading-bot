#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start test-unit
export COVERAGE_LANE=unit
# `-- --coverage` forwards the flag through turbo to each package's `vitest run`,
# which activates the per-package thresholds registered in
# packages/config/vitest/index.js. Without it the 100% line/branch gate on the
# pure money-path packages never fires and a coverage regression ships green.
# Infrastructure-backed thresholds are bound to their own complete-suite lanes,
# so their partial runs here collect evidence without applying the wrong floor.
# Cap turbo fan-out: turbo's default runs every package's `vitest run` at once and
# each of those forks one worker per core, so the runner ends up oversubscribed
# several times over. Starved renders then crest the per-suite timeouts and the
# lane fails on contention rather than on a defect.
#
# `--continue=dependencies-successful` so one package's failing suite does not cancel the packages queued behind it: without it turbo stops at the first non-zero exit and the run reports one failure while leaving the rest of the workspace unrun and unreported. The cap bounds how many run at once; this bounds what a failure takes down with it.
bunx turbo test --concurrency=2 --continue=dependencies-successful -- --coverage
