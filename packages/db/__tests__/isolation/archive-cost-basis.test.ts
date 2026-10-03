import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accountRepo,
  profileRepo,
  type AccountRepo,
  type ProfileRepo,
} from '../../src/repo/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * Cost-basis accounting for `summarizeArchiveSince`. The aggregator sums each
 * SELL fill's `realized_pnl` / `cost_basis_quote` columns instead of
 * differencing BUY/SELL cashflow over a time window. These tests pin the
 * properties that kill the phantom-profit class: an adopted SELL (large
 * proceeds, no matching BUY row) books only its stamped realised P/L, and a
 * SELL with NULL cost basis under-counts rather than fabricating a gain.
 *
 * Skipped when `DATABASE_TEST_URL` is unset so `bun run test` works without PG.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

let nextOrderId = 9_000_000;
const filledOrder = (o: {
  symbol: string;
  side: 'BUY' | 'SELL';
  intent: string;
  proceeds: string; // cummulativeQuoteQty
  closedAt: Date;
  realizedPnl?: string;
  costBasisQuote?: string;
}) => ({
  symbol: o.symbol,
  side: o.side,
  intent: o.intent,
  binanceOrderId: BigInt(nextOrderId++),
  clientOrderId: `cb-${nextOrderId}`,
  status: 'FILLED' as const,
  raw: { cummulativeQuoteQty: o.proceeds, status: 'FILLED' },
  closedAt: o.closedAt,
  ...(o.realizedPnl !== undefined ? { realizedPnl: o.realizedPnl } : {}),
  ...(o.costBasisQuote !== undefined ? { costBasisQuote: o.costBasisQuote } : {}),
});

const UNTIL = new Date('2026-07-01T00:00:00Z');

