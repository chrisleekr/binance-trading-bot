import { describe, expect, it } from 'vitest';
import { BacktestStatus } from '@app/contracts';
import { BACKTEST_RUN_STATUSES } from '../src/schema/backtest-runs.js';

// The backtest_runs CHECK constraint duplicates the contract's status enum
// (the DB package stays a leaf and does not import @app/contracts in src).
// This always-on test fails if the two sets drift, so adding a status forces
// updating both the schema/migration and the contract together.
describe('backtest_runs status parity with @app/contracts', () => {
  it('matches BacktestStatus exactly', () => {
    expect([...BACKTEST_RUN_STATUSES].sort()).toEqual([...BacktestStatus.options].sort());
  });
});
