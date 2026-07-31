#!/usr/bin/env bash
set -euo pipefail
# Strategy golden-fixture replay + backtest gates (#47/11.07, 11.03).
#
# 1. Runs every committed scenario under
#    `packages/strategy/trailing-trade/fixtures/replay/synthesised/*.jsonl`
#    through `trailingTrade.tick` and asserts diff = 0.
# 2. Runs the backtest engine suite, including the hermetic golden-fixture
#    gate (TT replayed over a committed candle series → snapshotted
#    BacktestReport; any numeric drift fails) and the determinism check.
#
# The strategy unit suites also run under `turbo test` (the test-unit job).
# These two lines are the explicit golden-fixture replay gate (quality gate
# #5): a named, fast-failing job whose only assertion is a frozen diff, run
# with the same command a developer uses locally so the fail mode is identical
# between local and CI.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start test-replay
bun --filter @app/strategy-trailing-trade test:replay
bun --filter @app/strategy-momentum test:replay
bun --filter @app/strategy-backtest test
# Worker frame-trace record->replay gate: a committed production-frame fixture
# replayed through the REAL buildTickInput + strategy.tick, asserting decision
# drift = 0. Runs without Postgres/testcontainers (every boundary is stubbed).
bun --filter @app/worker test:frame-replay
