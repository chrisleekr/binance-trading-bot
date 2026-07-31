import { describe, expect, it } from 'vitest';
import { runBacktest } from '../src/run.js';
import { IdealFillModel } from '../src/ideal-fill.js';
import { candleSource, diagStrategy, flatCandles, SYMBOL, SYMBOL_INFO } from './_fixtures.js';

const baseOpts = {
  request: { symbols: [SYMBOL], intervals: ['1m'] as const, fromMs: 0, toMs: 600_000 },
  initialBalances: { USDT: '1000' },
  quoteAsset: 'USDT',
  symbolInfos: [SYMBOL_INFO],
  config: {},
  fillModel: new IdealFillModel(),
};

describe('runBacktest — decisionBreakdown', () => {
  it('aggregates per-tick metrics by (name, tags) and logs by (message, reason)', async () => {
    const report = await runBacktest({
      ...baseOpts,
      strategy: diagStrategy,
      dataSource: candleSource(flatCandles(6, '100')),
    });
    const { metrics, logs } = report.decisionBreakdown;

    // 6 ticks → diag_skip every tick, diag_emit on the 3 even ticks.
    expect(metrics.find((e) => e.name === 'diag_skip')).toMatchObject({
      count: 6,
      tags: { symbol: SYMBOL, reason: 'r1' },
    });
    expect(metrics.find((e) => e.name === 'diag_emit')).toMatchObject({ count: 3 });
    // Sorted most-frequent first: diag_skip (6) precedes diag_emit (3).
    expect(metrics[0]?.name).toBe('diag_skip');
    // The gauge (value = n + 0.5, never 1) is excluded: counting a continuous
    // reading is meaningless, so it must not appear as a decision bucket.
    expect(metrics.find((e) => e.name === 'diag_gauge')).toBeUndefined();

    // Logs: the veto carries a reason; the note has none → null.
    expect(logs.find((e) => e.message === 'diag-veto')).toMatchObject({
      count: 6,
      reason: 'gate-x',
    });
    expect(logs.find((e) => e.message === 'diag-note')).toMatchObject({ count: 6, reason: null });
  });

  it('is empty for a run with no candles', async () => {
    const report = await runBacktest({
      ...baseOpts,
      strategy: diagStrategy,
      dataSource: candleSource([]),
    });
    expect(report.decisionBreakdown).toEqual({ metrics: [], logs: [] });
  });

  it('excludes warm-up ticks (they never reach the strategy)', async () => {
    const report = await runBacktest({
      ...baseOpts,
      strategy: diagStrategy,
      dataSource: candleSource(flatCandles(6, '100')),
      startupCandleCount: 2,
    });
    // 6 candles, 2 consumed for warm-up → 4 ticks.
    expect(report.decisionBreakdown.metrics.find((e) => e.name === 'diag_skip')?.count).toBe(4);
  });
});
