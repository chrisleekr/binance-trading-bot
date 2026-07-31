import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import { manualOrders } from '../../src/schema/manual-orders.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * Account-scoped happy-path matrix for `packages/db/src/repo/manual-orders.ts`.
 * Both exported fns (`findByBinanceOrderId`, `upsert`) take a `ProfileScope`,
 * so a wrong-owner call cannot be expressed — ownership is proven once by
 * `scopeProfile`. Cross-account rejection lives in `cross-account.test.ts`.
 *
 * Skipped when `DATABASE_TEST_URL` is not set so `bun run test` works on
 * workstations without a Postgres available.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('manual-orders account-scoped reads and writes', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;
  let bp: ProfileRepo;
  const ALICE_ORDER_ID = 1_000_001n;
  const BOB_ORDER_ID = 2_000_001n;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    // Seed one manual order per account. The unique(profileId, binanceOrderId)
    // index guarantees deduplication on re-upsert.
    await ap.manualOrders.upsert({
      symbol: 'BTCUSDT',
      binanceOrderId: ALICE_ORDER_ID,
      status: 'NEW',
      raw: { side: 'BUY', tag: 'alice-1' },
    });
    await bp.manualOrders.upsert({
      symbol: 'BTCUSDT',
      binanceOrderId: BOB_ORDER_ID,
      status: 'NEW',
      raw: { side: 'BUY', tag: 'bob-1' },
    });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('findByBinanceOrderId returns the correct account row on the happy path', async () => {
    const row = await ap.manualOrders.findByBinanceOrderId(ALICE_ORDER_ID);
    expect(row?.profileId).toBe(fx.alice.profileId);
    expect(row?.binanceOrderId).toBe(ALICE_ORDER_ID);
    // Defence-in-depth: returned payload must be Alice's, never Bob's.
    expect(row?.raw).toEqual({ side: 'BUY', tag: 'alice-1' });
  });

  it('upsert replaces in place on the owner happy path', async () => {
    await ap.manualOrders.upsert({
      symbol: 'BTCUSDT',
      binanceOrderId: ALICE_ORDER_ID,
      status: 'FILLED',
      raw: { side: 'BUY', tag: 'alice-1', filled: true },
    });
    const row = await ap.manualOrders.findByBinanceOrderId(ALICE_ORDER_ID);
    expect(row?.status).toBe('FILLED');
    expect(row?.raw).toEqual({ side: 'BUY', tag: 'alice-1', filled: true });
  });

  it('table-level invariant: every manual_orders row resolves to its owning profile', async () => {
    // Belt-and-braces scan: every row must FK-resolve to a profile that
    // still exists. Catches a hypothetical migration regression that
    // orphans rows.
    // Scoped to this fixture's profiles (#487 flake class, see trade-archive.test.ts):
    // parallel isolation files share one DB, so an unscoped scan can capture a foreign
    // row whose profile is CASCADE-deleted by another file's teardown mid-test.
    const rows = await fx.db
      .select()
      .from(manualOrders)
      .where(inArray(manualOrders.profileId, [fx.alice.profileId, fx.bob.profileId]));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const owners = await fx.db.query.profiles.findMany({
        where: (p, { eq }) => eq(p.id, row.profileId),
      });
      expect(owners).toHaveLength(1);
    }
  });
});
