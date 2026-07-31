import { describe, expect, it } from 'vitest';
import {
  type ArchiveRollupItem,
  coerceArchivedOrders,
  deriveExitIntent,
  rollupByExitIntent,
  rollupBySource,
} from '../src/archive.js';

/** Build a rollup input row, defaulting the fields a given assertion doesn't care about. */
function item(partial: Partial<ArchiveRollupItem> & { profit: string }): ArchiveRollupItem {
  return {
    quoteAsset: 'USDT',
    source: 'auto',
    orders: [{ side: 'SELL', intent: 'grid-sell' }],
    ...partial,
  };
}

describe('deriveExitIntent', () => {
  it('returns the intent of the last SELL order in the cycle', () => {
    expect(
      deriveExitIntent([
        { side: 'BUY', intent: 'grid-buy' },
        { side: 'SELL', intent: 'grid-stop-loss' },
      ]),
    ).toBe('grid-stop-loss');
  });

  it('uses the LAST SELL when several sells exist', () => {
    expect(
      deriveExitIntent([
        { side: 'BUY', intent: 'grid-buy' },
        { side: 'SELL', intent: 'grid-sell' },
        { side: 'SELL', intent: 'technicals-force-sell' },
      ]),
    ).toBe('technicals-force-sell');
  });

  it('reports a recovered SELL under the intent the strategy MEANT, not its reserved row intent', () => {
    // A recovery row (an order live on Binance whose normal write failed) is stored
    // under `<intent>:untracked:<binanceOrderId>` — unique per exchange order by
    // construction. Bucketing on that verbatim would give every recovered sell its
    // own one-row bucket in the by-exit-intent rollup instead of joining `exit`.
    expect(
      deriveExitIntent([
        { side: 'BUY', intent: 'entry' },
        { side: 'SELL', intent: 'exit:untracked:998877' },
      ]),
    ).toBe('exit');
  });

  it("returns 'unknown' when there is no SELL order", () => {
    expect(deriveExitIntent([{ side: 'BUY', intent: 'grid-buy' }])).toBe('unknown');
    expect(deriveExitIntent([])).toBe('unknown');
  });

  it("returns 'unknown' when the last element has no `side` field", () => {
    // A legacy/malformed element missing `side` is not a SELL, so the cycle
    // reads as 'unknown' rather than throwing. The route's coerce guard would
    // normally drop such an element; this pins deriveExitIntent's own behaviour.
    expect(
      deriveExitIntent([{ intent: 'x' } as unknown as { side: string; intent?: string | null }]),
    ).toBe('unknown');
  });

  it("returns 'unknown' for a closing SELL whose intent is null or absent", () => {
    expect(deriveExitIntent([{ side: 'SELL', intent: null }])).toBe('unknown');
    expect(deriveExitIntent([{ side: 'SELL' }])).toBe('unknown');
  });
});

describe('coerceArchivedOrders', () => {
  it('returns [] for any non-array value', () => {
    expect(coerceArchivedOrders(null)).toEqual([]);
    expect(coerceArchivedOrders({})).toEqual([]);
    expect(coerceArchivedOrders('x')).toEqual([]);
  });

  it('drops elements with no `side` or a non-string `side`', () => {
    expect(coerceArchivedOrders([{ intent: 'grid-sell' }])).toEqual([]);
    expect(coerceArchivedOrders([{ side: 42, intent: 'grid-sell' }])).toEqual([]);
  });

  it('drops a null element', () => {
    expect(coerceArchivedOrders([null, { side: 'SELL', intent: 'grid-sell' }])).toEqual([
      { side: 'SELL', intent: 'grid-sell' },
    ]);
  });

  it('drops a non-object primitive element', () => {
    expect(coerceArchivedOrders([42, 'SELL', true, { side: 'SELL' }])).toEqual([
      { side: 'SELL', intent: null },
    ]);
  });

  it('keeps a well-formed element with a string intent as-is', () => {
    expect(coerceArchivedOrders([{ side: 'SELL', intent: 'stop' }])).toEqual([
      { side: 'SELL', intent: 'stop' },
    ]);
  });

  it('coerces a non-string or absent intent to null', () => {
    expect(coerceArchivedOrders([{ side: 'SELL', intent: 42 }])).toEqual([
      { side: 'SELL', intent: null },
    ]);
    expect(coerceArchivedOrders([{ side: 'SELL' }])).toEqual([{ side: 'SELL', intent: null }]);
  });

  it('round-trips raw JSONB through deriveExitIntent', () => {
    const raw: unknown = [
      { side: 'BUY', intent: 'grid-buy' },
      { side: 'SELL', intent: 'grid-stop-loss' },
    ];
    expect(deriveExitIntent(coerceArchivedOrders(raw))).toBe('grid-stop-loss');
  });
});

