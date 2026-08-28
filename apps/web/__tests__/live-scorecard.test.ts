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
    quoteAsset: 'USDT',
    tradeCount: 0,
    wins: 0,
    losses: 0,
    grossProfit: '0',
    grossLoss: '0',
    totalFees: '0',
    feeBasis: 'exact' as const,
    ...over,
  });

  it('returns a zero bucket for no buckets', () => {
    expect(mergeRollupBuckets([], 'USDT')).toEqual({
      tradeCount: 0,
      wins: 0,
      losses: 0,
      grossProfit: '0',
      grossLoss: '0',
      totalFees: '0',
      feeBasis: 'exact',
    });
  });

  it('sums counts and money fields across buckets', () => {
    const out = mergeRollupBuckets(
      [
        b({
          tradeCount: 3,
          wins: 2,
          losses: 1,
          grossProfit: '50',
          grossLoss: '20',
          totalFees: '1.5',
        }),
        b({
          tradeCount: 2,
          wins: 1,
          losses: 1,
          grossProfit: '10',
          grossLoss: '5',
          totalFees: '0.5',
        }),
      ],
      'USDT',
    );
    expect(out.tradeCount).toBe(5);
    expect(out.wins).toBe(3);
    expect(out.losses).toBe(2);
    expect(Number(out.grossProfit)).toBe(60);
    expect(Number(out.grossLoss)).toBe(25);
    expect(Number(out.totalFees)).toBe(2);
  });

  it('counts only the asked-for currency when a profile changed its quote', () => {
    // The all-time rollup the scorecard requests spans every quote the profile has ever settled in. Magnitudes are orders of magnitude apart so a dropped filter cannot pass by coincidence.
    const out = mergeRollupBuckets(
      [
        b({
          tradeCount: 4,
          wins: 3,
          losses: 1,
          grossProfit: '500',
          grossLoss: '100',
          totalFees: '2',
        }),
        b({
          quoteAsset: 'BTC',
          tradeCount: 7,
          wins: 5,
          losses: 2,
          grossProfit: '0.004',
          grossLoss: '0.001',
          totalFees: '0.00002',
        }),
      ],
      'USDT',
    );
    expect(out.tradeCount).toBe(4);
    expect(out.wins).toBe(3);
    expect(Number(out.grossProfit)).toBe(500);
    expect(Number(out.grossLoss)).toBe(100);
    expect(Number(out.totalFees)).toBe(2);
  });

  it('merges to the weakest fee tier across the buckets it counts', () => {
    // The fifth AND-fold site, and the one the issue misses. The scorecard headline is one number built from several buckets, so it inherits the worst evidence any of them carries; a rank maximum reads a set holding one estimated bucket as fully proven.
    const out = mergeRollupBuckets(
      [
        b({ tradeCount: 2, feeBasis: 'exact' } as Parameters<typeof b>[0]),
        b({ tradeCount: 3, feeBasis: 'estimated' } as Parameters<typeof b>[0]),
      ],
      'USDT',
    );
    expect(out.tradeCount).toBe(5);
    expect(out.feeBasis).toBe('estimated');
  });

  it('merges an all-exact set to exact', () => {
    // The identity. Seeded weaker, every proven scorecard marks itself as a guess and the case above still passes.
    const out = mergeRollupBuckets(
      [
        b({ tradeCount: 2, feeBasis: 'exact' } as Parameters<typeof b>[0]),
        b({ tradeCount: 3, feeBasis: 'exact' } as Parameters<typeof b>[0]),
      ],
      'USDT',
    );
    expect(out.feeBasis).toBe('exact');
  });

  it('ignores the tier of a bucket in another currency', () => {
    // The currency filter runs before the fold, or a BTC-denominated bucket the scorecard is not counting still drags the tier of the one it is.
    const out = mergeRollupBuckets(
      [
        b({ tradeCount: 2, feeBasis: 'exact' } as Parameters<typeof b>[0]),
        b({ quoteAsset: 'BTC', tradeCount: 9, feeBasis: 'unknown' } as Parameters<typeof b>[0]),
      ],
      'USDT',
    );
    expect(out.tradeCount).toBe(2);
    expect(out.feeBasis).toBe('exact');
  });

  it('sums money fields as plain decimal strings, never exponential text', () => {
    // The merged sums are re-stringified and handed to PnlValue, which renders whatever string it is given. `String(1e-7)` is the literal `1e-7`, and it reaches the operator's screen in a column of ordinary decimals. The DOM gate cannot catch this one: it flags a raw decimal, not one laundered through Number first.
    const out = mergeRollupBuckets(
      [
        b({ grossProfit: '0.00000005', grossLoss: '0.00000003', totalFees: '0.00000001' }),
        b({ grossProfit: '0.00000005', grossLoss: '0.00000003', totalFees: '0.00000001' }),
      ],
      'USDT',
    );
    expect(out.grossProfit).toBe('0.0000001');
    expect(out.grossLoss).toBe('0.00000006');
    expect(out.totalFees).toBe('0.00000002');
    for (const value of [out.grossProfit, out.grossLoss, out.totalFees]) {
      expect(value).not.toMatch(/[eE]/);
    }
  });

  it('sums money fields without IEEE-754 drift', () => {
    // 0.1 + 0.2 is the canonical binary-floating-point failure, and the sum is a money field the scorecard prints verbatim.
    const out = mergeRollupBuckets([b({ grossProfit: '0.1' }), b({ grossProfit: '0.2' })], 'USDT');
    expect(out.grossProfit).toBe('0.3');
  });

  it('case-folds the currency it is asked to count', () => {
    // `profiles.quoteAsset` may be stored lower or mixed case while the archive carries Binance's upper casing. A raw compare would drop every bucket and read the scorecard as a profile that has never traded.
    const out = mergeRollupBuckets([b({ tradeCount: 3, grossProfit: '50' })], 'usdt');
    expect(out.tradeCount).toBe(3);
    expect(Number(out.grossProfit)).toBe(50);
  });
});
