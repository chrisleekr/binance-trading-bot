import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import { accounts } from '../../src/schema/accounts.js';
import { appliedFills } from '../../src/schema/applied-fills.js';
import { backfillAttempts } from '../../src/schema/backfill-attempts.js';
import { profiles } from '../../src/schema/profiles.js';
import { tradeArchive } from '../../src/schema/trade-archive.js';
import { users } from '../../src/schema/users.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * Account-scoped happy-path matrix for `packages/db/src/repo/trade-archive.ts`.
 * Every exported fn takes a `ProfileScope`, so a wrong-owner call cannot be
 * expressed — ownership is proven once by `scopeProfile`. Cross-account
 * rejection lives in `cross-account.test.ts`.
 *
 * Skipped when `DATABASE_TEST_URL` is not set so `bun run test` works on
 * workstations without a Postgres available.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

// Reusable seed payload — required numeric columns carry plausible decimal-
// strings end-to-end per the money-math invariant in CLAUDE.md.
const seedTrade = (tag: string) => ({
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  totalBuyQuote: '60000',
  totalSellQuote: '62000',
  breakdown: { 'grid-buy:BUY': '60000', 'grid-sell:SELL': '62000' },
  profit: '2000',
  profitPercent: '3.3333333333',
  orders: [
    { tag, side: 'BUY' as const },
    { tag, side: 'SELL' as const },
  ],
  archivedAt: new Date('2026-05-11T00:00:00Z'),
});

