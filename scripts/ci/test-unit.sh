#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start test-unit
# `-- --coverage` forwards the flag through turbo to each package's `vitest run`,
# which activates the per-package thresholds registered in
# packages/config/vitest/index.js. Without it the 100% line/branch gate on the
# pure money-path packages (strategy-*, indicators, binance, discovery) never
# fires and a coverage regression ships green. Only packages that opt in via
# `defineProject({ packageName })` enforce a threshold; the rest collect
# coverage harmlessly. The unit job has no Postgres: the threshold-gated
# packages are all pure and run fully here; db/api/worker also run but
# self-skip their Postgres-bound suites (`describe.skipIf` on
# DATABASE_TEST_URL) and carry no enforced threshold, so neither blocks the gate.
bunx turbo test -- --coverage
