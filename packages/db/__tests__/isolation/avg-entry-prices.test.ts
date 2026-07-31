import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import { avgEntryPrices } from '../../src/schema/avg-entry-prices.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * Account-scoped happy-path matrix for `packages/db/src/repo/avg-entry-prices.ts`.
 * All three fns (`findBySymbol`, `upsert`, `remove`) take a `ProfileScope`,
 * so a wrong-owner call cannot be expressed — ownership is proven once by
 * `scopeProfile`. Cross-account rejection lives in `cross-account.test.ts`.
 *
 * Skipped when `DATABASE_TEST_URL` is not set so `bun run test` works on
 * workstations without a Postgres available.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('avg-entry-prices account-scoped reads and writes', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;
  let bp: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    // Seed one (profile, symbol) per account. The composite PK
    // (profile_id, symbol) means each (profile, symbol) holds one row.
    // Decimal-bearing columns ride as decimal-strings per the money-math
    // invariant in CLAUDE.md.
    await ap.avgEntryPrices.upsert('BTCUSDT', {
      avgEntryPrice: '60000',
      quantity: '0.001',
    });
    await bp.avgEntryPrices.upsert('BTCUSDT', {
      avgEntryPrice: '61000',
      quantity: '0.002',
    });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('findBySymbol returns the correct account row on the happy path', async () => {
    const row = await ap.avgEntryPrices.findBySymbol('BTCUSDT');
    expect(row?.profileId).toBe(fx.alice.profileId);
    // numeric(38,18) round-trips with full scale; compare numerically.
    expect(Number(row?.avgEntryPrice)).toBe(60000);
    expect(Number(row?.quantity)).toBe(0.001);
  });

  it('findBySymbol returns null for the owner when the symbol is not stored', async () => {
    const row = await ap.avgEntryPrices.findBySymbol('NEVERSEEN');
    expect(row).toBeNull();
  });

  it('upsert replaces in place on the owner happy path under the composite PK', async () => {
    await ap.avgEntryPrices.upsert('BTCUSDT', {
      avgEntryPrice: '62000',
      quantity: '0.0015',
    });
    const row = await ap.avgEntryPrices.findBySymbol('BTCUSDT');
    expect(Number(row?.avgEntryPrice)).toBe(62000);
    expect(Number(row?.quantity)).toBe(0.0015);
  });

  it('remove deletes the targeted row on the owner happy path', async () => {
    // Self-contained — seed a row inside this test so removal doesn't poison
    // shared state for any later test in the suite.
    await ap.avgEntryPrices.upsert('XRPUSDT', {
      avgEntryPrice: '0.6',
      quantity: '100',
    });
    await ap.avgEntryPrices.remove('XRPUSDT');
    const gone = await ap.avgEntryPrices.findBySymbol('XRPUSDT');
    expect(gone).toBeNull();
  });

  it('table-level invariant: every avg_entry_prices row resolves to its owning profile', async () => {
    // Belt-and-braces scan: every row must FK-resolve to a profile that
    // still exists. Catches a hypothetical migration regression that
    // orphans rows.
    // Scoped to this fixture's profiles (#487 flake class, see trade-archive.test.ts):
    // parallel isolation files share one DB, so an unscoped scan can capture a foreign
    // row whose profile is CASCADE-deleted by another file's teardown mid-test.
    const rows = await fx.db
      .select()
      .from(avgEntryPrices)
      .where(inArray(avgEntryPrices.profileId, [fx.alice.profileId, fx.bob.profileId]));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const owners = await fx.db.query.profiles.findMany({
        where: (p, { eq }) => eq(p.id, row.profileId),
      });
      expect(owners).toHaveLength(1);
    }
  });
});