describeIfDb('trade-archive account-scoped reads and writes', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;

  /**
   * Age a symbol's fills past the settling grace. `listRecoverableSymbols`
   * ignores a SELL until it has settled, so the forward archive gets first
   * claim on a cycle it is still writing; a fill just recorded by `tryRecord`
   * is therefore not yet actionable.
   */
  const settleFills = async (
    profileId: IsolationFixture['alice']['profileId'],
    symbol: string,
    orderIds?: readonly number[],
  ): Promise<void> => {
    const conditions = [eq(appliedFills.profileId, profileId), eq(appliedFills.symbol, symbol)];
    if (orderIds) conditions.push(inArray(appliedFills.orderId, [...orderIds]));
    await fx.db
      .update(appliedFills)
      .set({ appliedAt: new Date(Date.now() - 3_600_000) })
      .where(and(...conditions));
  };

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    // Seed one archived trade.
    await ap.tradeArchive.insert(seedTrade('alice-trade'));
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('listForSymbol returns the correct account rows on the happy path', async () => {
    const rows = await ap.tradeArchive.listForSymbol('BTCUSDT', 10);
    expect(rows.map((r) => r.profileId)).toEqual([fx.alice.profileId]);
    expect((rows[0]?.orders as { tag?: string }[] | undefined)?.[0]?.tag).toBe('alice-trade');
  });

  it('listForProfile returns only the owner-scoped rows on the happy path', async () => {
    const rows = await ap.tradeArchive.listForProfile(10);
    expect(rows.map((r) => r.profileId)).toEqual([fx.alice.profileId]);
  });

  it('listWithUnvaluedFees finds zero-fee rows; updateFees backfills and drops them', async () => {
    const inserted = await ap.tradeArchive.insert({
      ...seedTrade('alice-reconcile'),
      orders: [{ binanceOrderId: '12345', side: 'BUY' as const }],
    });
    const before = await ap.tradeArchive.listWithUnvaluedFees(100);
    const target = before.find((r) => r.id === inserted.id);
    expect(target).toBeDefined();
    expect((target?.orders as { binanceOrderId?: string }[])[0]?.binanceOrderId).toBe('12345');

    expect(await ap.tradeArchive.updateFees(inserted.id, { USDT: '1.5' }, '1.5')).toBe(true);
    const after = await ap.tradeArchive.listWithUnvaluedFees(100);
    expect(after.map((r) => r.id)).not.toContain(inserted.id);
  });

  it('listForProfilePaginated honours the cursor + DESC ordering on the happy path', async () => {
    // The suite shares one fixture DB with no per-test cleanup, so this test
    // must own the rows it walks rather than assume the global second-newest
    // row. It seeds two rows with distinct timestamps that are the newest in
    // the fixture at this point: distinct stamps avoid the id-tiebreak between
    // same-archivedAt rows other tests leave behind, keeping the walk stable.
    const tagOf = (r: { orders: unknown } | undefined) =>
      (r?.orders as { tag?: string }[] | undefined)?.[0]?.tag;
    await ap.tradeArchive.insert({
      ...seedTrade('alice-page-older'),
      archivedAt: new Date('2026-05-11T01:00:00Z'),
    });
    await ap.tradeArchive.insert({
      ...seedTrade('alice-page-newer'),
      archivedAt: new Date('2026-05-11T01:01:00Z'),
    });

    const page1 = await ap.tradeArchive.listForProfilePaginated(1, null, null);
    expect(page1).toHaveLength(1);
    expect(tagOf(page1[0])).toBe('alice-page-newer');

    // Walk the cursor: page 2 must surface the next-older row, never re-emit
    // page 1's row.
    const first = page1[0];
    if (!first) throw new Error('page1 should have one row');
    const page2 = await ap.tradeArchive.listForProfilePaginated(1, null, {
      archivedAt: first.archivedAt,
      id: first.id,
    });
    expect(page2).toHaveLength(1);
    expect(page2[0]?.id).not.toBe(first.id);
    expect(tagOf(page2[0])).toBe('alice-page-older');
  });

  it('sumProfitInRange returns only the owner-scoped totals on the happy path', async () => {
    // Self-contained — seed an extra row inside this test so the totals
    // assertion does not depend on whichever other tests in the suite
    // happened to insert rows already. Keeps the suite order-independent.
    await ap.tradeArchive.insert({
      ...seedTrade('alice-sum-extra'),
      archivedAt: new Date('2026-05-11T00:02:00Z'),
    });
    const aliceTotals = await ap.tradeArchive.sumProfitInRange(
      new Date('2026-01-01T00:00:00Z'),
      new Date('2027-01-01T00:00:00Z'),
    );
    // At least the two rows this test can guarantee (beforeAll seed +
    // the extra above) must show up — other tests in the suite may have
    // added more, but the sum must never go below this floor.
    expect(aliceTotals.tradeCount).toBeGreaterThanOrEqual(2);
    // Each seeded row contributes profit=2000; the total must scale
    // linearly with the trade count.
    const profitPerRow = 2000;
    expect(Number(aliceTotals.totalProfit)).toBe(aliceTotals.tradeCount * profitPerRow);
  });

  it('insert lands the trade on the owner archive, defaulting source to manual', async () => {
    await ap.tradeArchive.insert(seedTrade('alice-insert'));
    const rows = await ap.tradeArchive.listForProfile(100);
    const inserted = rows.find((r) => (r.orders as { tag?: string }[])[0]?.tag === 'alice-insert');
    expect(inserted?.profileId).toBe(fx.alice.profileId);
    // The seed omits `source`, so the column default applies — every archive is
    // `manual` until discovery stamps `auto` (Slice 3).
    expect(inserted?.source).toBe('manual');
  });

  it('listForProfileInRange projects source alongside quoteAsset/profit/orders for the rollups', async () => {
    // The by-source rollup groups on `source`, so the period reader must carry
    // it. Seed one auto + one manual row with unique tags and assert each comes
    // back with the correct source.
    await ap.tradeArchive.insert({
      ...seedTrade('alice-range-auto'),
      source: 'auto',
      archivedAt: new Date('2026-05-11T00:04:00Z'),
    });
    await ap.tradeArchive.insert({
      ...seedTrade('alice-range-manual'),
      source: 'manual',
      archivedAt: new Date('2026-05-11T00:05:00Z'),
    });

    const rows = await ap.tradeArchive.listForProfileInRange(new Date('2026-01-01T00:00:00Z'));
    const tagOf = (r: { orders: unknown }) => (r.orders as { tag?: string }[])[0]?.tag;
    const auto = rows.find((r) => tagOf(r) === 'alice-range-auto');
    const manual = rows.find((r) => tagOf(r) === 'alice-range-manual');
    expect(auto?.source).toBe('auto');
    expect(manual?.source).toBe('manual');
    // The projection carries the other rollup inputs. `profit` is a numeric
    // column, so the driver returns it full-scale ('2000.000…'); compare by
    // value, matching the sibling sumProfitInRange test.
    expect(auto?.quoteAsset).toBe('USDT');
    expect(Number(auto?.profit)).toBe(2000);
  });

  it('sumProfitInRangeBySource groups per source with win/loss split and gross magnitudes', async () => {
    // A far-future window unique to this test so the totals never overlap the
    // 2026-2027 rows the sibling sum tests seed — the suite stays order-independent.
    const from = new Date('2028-08-01T00:00:00Z');
    const to = new Date('2028-08-02T00:00:00Z');
    const at = (m: number) => new Date(`2028-08-01T00:0${m}:00Z`);
    // auto: two winners + one loser.
    await ap.tradeArchive.insert({
      ...seedTrade('bs-auto-w1'),
      source: 'auto',
      profit: '2000',
      archivedAt: at(0),
    });
    await ap.tradeArchive.insert({
      ...seedTrade('bs-auto-w2'),
      source: 'auto',
      profit: '1000',
      archivedAt: at(1),
    });
    await ap.tradeArchive.insert({
      ...seedTrade('bs-auto-l1'),
      source: 'auto',
      profit: '-500',
      archivedAt: at(2),
    });
    // manual: one breakeven — counts toward tradeCount only, never win/loss/gross.
    await ap.tradeArchive.insert({
      ...seedTrade('bs-manual-be'),
      source: 'manual',
      profit: '0',
      archivedAt: at(3),
    });

    const rows = await ap.tradeArchive.sumProfitInRangeBySource(from, to);
    // Only this test seeds the window, so exactly the two sources appear,
    // ordered deterministically (auto < manual).
    expect(rows.map((r) => r.source)).toEqual(['auto', 'manual']);

    const auto = rows.find((r) => r.source === 'auto');
    expect(auto).toMatchObject({ tradeCount: 3, wins: 2, losses: 1 });
    expect(Number(auto?.totalProfit)).toBe(2500);
    expect(Number(auto?.grossProfit)).toBe(3000);
    expect(Number(auto?.grossLoss)).toBe(500);
    // Percent is profit over summed buy-quote cost basis: 2500 / (3 × 60000) × 100.
    expect(Number(auto?.totalProfitPercent)).toBeCloseTo((2500 / 180000) * 100, 5);

    const manual = rows.find((r) => r.source === 'manual');
    expect(manual).toMatchObject({ tradeCount: 1, wins: 0, losses: 0 });
    expect(Number(manual?.totalProfit)).toBe(0);
    expect(Number(manual?.grossProfit)).toBe(0);
    expect(Number(manual?.grossLoss)).toBe(0);
  });

  it('fees jsonb round-trips on insert + read; defaults to {} when omitted', async () => {
    await ap.tradeArchive.insert({
      ...seedTrade('alice-fees'),
      fees: { BNB: '0.0025', USDT: '0.11' },
      archivedAt: new Date('2026-05-11T00:03:00Z'),
    });
    const rows = await ap.tradeArchive.listForProfile(200);
    const withFees = rows.find((r) => (r.orders as { tag?: string }[])[0]?.tag === 'alice-fees');
    expect(withFees?.fees).toEqual({ BNB: '0.0025', USDT: '0.11' });

    // The beforeAll seed omits `fees`, so the column default applies.
    const seeded = rows.find((r) => (r.orders as { tag?: string }[])[0]?.tag === 'alice-trade');
    expect(seeded?.fees).toEqual({});
  });

  it('listRecoverableSymbols returns un-attempted missing coins, sorted and scoped', async () => {
    const bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);

    // `it` blocks share the seeded DB (no per-test cleanup), so assert by
    // containment + ordering rather than exact arrays. Each recoverable coin
    // needs a CLOSED cycle — a BUY and a SELL. A BUY-only symbol is an open
    // position, covered separately below.
    await ap.appliedFills.tryRecord({ symbol: 'AAVEUSDT', orderId: 11, tradeId: 11, side: 'BUY' });
    await ap.appliedFills.tryRecord({ symbol: 'AAVEUSDT', orderId: 15, tradeId: 15, side: 'SELL' });
    await ap.appliedFills.tryRecord({ symbol: 'ETHUSDT', orderId: 14, tradeId: 14, side: 'BUY' });
    await ap.appliedFills.tryRecord({ symbol: 'ETHUSDT', orderId: 16, tradeId: 16, side: 'SELL' });
    // BTCUSDT has both fills and an archive row (beforeAll seed) — excluded.
    // The fills are back-dated behind that row's `archived_at`: the predicate is
    // cycle-relative, so "already archived" only holds while no fill landed
    // after the last archived cycle (the newer-cycle case is asserted below).
    await ap.appliedFills.tryRecord({ symbol: 'BTCUSDT', orderId: 12, tradeId: 12, side: 'BUY' });
    await ap.appliedFills.tryRecord({ symbol: 'BTCUSDT', orderId: 17, tradeId: 17, side: 'SELL' });
    await fx.db
      .update(appliedFills)
      .set({ appliedAt: new Date('2026-05-01T00:00:00Z') })
      .where(
        and(
          eq(appliedFills.profileId, fx.alice.profileId),
          eq(appliedFills.symbol, 'BTCUSDT'),
          inArray(appliedFills.orderId, [12, 17]),
        ),
      );
    await bp.appliedFills.tryRecord({ symbol: 'DOGEUSDT', orderId: 13, tradeId: 13, side: 'BUY' });
    await bp.appliedFills.tryRecord({ symbol: 'DOGEUSDT', orderId: 18, tradeId: 18, side: 'SELL' });
    await settleFills(fx.alice.profileId, 'AAVEUSDT');
    await settleFills(fx.alice.profileId, 'ETHUSDT');
    await settleFills(fx.bob.profileId, 'DOGEUSDT');

    const alice = await ap.tradeArchive.listRecoverableSymbols();
    expect(alice).toContain('AAVEUSDT'); // fills, no archive, not attempted
    expect(alice).toContain('ETHUSDT');
    expect(alice).not.toContain('BTCUSDT'); // has an archive row (beforeAll seed)
    expect(alice).not.toContain('DOGEUSDT'); // Bob's, cross-profile
    expect(alice).toEqual([...alice].sort()); // ascending

    const bob = await bp.tradeArchive.listRecoverableSymbols();
    expect(bob).toContain('DOGEUSDT');
    expect(bob).not.toContain('AAVEUSDT'); // Alice's, cross-profile
  });

  it('recordBackfillAttempt moves a coin from recoverable to unreconstructable, scoped', async () => {
    const bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);

    await ap.appliedFills.tryRecord({ symbol: 'PEPEUSDT', orderId: 21, tradeId: 21, side: 'BUY' });
    await ap.appliedFills.tryRecord({ symbol: 'PEPEUSDT', orderId: 23, tradeId: 23, side: 'SELL' });
    await bp.appliedFills.tryRecord({ symbol: 'SHIBUSDT', orderId: 22, tradeId: 22, side: 'BUY' });
    await settleFills(fx.alice.profileId, 'PEPEUSDT');

    // Before the attempt PEPE is recoverable (actionable), not in the note.
    expect(await ap.tradeArchive.listRecoverableSymbols()).toContain('PEPEUSDT');
    expect(
      (await ap.tradeArchive.listUnreconstructableSymbols()).map((u) => u.symbol),
    ).not.toContain('PEPEUSDT');

    // A backfill that recovered nothing (overshoot) marks it.
    await ap.tradeArchive.recordBackfillAttempt({
      symbol: 'PEPEUSDT',
      roundTrips: 0,
      skippedOrphanSells: 0,
      droppedOvershoot: 2,
    });

    // Now PEPE leaves the recover set and surfaces in the note with its counts.
    expect(await ap.tradeArchive.listRecoverableSymbols()).not.toContain('PEPEUSDT');
    const unrec = await ap.tradeArchive.listUnreconstructableSymbols();
    expect(unrec.find((u) => u.symbol === 'PEPEUSDT')).toMatchObject({
      skippedOrphanSells: 0,
      droppedOvershoot: 2,
    });
    // Bob's marker-less coin never leaks into Alice's note.
    expect(unrec.map((u) => u.symbol)).not.toContain('SHIBUSDT');

    // Upsert: a re-attempt overwrites the counts.
    await ap.tradeArchive.recordBackfillAttempt({
      symbol: 'PEPEUSDT',
      roundTrips: 0,
      skippedOrphanSells: 3,
      droppedOvershoot: 0,
    });
    expect(
      (await ap.tradeArchive.listUnreconstructableSymbols()).find((u) => u.symbol === 'PEPEUSDT'),
    ).toMatchObject({ skippedOrphanSells: 3, droppedOvershoot: 0, symbolUnavailable: false });

    // A delisted coin is terminal for a different reason, and the flag has to
    // survive the round trip for the API to gloss it as such.
    await ap.tradeArchive.recordBackfillAttempt({
      symbol: 'PEPEUSDT',
      roundTrips: 0,
      skippedOrphanSells: 0,
      droppedOvershoot: 0,
      symbolUnavailable: true,
    });
    expect(
      (await ap.tradeArchive.listUnreconstructableSymbols()).find((u) => u.symbol === 'PEPEUSDT'),
    ).toMatchObject({ symbolUnavailable: true });
    // Terminal means terminal for BOTH lists: a delisted coin the operator can
    // still see in the note must not also sit in the actionable set, or the
    // sweep re-enqueues a backfill that can never resolve the symbol.
    expect(await ap.tradeArchive.listRecoverableSymbols()).not.toContain('PEPEUSDT');
  });

  it('lists a symbol that already has archive rows once a NEWER cycle closes un-archived', async () => {
    // The old predicate excluded any symbol holding at least one archive row, so
    // a coin whose first cycle archived cleanly and whose second was missed
    // could never be repaired. Recoverability is relative to the last archived
    // cycle, not to "has any history at all".
    const SYMBOL = 'ADAUSDT';
    await ap.tradeArchive.insert({
      ...seedTrade('ada-first'),
      symbol: SYMBOL,
      baseAsset: 'ADA',
      archivedAt: new Date('2026-06-01T00:00:00Z'),
    });

    // Cycle one, already archived: nothing to recover.
    await ap.appliedFills.tryRecord({ symbol: SYMBOL, orderId: 61, tradeId: 61, side: 'BUY' });
    await ap.appliedFills.tryRecord({ symbol: SYMBOL, orderId: 62, tradeId: 62, side: 'SELL' });
    await fx.db
      .update(appliedFills)
      .set({ appliedAt: new Date('2026-05-20T00:00:00Z') })
      .where(and(eq(appliedFills.profileId, fx.alice.profileId), eq(appliedFills.symbol, SYMBOL)));
    expect(await ap.tradeArchive.listRecoverableSymbols()).not.toContain(SYMBOL);

    // Cycle two closes after that archive row and never lands.
    await ap.appliedFills.tryRecord({ symbol: SYMBOL, orderId: 63, tradeId: 63, side: 'BUY' });
    await ap.appliedFills.tryRecord({ symbol: SYMBOL, orderId: 64, tradeId: 64, side: 'SELL' });
    await settleFills(fx.alice.profileId, SYMBOL, [63, 64]);
    expect(await ap.tradeArchive.listRecoverableSymbols()).toContain(SYMBOL);

    // A backfill that DID recover something clears the nudge without dropping
    // the coin into the "nothing to recover" note: the lists stay disjoint.
    await ap.tradeArchive.recordBackfillAttempt({
      symbol: SYMBOL,
      roundTrips: 1,
      skippedOrphanSells: 0,
      droppedOvershoot: 0,
    });
    expect(await ap.tradeArchive.listRecoverableSymbols()).not.toContain(SYMBOL);
    expect(
      (await ap.tradeArchive.listUnreconstructableSymbols()).map((u) => u.symbol),
    ).not.toContain(SYMBOL);
  });

  it('never lists a BUY-only symbol as recoverable — that is an open position, not lost history', async () => {
    // A coin the bot currently HOLDS has fills and no archive row by definition.
    // Listing it nagged the operator to "recover" a cycle that has not closed
    // yet, and the sweep cron would enqueue a backfill that can reconstruct
    // nothing. Only a symbol with at least one SELL has history to recover.
    await ap.appliedFills.tryRecord({ symbol: 'SOLUSDT', orderId: 41, tradeId: 41, side: 'BUY' });

    expect(await ap.tradeArchive.listRecoverableSymbols()).not.toContain('SOLUSDT');

    // The same coin becomes recoverable the moment it is sold.
    await ap.appliedFills.tryRecord({ symbol: 'SOLUSDT', orderId: 42, tradeId: 42, side: 'SELL' });
    await settleFills(fx.alice.profileId, 'SOLUSDT');
    expect(await ap.tradeArchive.listRecoverableSymbols()).toContain('SOLUSDT');
  });

  it('waits for the closing SELL to settle before calling the cycle recoverable', async () => {
    // The forward archive writes its row shortly after the SELL's `applied_fills`
    // commit. A sweep that enqueued a backfill inside that window would race it
    // into a SECOND P/L row for one cycle: the two paths derive `cycle_end` from
    // different clocks, so the partial unique index cannot collapse them.
    const SYMBOL = 'XRPUSDT';
    await ap.appliedFills.tryRecord({ symbol: SYMBOL, orderId: 71, tradeId: 71, side: 'BUY' });
    await ap.appliedFills.tryRecord({ symbol: SYMBOL, orderId: 72, tradeId: 72, side: 'SELL' });

    expect(await ap.tradeArchive.listRecoverableSymbols()).not.toContain(SYMBOL);

    await settleFills(fx.alice.profileId, SYMBOL);
    expect(await ap.tradeArchive.listRecoverableSymbols()).toContain(SYMBOL);
  });

  it('a fill applied AFTER a backfill attempt makes the marker stale: recoverable again, and not unreconstructable', async () => {
    // The live BTCUSDT timeline: BUY 2026-07-07, backfill attempt 2026-07-11
    // (nothing to reconstruct — the position was still open), SELL 2026-08-01.
    // A marker only speaks for the fills that existed when it was written, so
    // without a staleness check the round trip that closed after it is
    // invisible to BOTH lists and the P/L is lost forever.
    //
    // `applied_at` / `attempted_at` default to now() and the repo API has no
    // parameter for them, so the historical timeline is written directly.
    const SYMBOL = 'LINKUSDT';
    await ap.appliedFills.tryRecord({ symbol: SYMBOL, orderId: 51, tradeId: 51, side: 'BUY' });
    await fx.db
      .update(appliedFills)
      .set({ appliedAt: new Date('2026-07-07T00:00:00Z') })
      .where(and(eq(appliedFills.profileId, fx.alice.profileId), eq(appliedFills.symbol, SYMBOL)));

    await ap.tradeArchive.recordBackfillAttempt({
      symbol: SYMBOL,
      roundTrips: 0,
      skippedOrphanSells: 0,
      droppedOvershoot: 0,
    });
    await fx.db
      .update(backfillAttempts)
      .set({ attemptedAt: new Date('2026-07-11T00:00:00Z') })
      .where(
        and(
          eq(backfillAttempts.profileId, fx.alice.profileId),
          eq(backfillAttempts.symbol, SYMBOL),
        ),
      );

    // Still-valid marker: not actionable, and explained in the quiet note.
    expect(await ap.tradeArchive.listRecoverableSymbols()).not.toContain(SYMBOL);
    expect((await ap.tradeArchive.listUnreconstructableSymbols()).map((u) => u.symbol)).toContain(
      SYMBOL,
    );

    // The exit lands three weeks later — history the attempt never saw.
    await ap.appliedFills.tryRecord({ symbol: SYMBOL, orderId: 52, tradeId: 52, side: 'SELL' });
    await fx.db
      .update(appliedFills)
      .set({ appliedAt: new Date('2026-08-01T00:00:00Z') })
      .where(
        and(
          eq(appliedFills.profileId, fx.alice.profileId),
          eq(appliedFills.symbol, SYMBOL),
          eq(appliedFills.orderId, 52),
        ),
      );

    expect(await ap.tradeArchive.listRecoverableSymbols()).toContain(SYMBOL);
    // And the two lists stay disjoint — never both "recover this" and
    // "nothing to recover".
    expect(
      (await ap.tradeArchive.listUnreconstructableSymbols()).map((u) => u.symbol),
    ).not.toContain(SYMBOL);
  });

  it('setUnreconstructableDismissed hides + reveals a coin, scoped', async () => {
    const bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    await ap.appliedFills.tryRecord({ symbol: 'XLMUSDT', orderId: 31, tradeId: 31, side: 'BUY' });
    await bp.appliedFills.tryRecord({ symbol: 'XLMUSDT', orderId: 32, tradeId: 32, side: 'BUY' });
    await ap.tradeArchive.recordBackfillAttempt({
      symbol: 'XLMUSDT',
      roundTrips: 0,
      skippedOrphanSells: 0,
      droppedOvershoot: 0,
    });
    await bp.tradeArchive.recordBackfillAttempt({
      symbol: 'XLMUSDT',
      roundTrips: 0,
      skippedOrphanSells: 0,
      droppedOvershoot: 0,
    });

    const aliceXlm = () =>
      ap.tradeArchive
        .listUnreconstructableSymbols()
        .then((r) => r.find((u) => u.symbol === 'XLMUSDT'));
    expect((await aliceXlm())?.dismissed).toBe(false);

    // Hide on Alice — Bob's same-symbol marker is untouched (scoped).
    await ap.tradeArchive.setUnreconstructableDismissed('XLMUSDT', true);
    expect((await aliceXlm())?.dismissed).toBe(true);
    expect(
      (await bp.tradeArchive.listUnreconstructableSymbols()).find((u) => u.symbol === 'XLMUSDT')
        ?.dismissed,
    ).toBe(false);

    // Un-hide clears it.
    await ap.tradeArchive.setUnreconstructableDismissed('XLMUSDT', false);
    expect((await aliceXlm())?.dismissed).toBe(false);

    // A re-attempt un-hides too — re-running recovery is a deliberate "look again".
    await ap.tradeArchive.setUnreconstructableDismissed('XLMUSDT', true);
    expect((await aliceXlm())?.dismissed).toBe(true);
    await ap.tradeArchive.recordBackfillAttempt({
      symbol: 'XLMUSDT',
      roundTrips: 0,
      skippedOrphanSells: 0,
      droppedOvershoot: 0,
    });
    expect((await aliceXlm())?.dismissed).toBe(false);
  });

  it('table-level invariant: every trade_archive row resolves to its owning profile (immune to a parallel fixture teardown)', async () => {
    // Belt-and-braces scan: every row must FK-resolve to a profile that still
    // exists. Catches a hypothetical migration regression that orphans rows.
    //
    // Regression for #487 (same flake class fixed in orders.test.ts): the
    // isolation files share one `binance_test` DB and run in parallel (see
    // _helpers.ts), so an unscoped `SELECT * FROM trade_archive` captures rows
    // owned by OTHER files' fixtures. When such a file's afterAll cleanup()
    // CASCADE-deletes its profile between the scan and the per-row owner lookup,
    // the captured foreign row resolves to zero profiles ('expected [] to have
    // length 1'). The interleaved foreign teardown below reproduces that timing;
    // scoping the scan to THIS fixture's profiles (only this file deletes them,
    // in afterAll) makes it deterministic.
    const foreignUser = randomUUID();
    const foreignAccount = randomUUID();
    const foreignProfile = randomUUID();
    await fx.db.insert(users).values({ id: foreignUser, email: `foreign-${foreignUser}@local` });
    await fx.db
      .insert(accounts)
      .values({ id: foreignAccount, ownerId: foreignUser, name: 'foreign', binanceMode: 'test' });
    await fx.db.insert(profiles).values({
      id: foreignProfile,
      accountId: foreignAccount,
      name: 'foreign',
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      config: {},
      state: {},
    });
    const foreign = await profileRepo(
      fx.db,
      asUserId(foreignUser),
      asAccountId(foreignAccount),
      asProfileId(foreignProfile),
    );
    await foreign.tradeArchive.insert(seedTrade('foreign-trade'));

    const ownIds = [fx.alice.profileId, fx.bob.profileId];
    const rows = await fx.db
      .select()
      .from(tradeArchive)
      .where(inArray(tradeArchive.profileId, ownIds));

    // A parallel file's afterAll cleanup lands here, mid-invariant: deleting the
    // foreign user CASCADE-drops its profile and archive row. A scoped scan
    // never read the foreign row, so the owner lookups below still all resolve.
    await fx.db.delete(users).where(eq(users.id, foreignUser));

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const owners = await fx.db.query.profiles.findMany({
        where: (p, { eq }) => eq(p.id, row.profileId),
      });
      expect(owners).toHaveLength(1);
    }
  });
});