describe('rollupByExitIntent', () => {
  it('groups by exit intent with the win/loss split and gross magnitudes', () => {
    const rollup = rollupByExitIntent([
      item({ profit: '-5', orders: [{ side: 'SELL', intent: 'grid-stop-loss' }] }),
      item({ profit: '0.4', orders: [{ side: 'SELL', intent: 'technicals-force-sell' }] }),
    ]);

    expect(rollup).toContainEqual({
      quoteAsset: 'USDT',
      intent: 'grid-stop-loss',
      tradeCount: 1,
      wins: 0,
      losses: 1,
      profitSum: '-5',
      netProfit: '-5',
      grossProfit: '0',
      grossLoss: '5',
      totalFees: '0',
    });
    expect(rollup).toContainEqual({
      quoteAsset: 'USDT',
      intent: 'technicals-force-sell',
      tradeCount: 1,
      wins: 1,
      losses: 0,
      profitSum: '0.4',
      netProfit: '0.4',
      grossProfit: '0.4',
      grossLoss: '0',
      totalFees: '0',
    });
  });

  it('separates gross winners from gross losers within one intent bucket', () => {
    const rollup = rollupByExitIntent([
      item({ profit: '2' }),
      item({ profit: '-0.5' }),
      item({ profit: '1' }),
    ]);
    // net = 2.5, gross win = 3, gross loss = 0.5, 2 wins / 1 loss.
    expect(rollup).toEqual([
      {
        quoteAsset: 'USDT',
        intent: 'grid-sell',
        tradeCount: 3,
        wins: 2,
        losses: 1,
        profitSum: '2.5',
        netProfit: '2.5',
        grossProfit: '3',
        grossLoss: '0.5',
        totalFees: '0',
      },
    ]);
  });

  it('counts a breakeven trade (profit 0) as a trade but neither win nor loss', () => {
    const rollup = rollupByExitIntent([item({ profit: '0' })]);
    expect(rollup).toEqual([
      {
        quoteAsset: 'USDT',
        intent: 'grid-sell',
        tradeCount: 1,
        wins: 0,
        losses: 0,
        profitSum: '0',
        netProfit: '0',
        grossProfit: '0',
        grossLoss: '0',
        totalFees: '0',
      },
    ]);
  });

  it('sums profit per bucket without IEEE-754 drift', () => {
    const rollup = rollupByExitIntent([item({ profit: '0.1' }), item({ profit: '0.2' })]);
    expect(rollup[0]?.profitSum).toBe('0.3');
    expect(rollup[0]?.grossProfit).toBe('0.3');
  });

  it('keys buckets by (quoteAsset, intent) so the same intent on two quotes stays split', () => {
    const rollup = rollupByExitIntent([
      item({ quoteAsset: 'USDT', profit: '1' }),
      item({ quoteAsset: 'BTC', profit: '2' }),
    ]);
    // Deterministic order: quoteAsset ascending (BTC before USDT).
    expect(rollup.map((b) => b.quoteAsset)).toEqual(['BTC', 'USDT']);
  });

  it("buckets cycles with no closing SELL under 'unknown' instead of dropping them", () => {
    const rollup = rollupByExitIntent([
      item({ profit: '3', orders: [{ side: 'BUY', intent: 'grid-buy' }] }),
    ]);
    expect(rollup[0]?.intent).toBe('unknown');
    expect(rollup[0]?.tradeCount).toBe(1);
  });

  it('returns an empty array for empty input', () => {
    expect(rollupByExitIntent([])).toEqual([]);
  });
});

describe('rollupBySource', () => {
  it('groups by source with the same metrics, ignoring exit intent', () => {
    const rollup = rollupBySource([
      item({ source: 'auto', profit: '-1', orders: [{ side: 'SELL', intent: 'grid-stop-loss' }] }),
      item({ source: 'auto', profit: '3', orders: [{ side: 'SELL', intent: 'grid-sell' }] }),
      item({ source: 'manual', profit: '0.5', orders: [{ side: 'SELL', intent: 'manual' }] }),
    ]);
    expect(rollup).toEqual([
      {
        quoteAsset: 'USDT',
        source: 'auto',
        tradeCount: 2,
        wins: 1,
        losses: 1,
        profitSum: '2',
        netProfit: '2',
        grossProfit: '3',
        grossLoss: '1',
        totalFees: '0',
      },
      {
        quoteAsset: 'USDT',
        source: 'manual',
        tradeCount: 1,
        wins: 1,
        losses: 0,
        profitSum: '0.5',
        netProfit: '0.5',
        grossProfit: '0.5',
        grossLoss: '0',
        totalFees: '0',
      },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(rollupBySource([])).toEqual([]);
  });
});

describe('rollupByExitIntent net-of-fee classification', () => {
  it('classifies a gross-win whose fees exceed it as a NET loss', () => {
    // Gross +1, but 1.5 of fees → net −0.5: a loss, not a win.
    const rollup = rollupByExitIntent([item({ profit: '1', feesQuote: '1.5' })]);
    expect(rollup).toEqual([
      {
        quoteAsset: 'USDT',
        intent: 'grid-sell',
        tradeCount: 1,
        wins: 0,
        losses: 1,
        profitSum: '1',
        netProfit: '-0.5',
        grossProfit: '0',
        grossLoss: '0.5',
        totalFees: '1.5',
      },
    ]);
  });

  it('sums fees and keeps net = gross − fees across a bucket', () => {
    const rollup = rollupByExitIntent([
      item({ profit: '3', feesQuote: '0.2' }),
      item({ profit: '2', feesQuote: '0.3' }),
    ]);
    const b = rollup[0];
    expect(b?.profitSum).toBe('5');
    expect(b?.totalFees).toBe('0.5');
    expect(b?.netProfit).toBe('4.5');
    // Both still net-positive → 2 wins, gross winners net of their own fees.
    expect(b?.wins).toBe(2);
    expect(b?.grossProfit).toBe('4.5');
  });
});
