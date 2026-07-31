import { describe, expect, it } from 'vitest';
import {
  compactMetrics,
  HISTORY_CAP,
  HISTORY_METRIC_KEYS,
  shapePriorRuns,
  type PriorRunRow,
} from '../src/advisor.js';

const row = (backtestSignature: string, params: unknown, outcome: unknown): PriorRunRow => ({
  backtestSignature,
  params,
  outcome,
});

describe('compactMetrics', () => {
  it('keeps only the headline metric keys, dropping the rest', () => {
    const outcome = {
      totalReturnPct: 12,
      alphaVsHoldPct: 3,
      totalTrades: 40,
      winRate: 0.55,
      maxDrawdownPct: 8,
      profitFactor: 1.4,
      sharpe: 0.9,
      // Extra fields the ledger might carry that the advisor must not receive.
      equityCurve: [1, 2, 3],
      notes: 'ignore me',
    };
    const out = compactMetrics(outcome);
    expect(Object.keys(out).sort()).toEqual([...HISTORY_METRIC_KEYS].sort());
    expect(out.totalReturnPct).toBe(12);
    expect(out).not.toHaveProperty('equityCurve');
    expect(out).not.toHaveProperty('notes');
  });

  it('omits keys absent from the outcome', () => {
    expect(compactMetrics({ totalReturnPct: 5 })).toEqual({ totalReturnPct: 5 });
  });

  it('returns an empty object for nullish outcomes', () => {
    expect(compactMetrics(null)).toEqual({});
    expect(compactMetrics(undefined)).toEqual({});
  });
});

describe('shapePriorRuns', () => {
  it('excludes the current run by its stored signature', () => {
    const rows: PriorRunRow[] = [
      row('sig-current', { a: 1 }, { totalReturnPct: 1 }),
      row('sig-other', { a: 2 }, { totalReturnPct: 2 }),
    ];
    const out = shapePriorRuns(rows, 'sig-current');
    expect(out.total).toBe(1);
    expect(out.sample).toEqual([{ config: { a: 2 }, metrics: { totalReturnPct: 2 } }]);
  });

  it('maps config from params and compacts metrics from outcome', () => {
    const out = shapePriorRuns(
      [row('s', { lookback: 20 }, { totalReturnPct: 7, extra: 'x' })],
      'current',
    );
    expect(out.sample).toEqual([{ config: { lookback: 20 }, metrics: { totalReturnPct: 7 } }]);
  });

  it('caps the sample at HISTORY_CAP but reports the full excluded count as total', () => {
    const rows: PriorRunRow[] = Array.from({ length: HISTORY_CAP + 5 }, (_, i) =>
      row(`sig-${i}`, { i }, { totalReturnPct: i }),
    );
    const out = shapePriorRuns(rows, 'none-match');
    expect(out.total).toBe(HISTORY_CAP + 5);
    expect(out.sample).toHaveLength(HISTORY_CAP);
    expect(out.sample[0]).toEqual({ config: { i: 0 }, metrics: { totalReturnPct: 0 } });
  });

  it('preserves the fetched (newest-first) order and does not reorder', () => {
    const rows: PriorRunRow[] = [row('a', { n: 'first' }, {}), row('b', { n: 'second' }, {})];
    const out = shapePriorRuns(rows, null);
    expect(out.sample.map((s) => (s.config as { n: string }).n)).toEqual(['first', 'second']);
  });

  it('returns everything when currentSignature is null (no exclusion)', () => {
    const rows: PriorRunRow[] = [row('a', {}, {}), row('b', {}, {})];
    expect(shapePriorRuns(rows, null).total).toBe(2);
  });
});