/**
 * Proves the `0034_purge_fabricated_trade_archive_seeds` migration predicate
 * only deletes the fabricated seed rows (source='manual', empty orders) and
 * leaves real manual-symbol closes and auto-backfilled rows intact.
 */
describeIfDb('trade_archive fabricated-seed purge predicate', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('deletes only manual rows with an empty orders array', async () => {
    const base = {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      totalBuyQuote: '100',
      totalSellQuote: '110',
      breakdown: {},
      profit: '10',
      profitPercent: '10',
    };
    // (a) fabricated: manual + empty orders → must be deleted.
    const fabricated = await ap.tradeArchive.insert({
      ...base,
      source: 'manual',
      orders: [],
      archivedAt: new Date('2026-05-01T00:00:00Z'),
    });
    // (b) real manual close: manual + populated orders → must survive.
    const realManual = await ap.tradeArchive.insert({
      ...base,
      source: 'manual',
      orders: [{ side: 'BUY' }],
      archivedAt: new Date('2026-05-02T00:00:00Z'),
    });
    // (c) auto backfill: auto + populated orders → must survive.
    const auto = await ap.tradeArchive.insert({
      ...base,
      source: 'auto',
      orders: [{ side: 'SELL' }],
      archivedAt: new Date('2026-05-03T00:00:00Z'),
    });

    // Execute the REAL migration artifact, not a hand-copied predicate, so this
    // safety test can never drift from what the migration actually runs. Anchor
    // the path on import.meta.url to stay robust to vitest's working directory.
    const migrationSql = readFileSync(
      new URL('../../migrations/0034_purge_fabricated_trade_archive_seeds.sql', import.meta.url),
      'utf8',
    );
    await fx.db.execute(sql.raw(migrationSql));

    const remaining = await ap.tradeArchive.listForProfile(100);
    const ids = remaining.map((r) => r.id);
    expect(ids).not.toContain(fabricated.id);
    expect(ids).toContain(realManual.id);
    expect(ids).toContain(auto.id);
  });
});

