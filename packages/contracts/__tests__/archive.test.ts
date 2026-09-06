import { describe, expect, it } from 'vitest';
import {
  coerceArchivedOrderDetails,
  type ArchiveRollupItem,
  coerceArchivedOrders,
  deriveEntryAt,
  deriveExitAt,
  deriveExitIntent,
  holdMsBetween,
  ProfileArchiveListResponse,
  rollupByExitIntent,
  rollupBySource,
  summarizeClosedTrades,
  TradeArchiveResponse,
  weakestFeeBasis,
} from '../src/archive.js';

/** Build a rollup input row, defaulting the fields a given assertion doesn't care about. */
function item(partial: Partial<ArchiveRollupItem> & { profit: string }): ArchiveRollupItem {
  return {
    quoteAsset: 'USDT',
    source: 'auto',
    feeBasis: 'exact',
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

  it('falls back to the LAST SELL when no sell carries a closedAt stamp', () => {
    expect(
      deriveExitIntent([
        { side: 'BUY', intent: 'grid-buy' },
        { side: 'SELL', intent: 'grid-sell' },
        { side: 'SELL', intent: 'technicals-force-sell' },
      ]),
    ).toBe('technicals-force-sell');
  });

  it('picks the LATEST sell by closedAt, not the last array element', () => {
    // The forward archive writes `desc(closedAt)`, so its LAST SELL is the cycle's FIRST exit. Reading by position reported that first exit as the reason the cycle closed.
    expect(
      deriveExitIntent([
        { side: 'SELL', intent: 'protective-stop', closedAt: '2026-08-20T03:00:00.000Z' },
        { side: 'SELL', intent: 'grid-sell', closedAt: '2026-08-20T02:00:00.000Z' },
        { side: 'BUY', intent: 'grid-buy', closedAt: '2026-08-20T01:00:00.000Z' },
      ]),
    ).toBe('protective-stop');
  });

  it('picks the LATEST sell when the closing order sits mid-array', () => {
    // The backfill emits Map-insertion order keyed on each order's FIRST fill, so a SELL that partially fills, yields to a second SELL, then flattens the position lands BEFORE that second SELL.
    expect(
      deriveExitIntent([
        { side: 'BUY', intent: 'backfill', closedAt: '2026-08-20T01:00:00.000Z' },
        { side: 'SELL', intent: 'grid-sell', closedAt: '2026-08-20T04:00:00.000Z' },
        { side: 'SELL', intent: 'backfill', closedAt: '2026-08-20T03:00:00.000Z' },
      ]),
    ).toBe('grid-sell');
  });

  it('lets one stamped sell beat every unstamped sell regardless of position', () => {
    // Asserted in both orderings: a stamped sell that happens to sit last would pass on position alone, so only the mirrored pair proves the stamp is what wins.
    expect(
      deriveExitIntent([
        { side: 'SELL', intent: 'grid-sell', closedAt: '2026-08-20T04:00:00.000Z' },
        { side: 'SELL', intent: 'backfill' },
      ]),
    ).toBe('grid-sell');
    expect(
      deriveExitIntent([
        { side: 'SELL', intent: 'backfill' },
        { side: 'SELL', intent: 'grid-sell', closedAt: '2026-08-20T04:00:00.000Z' },
      ]),
    ).toBe('grid-sell');
  });

  it('ignores an unparseable closedAt rather than ordering by it', () => {
    expect(
      deriveExitIntent([
        { side: 'SELL', intent: 'grid-sell', closedAt: '2026-08-20T04:00:00.000Z' },
        { side: 'SELL', intent: 'backfill', closedAt: 'not-a-date' },
      ]),
    ).toBe('grid-sell');
  });

  it('keeps the later array element when two sells share a closedAt', () => {
    expect(
      deriveExitIntent([
        { side: 'SELL', intent: 'grid-sell', closedAt: '2026-08-20T04:00:00.000Z' },
        { side: 'SELL', intent: 'protective-stop', closedAt: '2026-08-20T04:00:00.000Z' },
      ]),
    ).toBe('protective-stop');
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

describe('deriveEntryAt / deriveExitAt', () => {
  it('takes the earliest BUY and the latest SELL, never the array ends', () => {
    // The forward archive writes `desc(closedAt)` and the backfill writes Map-insertion order, so first-and-last would read the window backwards in one writer and at random in the other.
    const orders = [
      { side: 'SELL', closedAt: '2026-08-20T05:00:00.000Z' },
      { side: 'BUY', closedAt: '2026-08-20T02:00:00.000Z' },
      { side: 'SELL', closedAt: '2026-08-20T09:00:00.000Z' },
      { side: 'BUY', closedAt: '2026-08-20T01:00:00.000Z' },
    ];
    expect(deriveEntryAt(orders)).toBe('2026-08-20T01:00:00.000Z');
    expect(deriveExitAt(orders)).toBe('2026-08-20T09:00:00.000Z');
  });

  it('returns null rather than a zero-length window when a side carries no stamp', () => {
    // The backfilled rows: a cycle whose reconstructed orders have no BUY stamp has no entry time, and reporting one would put a fabricated instant on screen as a measured hold of nothing.
    expect(deriveEntryAt([{ side: 'SELL', closedAt: '2026-08-20T09:00:00.000Z' }])).toBeNull();
    expect(deriveExitAt([{ side: 'BUY', closedAt: '2026-08-20T01:00:00.000Z' }])).toBeNull();
    expect(deriveEntryAt([{ side: 'BUY', closedAt: null }])).toBeNull();
    expect(deriveEntryAt([])).toBeNull();
  });

  it('ignores an unparseable stamp instead of ordering by it', () => {
    expect(
      deriveEntryAt([
        { side: 'BUY', closedAt: 'not-a-date' },
        { side: 'BUY', closedAt: '2026-08-20T02:00:00.000Z' },
      ]),
    ).toBe('2026-08-20T02:00:00.000Z');
  });
});

describe('rollup average hold', () => {
  it('averages over the cycles it could time, and reports null when it could time none', () => {
    const timed = rollupByExitIntent([
      item({
        profit: '1',
        orders: [
          { side: 'BUY', intent: 'entry', closedAt: '2026-08-20T00:00:00.000Z' },
          { side: 'SELL', intent: 'grid-sell', closedAt: '2026-08-20T02:00:00.000Z' },
        ],
      }),
      item({
        profit: '1',
        orders: [
          { side: 'BUY', intent: 'entry', closedAt: '2026-08-20T00:00:00.000Z' },
          { side: 'SELL', intent: 'grid-sell', closedAt: '2026-08-20T04:00:00.000Z' },
        ],
      }),
      // Untimeable, and therefore not a zero in the average: it is counted as a trade and left out of the mean.
      item({ profit: '1', orders: [{ side: 'SELL', intent: 'grid-sell' }] }),
    ])[0];
    expect(timed?.tradeCount).toBe(3);
    expect(timed?.avgHoldMs).toBe(3 * 60 * 60 * 1000);

    expect(rollupByExitIntent([item({ profit: '1' })])[0]?.avgHoldMs).toBeNull();
  });
});

describe('holdMsBetween', () => {
  const T0 = '2026-08-20T00:00:00.000Z';
  const T2 = '2026-08-20T02:00:00.000Z';

  it('measures the span between two stamps', () => {
    expect(holdMsBetween(T0, T2)).toBe(2 * 60 * 60 * 1000);
  });

  it('is null when either end is unstamped, which is not a hold of zero', () => {
    expect(holdMsBetween(null, T2)).toBeNull();
    expect(holdMsBetween(T0, null)).toBeNull();
  });

  it('drops a NEGATIVE span rather than reporting it as a duration', () => {
    // The one rule all three surfaces now share. A negative span means the two stamps came from orders that cannot both belong to this cycle. Reported as a number it sorts FIRST under an ascending hold sort and renders as `1m`, the shortest hold the formatter can express — the archive's fastest trade, fabricated.
    expect(holdMsBetween(T2, T0)).toBeNull();
  });

  it('drops an unparseable stamp rather than yielding NaN', () => {
    expect(holdMsBetween('not-a-time', T2)).toBeNull();
    expect(holdMsBetween(T0, 'not-a-time')).toBeNull();
  });

  it('keeps a zero-length span, which is a measurement and not a missing one', () => {
    expect(holdMsBetween(T0, T0)).toBe(0);
  });
});

describe('rollupByExitIntent hold averaging', () => {
  it('leaves a cycle whose stamps run backwards out of the average entirely', () => {
    // Fed through the rollup rather than the helper alone, so the delegation is what is pinned: a copy of the span rule inside the fold could still drop the guard.
    const rolled = rollupByExitIntent([
      item({
        profit: '1',
        orders: [
          { side: 'BUY', intent: 'entry', closedAt: '2026-08-20T04:00:00.000Z' },
          { side: 'SELL', intent: 'grid-sell', closedAt: '2026-08-20T00:00:00.000Z' },
        ],
      }),
      item({
        profit: '1',
        orders: [
          { side: 'BUY', intent: 'entry', closedAt: '2026-08-20T00:00:00.000Z' },
          { side: 'SELL', intent: 'grid-sell', closedAt: '2026-08-20T02:00:00.000Z' },
        ],
      }),
    ])[0];
    expect(rolled?.tradeCount).toBe(2);
    expect(rolled?.avgHoldMs).toBe(2 * 60 * 60 * 1000);
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
      { side: 'SELL', intent: 'grid-sell', closedAt: null },
    ]);
  });

  it('drops a non-object primitive element', () => {
    expect(coerceArchivedOrders([42, 'SELL', true, { side: 'SELL' }])).toEqual([
      { side: 'SELL', intent: null, closedAt: null },
    ]);
  });

  it('keeps a well-formed element with a string intent, normalising the absent closedAt', () => {
    expect(coerceArchivedOrders([{ side: 'SELL', intent: 'stop' }])).toEqual([
      { side: 'SELL', intent: 'stop', closedAt: null },
    ]);
  });

  it('coerces a non-string or absent intent to null', () => {
    expect(coerceArchivedOrders([{ side: 'SELL', intent: 42 }])).toEqual([
      { side: 'SELL', intent: null, closedAt: null },
    ]);
    expect(coerceArchivedOrders([{ side: 'SELL' }])).toEqual([
      { side: 'SELL', intent: null, closedAt: null },
    ]);
  });

  it('carries a string closedAt and nulls a non-string one', () => {
    // deriveExitIntent orders by this field, so dropping it here would silently restore position-based selection.
    expect(
      coerceArchivedOrders([
        { side: 'SELL', intent: 'grid-sell', closedAt: '2026-08-20T04:00:00.000Z' },
        { side: 'SELL', intent: 'grid-sell', closedAt: 1_755_000_000_000 },
      ]),
    ).toEqual([
      { side: 'SELL', intent: 'grid-sell', closedAt: '2026-08-20T04:00:00.000Z' },
      { side: 'SELL', intent: 'grid-sell', closedAt: null },
    ]);
  });

  it('orders by closedAt after the JSONB round-trip', () => {
    // The joint contract: coerce must carry `closedAt` AND derive must order by it. Either half regressing alone puts this array's FIRST sell back on the label, which is exactly the shipped bug.
    const raw: unknown = [
      { side: 'SELL', intent: 'protective-stop', closedAt: '2026-08-20T03:00:00.000Z' },
      { side: 'SELL', intent: 'grid-sell', closedAt: '2026-08-20T02:00:00.000Z' },
    ];
    expect(deriveExitIntent(coerceArchivedOrders(raw))).toBe('protective-stop');
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
  it('buckets a multi-sell cycle under its LATEST sell, not its last array element', () => {
    // The rollup is the surface the operator reads to decide whether a strategy's stops are firing too often, and it shares deriveExitIntent with the row badge. A `desc(closedAt)` array put this cycle in the `grid-sell` bucket while the badge on the same row said `protective-stop`.
    const rollup = rollupByExitIntent([
      item({
        profit: '-5',
        orders: [
          { side: 'SELL', intent: 'protective-stop', closedAt: '2026-08-20T03:00:00.000Z' },
          { side: 'SELL', intent: 'grid-sell', closedAt: '2026-08-20T02:00:00.000Z' },
        ],
      }),
    ]);

    expect(rollup.map((b) => b.intent)).toEqual(['protective-stop']);
  });

  it('groups by exit intent with the win/loss split and gross magnitudes', () => {
    const rollup = rollupByExitIntent([
      item({ profit: '-5', orders: [{ side: 'SELL', intent: 'grid-stop-loss' }] }),
      item({ profit: '0.4', orders: [{ side: 'SELL', intent: 'technicals-force-sell' }] }),
    ]);

    expect(rollup).toContainEqual({
      quoteAsset: 'USDT',
      intent: 'grid-stop-loss',
      tradeCount: 1,
      netTradeCount: 1,
      wins: 0,
      losses: 1,
      profitSum: '-5',
      netProfit: '-5',
      grossProfit: '0',
      grossLoss: '5',
      totalFees: '0',
      feeBasis: 'exact',
      avgHoldMs: null,
    });
    expect(rollup).toContainEqual({
      quoteAsset: 'USDT',
      intent: 'technicals-force-sell',
      tradeCount: 1,
      netTradeCount: 1,
      wins: 1,
      losses: 0,
      profitSum: '0.4',
      netProfit: '0.4',
      grossProfit: '0.4',
      grossLoss: '0',
      totalFees: '0',
      feeBasis: 'exact',
      avgHoldMs: null,
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
        netTradeCount: 3,
        wins: 2,
        losses: 1,
        profitSum: '2.5',
        netProfit: '2.5',
        grossProfit: '3',
        grossLoss: '0.5',
        totalFees: '0',
        feeBasis: 'exact',
        avgHoldMs: null,
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
        netTradeCount: 1,
        wins: 0,
        losses: 0,
        profitSum: '0',
        netProfit: '0',
        grossProfit: '0',
        grossLoss: '0',
        totalFees: '0',
        feeBasis: 'exact',
        avgHoldMs: null,
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
        netTradeCount: 2,
        wins: 1,
        losses: 1,
        profitSum: '2',
        netProfit: '2',
        grossProfit: '3',
        grossLoss: '1',
        totalFees: '0',
        feeBasis: 'exact',
        avgHoldMs: null,
      },
      {
        quoteAsset: 'USDT',
        source: 'manual',
        tradeCount: 1,
        netTradeCount: 1,
        wins: 1,
        losses: 0,
        profitSum: '0.5',
        netProfit: '0.5',
        grossProfit: '0.5',
        grossLoss: '0',
        totalFees: '0',
        feeBasis: 'exact',
        avgHoldMs: null,
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
        netTradeCount: 1,
        wins: 0,
        losses: 1,
        profitSum: '1',
        netProfit: '-0.5',
        grossProfit: '0',
        grossLoss: '0.5',
        totalFees: '1.5',
        feeBasis: 'exact',
        avgHoldMs: null,
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

  it('propagates incompleteness independently of a numeric zero subtotal', () => {
    const completeZero = rollupByExitIntent([
      item({ profit: '1', feesQuote: '0', feeBasis: 'exact' }),
    ])[0];
    const incompleteZero = rollupByExitIntent([
      item({ profit: '1', feesQuote: '0', feeBasis: 'unknown' }),
    ])[0];
    expect(completeZero?.feeBasis).toBe('exact');
    expect(incompleteZero?.feeBasis).toBe('unknown');
    // Both buckets hold one row at a zero fee, so neither Net subtotal can be told from a bucket that summed nothing by its amount. The tier and the covered count are what carry that fact: the valued bucket sums its one row, the unvalued bucket sums none.
    expect(completeZero?.netTradeCount).toBe(1);
    expect(incompleteZero?.netTradeCount).toBe(0);
  });

  it('sums Net over only the rows carrying fee evidence', () => {
    // Net is one subtraction over the whole bucket, so a row with no fee evidence donates its gross profit to the subtraction and absorbs a fee it never proved: the valued row's 1 is charged against the unvalued row's 5, and the bucket reports a Net nothing in it supports. Net must span the valued rows alone, with its own count, while Recorded keeps spanning every row.
    const rollup = rollupByExitIntent([
      item({ profit: '10', feesQuote: '1', feeBasis: 'exact' }),
      item({ profit: '5', feeBasis: 'unknown' }),
    ]);
    const b = rollup[0];

    expect(b?.netProfit).toBe('9');
    // A bucket whose Net excludes the unvalued rows is exactly as proven as the rows it kept, so the weakest tier present no longer speaks for it.
    expect(b?.feeBasis).toBe('exact');
    // Widened for this one read only: the field is what the fix adds, and asserting it through a whole-bucket `any` would erase the compile error that says so.
    expect((b as unknown as { netTradeCount?: number } | undefined)?.netTradeCount).toBe(1);
    // The Recorded leg still spans the bucket: excluding the unvalued row from Net must not drop it from the archive.
    expect(b?.tradeCount).toBe(2);
    expect(b?.profitSum).toBe('15');
  });
});

describe('ProfileArchiveListResponse', () => {
  /** The minimum a producer must send. The optional-with-default fields are omitted so each assertion below decides what their absence means. */
  const minimal = {
    items: [],
    nextCursor: null,
    from: '2026-05-01T00:00:00.000Z',
    to: '2026-06-01T00:00:00.000Z',
  };

  it('leaves recoverableSymbols undefined when the producer omitted it', () => {
    // `[]` and "absent" are different facts and the recovery UX acts on both: an empty list is the archive telling the operator every coin is accounted for, and it is what stops a running recover-all and reports "Recovery finished.". A default that manufactures `[]` out of silence lets a response that never computed the set close out a recovery that has not happened. Absent must stay absent so the consumer can tell them apart.
    const parsed = ProfileArchiveListResponse.parse(minimal);
    expect(parsed.recoverableSymbols).toBeUndefined();
  });

  it('still carries an explicitly empty recoverableSymbols through as empty', () => {
    // The other half of the same distinction: a producer that DID compute the set and found nothing must not be flattened into "absent" either, or the fix would trade one ambiguity for its mirror image.
    const parsed = ProfileArchiveListResponse.parse({ ...minimal, recoverableSymbols: [] });
    expect(parsed.recoverableSymbols).toEqual([]);
  });
});

describe('TradeArchiveResponse', () => {
  it('declares no profitPercent, so no consumer can render a percentage on the wrong basis', () => {
    // A percentage is a view of a basis choice, not data. While the server sent one it was gross by construction, and every consumer that forgot to re-derive it under the Net/Gross toggle put a net amount beside a gross percent. Deleting the field makes that class of mistake unrepresentable rather than merely fixed at today's call sites, and a runtime shape assertion is the evidence for that: a type-only claim would not be checked in the test files or the untyped fixtures that feed this response.
    expect(Object.keys(TradeArchiveResponse.shape)).not.toContain('profitPercent');
    // The fields the percentage is derived FROM must still be there, or the assertion above would also pass on an empty schema.
    expect(Object.keys(TradeArchiveResponse.shape)).toEqual(
      expect.arrayContaining(['profit', 'netProfit', 'totalBuyQuote', 'missingCostBasis']),
    );
  });

  it('defaults a legacy payload to incomplete instead of promoting its numeric zero', () => {
    const parsed = TradeArchiveResponse.parse({
      id: '11111111-1111-4111-8111-111111111111',
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      totalBuyQuote: '100',
      totalSellQuote: '101',
      breakdown: {},
      fees: { BTC: '0.001' },
      feesQuote: '0',
      netProfit: '1',
      profit: '1',
      archivedAt: '2026-08-25T00:00:00.000Z',
    });
    expect(parsed.feeBasis).toBe('unknown');
    expect(parsed.feesQuote).toBe('0');
  });
});

describe('weakestFeeBasis', () => {
  // Direction is the whole content of this function, and it is invisible on a fixture whose tiers all agree: rank-max and rank-min return the same answer there. Every unordered pair is asserted in both argument orders so a fold that happens to read its arguments the other way round is not accidentally excused.
  it.each([
    ['exact', 'estimated', 'estimated'],
    ['exact', 'unknown', 'unknown'],
    ['estimated', 'unknown', 'unknown'],
  ])('folds %s with %s to %s, in either order', (a, b, weakest) => {
    expect(weakestFeeBasis(a, b)).toBe(weakest);
    expect(weakestFeeBasis(b, a)).toBe(weakest);
  });

  it('canonicalises a tier this build does not recognise instead of passing it through', () => {
    // Returning the input verbatim is the fail-open direction: consumers gate by equality against the three known spellings, so an unrecognised string satisfies neither the withholding branch nor the estimated marker and renders as fully proven. It has to come back as the tier its rank names.
    expect(weakestFeeBasis('partial', 'exact')).toBe('unknown');
    expect(weakestFeeBasis('exact', 'partial')).toBe('unknown');
    expect(weakestFeeBasis('partial', 'bogus')).toBe('unknown');
  });

  it('leaves a pair that already agrees alone', () => {
    expect(weakestFeeBasis('exact', 'exact')).toBe('exact');
    expect(weakestFeeBasis('estimated', 'estimated')).toBe('estimated');
    expect(weakestFeeBasis('unknown', 'unknown')).toBe('unknown');
  });
});

describe('rollup fee-basis fold', () => {
  /** A rollup row at one tier. Built inline rather than through `item`, so the tier is the only thing these cases vary. */
  const tiered = (feeBasis: string, profit = '1'): ArchiveRollupItem =>
    ({
      quoteAsset: 'USDT',
      source: 'auto',
      profit,
      feeBasis,
      orders: [{ side: 'SELL', intent: 'grid-sell' }],
    }) as ArchiveRollupItem;

  it('reports the WEAKEST tier among the rows the Net figure actually covers', () => {
    // A bucket is only as trustworthy as the worst row its Net figure sums: one estimated cycle makes the bucket's profit factor an estimate, whatever the other rows proved. An unvalued row is not in that sum at all, so it no longer drags the tier down with it; that it was left out is reported by the covered count instead.
    expect(rollupByExitIntent([tiered('exact'), tiered('estimated')])[0]?.feeBasis).toBe(
      'estimated',
    );
    expect(rollupByExitIntent([tiered('estimated'), tiered('unknown')])[0]?.feeBasis).toBe(
      'estimated',
    );
    expect(rollupByExitIntent([tiered('exact'), tiered('unknown')])[0]?.feeBasis).toBe('exact');
  });

  it('reports unknown for a bucket whose every row is unvalued, never the exact seed', () => {
    // The seed is the strongest tier and only valued rows weaken it, so a bucket that valued nothing would otherwise certify a Net of zero it never summed. Reported through the count, not the amount: a real bucket can sum to zero.
    const b = rollupByExitIntent([tiered('unknown'), tiered('unknown')])[0];
    expect(b?.feeBasis).toBe('unknown');
    expect(b?.netTradeCount).toBe(0);
    // The Recorded leg still spans both rows, which is what stops the exclusion reading as a deletion.
    expect(b?.tradeCount).toBe(2);
  });

  it('reports exact for a bucket whose rows are all exact', () => {
    // The accumulate identity. Seeded at anything weaker, a bucket of fully-proven rows reports itself as an estimate and every statistic derived from it gets marked for a doubt that does not exist. The mixed-tier case above passes under that mutation, which is why both are here.
    expect(rollupByExitIntent([tiered('exact'), tiered('exact')])[0]?.feeBasis).toBe('exact');
    expect(rollupBySource([tiered('exact'), tiered('exact')])[0]?.feeBasis).toBe('exact');
  });

  it('reports exact for an empty rollup summary', () => {
    // Nothing to distrust. This is the arm that preserves today's `coalesce(..., true)` reading, and it is where a rank-minimum over an empty set silently flips the meaning. It is also the one path that must NOT read as "nothing could be valued": no bucket is built at all, so the empty summary is returned whole rather than projected through the zero-valued-rows branch, which reports `unknown` for the opposite situation.
    expect(summarizeClosedTrades([]).feeBasis).toBe('exact');
    expect(summarizeClosedTrades([]).netTradeCount).toBe(0);
  });
});

describe('TradeArchiveResponse fee basis', () => {
  it("defaults an omitted tier to 'unknown', never to exact", () => {
    // A producer that does not send the field has told us nothing about its fee evidence. Defaulting to `exact` would promote every legacy payload to a certified Net P/L on no evidence at all — the same direction the retired completeness boolean's `false` was chosen for.
    const parsed = TradeArchiveResponse.parse({
      id: '11111111-1111-4111-8111-111111111111',
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      totalBuyQuote: '100',
      totalSellQuote: '101',
      breakdown: {},
      fees: { BTC: '0.001' },
      feesQuote: '0',
      netProfit: '1',
      profit: '1',
      archivedAt: '2026-08-25T00:00:00.000Z',
    });
    expect(parsed.feeBasis).toBe('unknown');
  });

  it('carries an explicitly sent tier through unchanged', () => {
    const parsed = TradeArchiveResponse.parse({
      id: '11111111-1111-4111-8111-111111111111',
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      totalBuyQuote: '100',
      totalSellQuote: '101',
      breakdown: {},
      fees: { USDT: '0.5' },
      feesQuote: '0.5',
      netProfit: '0.5',
      profit: '1',
      feeBasis: 'estimated',
      archivedAt: '2026-08-25T00:00:00.000Z',
    });
    expect(parsed.feeBasis).toBe('estimated');
  });
});

describe('coerceArchivedOrderDetails', () => {
  it('projects a stored order to the wire shape and leaves the raw payload behind', () => {
    const [order] = coerceArchivedOrderDetails([
      {
        orderId: 'o-1',
        binanceOrderId: '77',
        clientOrderId: 'c-1',
        intent: 'grid-sell',
        side: 'SELL',
        status: 'FILLED',
        executedQty: '1',
        cummulativeQuoteQty: '105',
        closedAt: '2026-05-10T00:00:00.000Z',
        meta: { gridTradeIndex: 2 },
        raw: { fills: [{ price: '105' }] },
      },
    ]);
    expect(order).toEqual({
      orderId: 'o-1',
      binanceOrderId: '77',
      clientOrderId: 'c-1',
      intent: 'grid-sell',
      side: 'SELL',
      status: 'FILLED',
      executedQty: '1',
      cummulativeQuoteQty: '105',
      closedAt: '2026-05-10T00:00:00.000Z',
    });
  });

  it('drops an element that carries no order id, and nulls a quantity that is not a decimal', () => {
    // The column is jsonb written by two producers across the archive's history, so an element this shape cannot describe is real. A fill the sheet cannot state is better absent than shown with blank facts that read as proven zeros.
    const orders = coerceArchivedOrderDetails([
      null,
      'not an object',
      { side: 'BUY' },
      { orderId: 'o-2', executedQty: 'n/a', cummulativeQuoteQty: '1e2', side: 'sideways' },
    ]);
    expect(orders).toHaveLength(1);
    expect(orders[0]?.orderId).toBe('o-2');
    expect(orders[0]?.executedQty).toBeNull();
    // A decimal in exponent form is still a decimal; it is normalised, not refused.
    expect(orders[0]?.cummulativeQuoteQty).toBe('100');
    // Neither BUY nor SELL: null rather than a fabricated side.
    expect(orders[0]?.side).toBeNull();
    expect(orders[0]?.status).toBe('UNKNOWN');
  });

  it('answers an empty list for a column that holds no array at all', () => {
    expect(coerceArchivedOrderDetails(null)).toEqual([]);
    expect(coerceArchivedOrderDetails({ orders: [] })).toEqual([]);
  });
});