describeIfDb('summarizeArchiveSince — cost-basis accounting', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;
  // Stamping realised P/L keys on the Binance order id, which is account-unique.
  let aa: AccountRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    aa = await accountRepo(fx.db, fx.alice.userId, fx.alice.accountId);
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('sums realised P/L from the SELL columns, not buy/sell cashflow', async () => {
    // Bought 172 @ 0.0885 (cost 15.222), protective-stopped 172 for 14.5168.
    await ap.orders.insert(
      filledOrder({
        symbol: 'AAAUSDT',
        side: 'BUY',
        intent: 'grid-buy',
        proceeds: '15.136',
        closedAt: new Date('2026-06-14T14:14:00Z'),
      }),
    );
    await ap.orders.insert(
      filledOrder({
        symbol: 'AAAUSDT',
        side: 'SELL',
        intent: 'protective-stop',
        proceeds: '14.5168',
        closedAt: new Date('2026-06-14T14:40:00Z'),
        realizedPnl: '-0.7052',
        costBasisQuote: '15.2220',
      }),
    );

    const s = await ap.tradeArchive.summarizeArchiveSince('AAAUSDT', null, UNTIL);
    if (s === null) throw new Error('expected a summary');
    expect(Number(s.profit)).toBeCloseTo(-0.7052, 4);
    expect(Number(s.totalBuyQuote)).toBeCloseTo(15.222, 3);
    // total_sell = cost basis + profit (matched proceeds), invariant holds.
    expect(Number(s.totalSellQuote)).toBeCloseTo(14.5168, 3);
    expect(s.missingCostBasis).toBe(0);
  });

  it('an adopted SELL with large proceeds and no BUY row CANNOT inflate profit', async () => {
    // The exact phantom: sold 334.6 adopted XPL for 29.01 proceeds, no matching
    // BUY row in the orders table. The stamped realised P/L is a small loss, so
    // the archive must book ~−0.8, never the proceeds-minus-zero +29 it used to.
    await ap.orders.insert(
      filledOrder({
        symbol: 'BBBUSDT',
        side: 'SELL',
        intent: 'protective-stop',
        proceeds: '29.00982',
        closedAt: new Date('2026-06-14T13:31:00Z'),
        realizedPnl: '-0.8',
        costBasisQuote: '29.81',
      }),
    );

    const s = await ap.tradeArchive.summarizeArchiveSince('BBBUSDT', null, UNTIL);
    if (s === null) throw new Error('expected a summary');
    expect(Number(s.profit)).toBeCloseTo(-0.8, 6);
    // NOT the fabricated +29 (proceeds with zero cost).
    expect(Number(s.profit)).toBeLessThan(0);
    expect(Number(s.totalBuyQuote)).toBeCloseTo(29.81, 2);
    expect(s.missingCostBasis).toBe(0);
  });

  it('a SELL with NULL cost basis under-counts (zero contribution), never fabricates', async () => {
    // An un-costed adopted sale: realised P/L unknown. It must contribute
    // nothing to profit and be flagged, not booked as proceeds-minus-zero.
    await ap.orders.insert(
      filledOrder({
        symbol: 'CCCUSDT',
        side: 'SELL',
        intent: 'protective-stop',
        proceeds: '50',
        closedAt: new Date('2026-06-14T10:00:00Z'),
        // realizedPnl / costBasisQuote omitted → NULL columns.
      }),
    );

    const s = await ap.tradeArchive.summarizeArchiveSince('CCCUSDT', null, UNTIL);
    if (s === null) throw new Error('expected a summary');
    expect(Number(s.profit)).toBe(0);
    expect(Number(s.totalBuyQuote)).toBe(0);
    expect(s.missingCostBasis).toBe(1);
    expect(s).not.toHaveProperty('profitPercent');

    // The under-count must SURVIVE onto the archive row. `profit = 0` from an
    // un-costed SELL is indistinguishable from a genuine break-even once
    // written, so the count is what lets the API and UI say "unavailable"
    // instead of rendering a number nobody measured as `+0.00`.
    const row = await ap.tradeArchive.insert({
      symbol: 'CCCUSDT',
      baseAsset: 'CCC',
      quoteAsset: 'USDT',
      totalBuyQuote: s.totalBuyQuote,
      totalSellQuote: s.totalSellQuote,
      breakdown: s.breakdown,
      profit: s.profit,
      missingCostBasis: s.missingCostBasis,
      archivedAt: new Date('2026-06-14T10:05:00Z'),
      cycleEnd: new Date('2026-06-14T10:00:00Z'),
    });
    expect(row?.missingCostBasis).toBe(1);
  });

  it('a fully-costed archive row records zero missing cost bases (the column default is not a guess)', async () => {
    const row = await ap.tradeArchive.insert({
      symbol: 'EEEUSDT',
      baseAsset: 'EEE',
      quoteAsset: 'USDT',
      totalBuyQuote: '100',
      totalSellQuote: '110',
      profit: '10',
      archivedAt: new Date('2026-06-15T10:00:00Z'),
      cycleEnd: new Date('2026-06-15T10:00:00Z'),
    });
    expect(row?.missingCostBasis).toBe(0);
  });

  it("listClosedSince with a null ceiling returns a fill the caller's clock would have excluded", async () => {
    // `closed_at` is stamped from the exchange's `transactTime`, so a ceiling read off the archiving process's clock sits in a different clock from the column it filters. The row it strands is the newest fill in the cycle, which for a closing SELL carries all of the realised P/L. A null ceiling is how the handler learns the window's upper edge from the data instead, so this pins that the nullable branch really drops the predicate rather than defaulting it.
    const ahead = new Date('2026-06-20T10:00:00.058Z');
    const behind = new Date('2026-06-20T10:00:00.000Z');
    await ap.orders.insert(
      filledOrder({
        symbol: 'FFFUSDT',
        side: 'SELL',
        intent: 'grid-sell',
        proceeds: '110',
        closedAt: ahead,
        realizedPnl: '10',
        costBasisQuote: '100',
      }),
    );

    const unbounded = await ap.tradeArchive.listClosedSince('FFFUSDT', null, null);
    expect(unbounded.map((r) => r.closedAt?.getTime())).toEqual([ahead.getTime()]);

    // The same read under a ceiling 58ms short of the fill: the defect, reproduced at the SQL layer.
    const bounded = await ap.tradeArchive.listClosedSince('FFFUSDT', null, behind);
    expect(bounded).toEqual([]);
  });

  it('stampRealizedPnl costs an ALREADY-FILLED SELL row (the MARKET path) and is write-once', async () => {
    // A MARKET sell is inserted already-FILLED by place-order, so markFilled's
    // status flip never matches it. stampRealizedPnl must still stamp it.
    const inserted = await ap.orders.insert(
      filledOrder({
        symbol: 'DDDUSDT',
        side: 'SELL',
        intent: 'grid-sell',
        proceeds: '130',
        closedAt: new Date('2026-06-14T12:00:00Z'),
        // realized columns omitted → NULL, exactly like a fresh MARKET-fill row.
      }),
    );
    const bId = inserted.binanceOrderId;

    // Before stamping the aggregator under-counts (the Finding-1 regression).
    const before = await ap.tradeArchive.summarizeArchiveSince('DDDUSDT', null, UNTIL);
    if (before === null) throw new Error('expected a summary');
    expect(before.missingCostBasis).toBe(1);

    const n = await aa.orders.stampRealizedPnl(bId, { realizedPnl: '10', costBasisQuote: '120' });
    expect(n).toBe(1);

    const after = await ap.tradeArchive.summarizeArchiveSince('DDDUSDT', null, UNTIL);
    if (after === null) throw new Error('expected a summary');
    expect(Number(after.profit)).toBeCloseTo(10, 6);
    expect(Number(after.totalBuyQuote)).toBeCloseTo(120, 6);
    expect(after.missingCostBasis).toBe(0);

    // Write-once: a replay/double-delivery must NOT overwrite the value.
    const n2 = await aa.orders.stampRealizedPnl(bId, { realizedPnl: '999', costBasisQuote: '1' });
    expect(n2).toBe(0);
    const final = await ap.tradeArchive.summarizeArchiveSince('DDDUSDT', null, UNTIL);
    if (final === null) throw new Error('expected a summary');
    expect(Number(final.profit)).toBeCloseTo(10, 6);
  });
});