// Isolated fixture: these tests insert extra rows, so they run against their own
// account rather than polluting the count-based assertions above.
describeIfDb('trade-archive cycle dedup (competing consumers)', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('dedups on (profile, symbol, cycle_end): a repeat insert returns null', async () => {
    const cycleEnd = new Date('2026-06-01T00:00:00Z');
    const first = await ap.tradeArchive.insert({
      ...seedTrade('cycle-1'),
      symbol: 'DEDUPUSDT',
      cycleEnd,
    });
    expect(first).not.toBeNull();
    const repeat = await ap.tradeArchive.insert({
      ...seedTrade('cycle-1b'),
      symbol: 'DEDUPUSDT',
      cycleEnd,
    });
    expect(repeat).toBeNull(); // ON CONFLICT DO NOTHING collapsed it
    const rows = await ap.tradeArchive.listForSymbol('DEDUPUSDT', 100);
    expect(rows).toHaveLength(1); // exactly one archive row for the cycle
  });

  it('two concurrent inserts of the same cycle: exactly one lands', async () => {
    const cycleEnd = new Date('2026-06-02T00:00:00Z');
    const [a, b] = await Promise.all([
      ap.tradeArchive.insert({ ...seedTrade('race-a'), symbol: 'RACEARCH', cycleEnd }),
      ap.tradeArchive.insert({ ...seedTrade('race-b'), symbol: 'RACEARCH', cycleEnd }),
    ]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    const rows = await ap.tradeArchive.listForSymbol('RACEARCH', 100);
    expect(rows).toHaveLength(1);
  });

  it('null cycle_end rows never dedup (partial index): both land', async () => {
    // Legacy/pre-cycle_end rows carry no key, so the partial index excludes them.
    const a = await ap.tradeArchive.insert({ ...seedTrade('legacy-a'), symbol: 'LEGACYARCH' });
    const b = await ap.tradeArchive.insert({ ...seedTrade('legacy-b'), symbol: 'LEGACYARCH' });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const rows = await ap.tradeArchive.listForSymbol('LEGACYARCH', 100);
    expect(rows).toHaveLength(2);
  });
});
