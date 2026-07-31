import type { EquitySnapshotPoint } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import { maxDrawdownQuote, mergeRollupBuckets } from '@/shared/lib/live-scorecard';

const pt = (netPnlQuote: string): EquitySnapshotPoint =>
  ({
    capturedAt: '2026-06-19T00:00:00.000Z',
    netPnlQuote,
    realizedNetQuote: '0',
    positionValueQuote: '0',
    positionCostQuote: '0',
    benchmarkAsset: 'BTC',
    benchmarkPriceQuote: '0',
  }) as EquitySnapshotPoint;

describe('maxDrawdownQuote', () => {
  it('is 0 for no points or a monotonically rising curve', () => {
    expect(maxDrawdownQuote(undefined)).toBe(0);
    expect(maxDrawdownQuote([])).toBe(0);
    expect(maxDrawdownQuote(['0', '10', '20'].map(pt))).toBe(0);
  });

  it('takes the largest peak-to-trough give-back', () => {
    // peak 20 → 5 (dd 15); peak 30 → 10 (dd 20). Max is 20.
    expect(maxDrawdownQuote(['0', '20', '5', '30', '10'].map(pt))).toBe(20);
  });

  it('works on an all-negative P/L curve', () => {
    // peak -5, trough -20 → dd 15.
    expect(maxDrawdownQuote(['-5', '-20', '-10'].map(pt))).toBe(15);
  });
});

describe('mergeRollupBuckets', () => {
  const b = (over: Partial<Parameters<typeof mergeRollupBuckets>[0][number]>) => ({
    tradeCount: 0,
    wins: 0,
    losses: 0,
    grossProfit: '0',
    grossLoss: '0',
    totalFees: '0',
    ...over,
  });

  it('returns a zero bucket for no buckets', () => {
    expect(mergeRollupBuckets([])).toEqual({
      tradeCount: 0,
      wins: 0,
      losses: 0,
      grossProfit: '0',
      grossLoss: '0',
      totalFees: '0',
    });
  });

  it('sums counts and money fields across buckets', () => {
    const out = mergeRollupBuckets([
      b({
        tradeCount: 3,
        wins: 2,
        losses: 1,
        grossProfit: '50',
        grossLoss: '20',
        totalFees: '1.5',
      }),
      b({ tradeCount: 2, wins: 1, losses: 1, grossProfit: '10', grossLoss: '5', totalFees: '0.5' }),
    ]);
    expect(out.tradeCount).toBe(5);
    expect(out.wins).toBe(3);
    expect(out.losses).toBe(2);
    expect(Number(out.grossProfit)).toBe(60);
    expect(Number(out.grossLoss)).toBe(25);
    expect(Number(out.totalFees)).toBe(2);
  });
});