/**
 * The watermark `latestArchivedAt` hands the next archive. `archived_at` is the writer's wall clock at INSERT, stamped after the window was read, summed and priced against Binance; `cycle_end` is the newest `closed_at` in that window, in the exchange's clock. Reading the cutoff off the write time leaves the seconds in between bounded by neither archive, and a fill closing there is dropped with no `missingCostBasis` marker, because that marker only counts uncosted SELLs INSIDE a window.
 */
describeIfDb('latestArchivedAt — the next archive starts at the last cycle end', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;

  const archiveRow = (o: { symbol: string; archivedAt: Date; cycleEnd: Date | null }) => ({
    symbol: o.symbol,
    baseAsset: o.symbol.replace('USDT', ''),
    quoteAsset: 'USDT',
    totalBuyQuote: '100',
    totalSellQuote: '110',
    profit: '10',
    archivedAt: o.archivedAt,
    cycleEnd: o.cycleEnd,
  });

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('does not strand a fill that closes between the archived window and its write', async () => {
    const cycleEnd = new Date('2026-06-20T10:00:00.000Z');
    // Nine seconds of aggregating the totals and paging `myTrades` for commissions.
    const writtenAt = new Date('2026-06-20T10:00:09.000Z');
    // Four seconds in: above the archived window's ceiling, below its write time.
    const straddler = new Date('2026-06-20T10:00:04.000Z');

    await ap.tradeArchive.insert(
      archiveRow({ symbol: 'EEEUSDT', archivedAt: writtenAt, cycleEnd }),
    );
    await ap.orders.insert(
      filledOrder({
        symbol: 'EEEUSDT',
        side: 'SELL',
        intent: 'grid-sell',
        proceeds: '55',
        closedAt: straddler,
        realizedPnl: '5',
        costBasisQuote: '50',
      }),
    );

    // Asserted through the two reads the handler feeds this cutoff to, before the cutoff itself, so the failure names the harm: the straddling fill has to land in the NEXT archive carrying its realised P/L, not vanish between two windows.
    const since = await ap.tradeArchive.latestArchivedAt('EEEUSDT');
    const rows = await ap.tradeArchive.listClosedSince('EEEUSDT', since, null);
    expect(rows.map((r) => r.closedAt?.getTime())).toEqual([straddler.getTime()]);
    const summary = await ap.tradeArchive.summarizeArchiveSince('EEEUSDT', since, straddler);
    if (summary === null) throw new Error('expected a summary');
    expect(Number(summary.profit)).toBeCloseTo(5, 6);
    expect(since).toEqual(cycleEnd);
  });

  it('falls back to archived_at on a row written before cycle_end existed', async () => {
    const writtenAt = new Date('2026-06-21T08:00:00.000Z');
    await ap.tradeArchive.insert(
      archiveRow({ symbol: 'GGGUSDT', archivedAt: writtenAt, cycleEnd: null }),
    );
    // Nothing better is recorded on a legacy row, and falling back to all-time instead would re-archive its cycle.
    expect(await ap.tradeArchive.latestArchivedAt('GGGUSDT')).toEqual(writtenAt);
  });

  it('ignores a backfill written today for a cycle that closed long ago', async () => {
    const oldCycle = new Date('2026-01-05T00:00:00.000Z');
    const recentCycle = new Date('2026-06-22T09:00:00.000Z');
    await ap.tradeArchive.insert(
      archiveRow({
        symbol: 'HHHUSDT',
        archivedAt: new Date('2026-06-22T09:00:05.000Z'),
        cycleEnd: recentCycle,
      }),
    );
    // Reconstructed from `myTrades` after the fact, so its write time is the newer of the two while the cycle it describes is the older.
    await ap.tradeArchive.insert(
      archiveRow({
        symbol: 'HHHUSDT',
        archivedAt: new Date('2026-06-22T11:00:00.000Z'),
        cycleEnd: oldCycle,
      }),
    );
    // Electing the backfill would rewind the cutoff five months and re-archive every cycle since.
    expect(await ap.tradeArchive.latestArchivedAt('HHHUSDT')).toEqual(recentCycle);
  });
});
