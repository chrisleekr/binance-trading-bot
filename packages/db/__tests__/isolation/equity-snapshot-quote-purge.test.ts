import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import { equitySnapshots } from '../../src/schema/equity-snapshots.js';
import { profiles } from '../../src/schema/profiles.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * Migration 0085 DELETEs rows, and `migrate()` running against an empty table proves only that the SQL parses. This pins WHICH rows it takes, because every clause is load-bearing and each is easy to drop by accident, and the rows cannot be recomputed — an over-broad predicate is unrecoverable.
 *
 * Three cases are seeded per profile and one across profiles: a snapshot captured BEFORE any foreign-quote cycle (clean, kept by the `archived_at < captured_at` bound), one captured after (contaminated, taken), one stamped with a PREVIOUS quote (correct when written, kept on disk because the reader filters by quote instead), and one on a sibling profile (kept by the `t.profile_id = e.profile_id` join, which is only exercised when the sibling's own snapshot is otherwise a live candidate).
 *
 * The real migration artifact is executed, never a hand-copied predicate, so this test cannot drift from what the migration actually runs.
 *
 * Skipped when `DATABASE_TEST_URL` is unset so `bun run test` works without PG.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

// Reading the artifact keeps this honest; see the block comment. NOTE: the statement is database-WIDE, not scoped to this fixture's profiles, which breaks the isolation suite's usual "touch only your own rows" contract. Safe today because no other suite sharing this database writes `equity_snapshots`; a suite that starts doing so must not run concurrently with this one.
const migration0085 = (): string =>
  readFileSync(
    new URL('../../migrations/0085_purge_cross_quote_equity_snapshots.sql', import.meta.url),
    'utf8',
  );

const snapshotRow = (profileId: string, capturedAt: string, quoteAsset: string) => ({
  profileId,
  capturedAt: new Date(capturedAt),
  quoteAsset,
  netPnlQuote: '1',
  realizedNetQuote: '1',
  positionValueQuote: '0',
  positionCostQuote: '0',
  benchmarkAsset: 'BTC',
  benchmarkPriceQuote: '0',
});

const RANGE_FROM = new Date('2029-01-01T00:00:00Z');
const RANGE_TO = new Date('2030-01-01T00:00:00Z');

describeIfDb('0085 cross-quote equity-snapshot purge', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('takes only the snapshots a foreign-quote cycle could have poisoned', async () => {
    // The profile settles in BTC now; its USDT cycles are history from before the switch.
    await fx.db
      .update(profiles)
      .set({ quoteAsset: 'BTC' })
      .where(eq(profiles.id, fx.alice.profileId));
    // The USDT cycle that poisons every sum taken after it.
    await ap.tradeArchive.insert({
      symbol: 'ETHUSDT',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      totalBuyQuote: '100',
      totalSellQuote: '110',
      breakdown: {},
      profit: '10',
      profitPercent: '10',
      orders: [{ side: 'SELL' as const }],
      feesQuote: '1',
      source: 'manual',
      archivedAt: new Date('2029-04-01T00:00:00Z'),
    });

    const [cleanBtc] = await fx.db
      .insert(equitySnapshots)
      // Captured BEFORE the USDT cycle was archived, so no foreign row was visible to its sum. Survives only because of the `archived_at < captured_at` bound; drop that bound and this assertion goes red.
      .values(snapshotRow(fx.alice.profileId, '2029-03-01T00:00:00Z', 'BTC'))
      .returning();
    const [oldQuote] = await fx.db
      .insert(equitySnapshots)
      // Stamped with the previous quote. Correct when written and kept on disk: the reader selects one currency, so this never plots under the BTC label, and it becomes readable again if the operator switches back.
      .values(snapshotRow(fx.alice.profileId, '2029-03-02T00:00:00Z', 'USDT'))
      .returning();
    const [contaminated] = await fx.db
      .insert(equitySnapshots)
      // Captured after the USDT cycle, and stamped BTC — so no read filter can exclude it. Deleting is the only way to stop it plotting.
      .values(snapshotRow(fx.alice.profileId, '2029-05-01T00:00:00Z', 'BTC'))
      .returning();

    await fx.db.execute(sql.raw(migration0085()));

    const btc = await ap.equitySnapshots.listForProfileInRange('BTC', RANGE_FROM, RANGE_TO, 100);
    expect(btc.map((r) => r.id)).toContain(cleanBtc!.id);
    expect(btc.map((r) => r.id)).not.toContain(contaminated!.id);
    // Still on disk, and reachable by reading the quote it was recorded in.
    const usdt = await ap.equitySnapshots.listForProfileInRange('USDT', RANGE_FROM, RANGE_TO, 100);
    expect(usdt.map((r) => r.id)).toContain(oldQuote!.id);
  });

  it('keeps a same-currency series whose stored quote differs only in casing', async () => {
    // `profiles.quote_asset` is allowed to be stored lower or mixed case, and the snapshot column is stamped from it verbatim, while `trade_archive.quote_asset` always carries Binance's upper casing. A raw `<>` would read `'USDT' <> 'usdt'` as a currency mismatch and delete this profile's entire correct history — over-deleting exactly the kind of row the migration exists to protect.
    const bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    await fx.db
      .update(profiles)
      .set({ quoteAsset: 'usdt' })
      .where(eq(profiles.id, fx.bob.profileId));
    await bp.tradeArchive.insert({
      symbol: 'ETHUSDT',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      totalBuyQuote: '100',
      totalSellQuote: '110',
      breakdown: {},
      profit: '10',
      profitPercent: '10',
      orders: [{ side: 'SELL' as const }],
      feesQuote: '1',
      source: 'manual',
      archivedAt: new Date('2029-07-01T00:00:00Z'),
    });
    const [lowerCased] = await fx.db
      .insert(equitySnapshots)
      .values(snapshotRow(fx.bob.profileId, '2029-07-02T00:00:00Z', 'usdt'))
      .returning();

    await fx.db.execute(sql.raw(migration0085()));

    const remaining = await bp.equitySnapshots.listForProfileInRange(
      'USDT',
      RANGE_FROM,
      RANGE_TO,
      100,
    );
    expect(remaining.map((r) => r.id)).toContain(lowerCased!.id);
  });

  it('leaves a sibling profile untouched — the exists-clause joins on profile_id', async () => {
    const bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    // Bob settles in USDT, and his own archive (seeded above) is USDT too, so nothing of his can trip the sub-select. Alice's BTC cycle below is archived BEFORE Bob's capture and is in a different quote from Bob's snapshot, so it satisfies every clause of the exists-sub-select EXCEPT `t.profile_id = e.profile_id`. Drop that join and Alice's cycle deletes Bob's row.
    await ap.tradeArchive.insert({
      symbol: 'ETHBTC',
      baseAsset: 'ETH',
      quoteAsset: 'BTC',
      totalBuyQuote: '5',
      totalSellQuote: '5.5',
      breakdown: {},
      profit: '0.5',
      profitPercent: '10',
      orders: [{ side: 'SELL' as const }],
      feesQuote: '0.01',
      source: 'manual',
      archivedAt: new Date('2029-05-15T00:00:00Z'),
    });
    const [bobSnap] = await fx.db
      .insert(equitySnapshots)
      .values(snapshotRow(fx.bob.profileId, '2029-06-01T00:00:00Z', 'USDT'))
      .returning();

    await fx.db.execute(sql.raw(migration0085()));

    const remaining = await bp.equitySnapshots.listForProfileInRange(
      'USDT',
      RANGE_FROM,
      RANGE_TO,
      100,
    );
    expect(remaining.map((r) => r.id)).toContain(bobSnap!.id);
  });
});
