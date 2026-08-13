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
bunx turbo test -- --coverage
