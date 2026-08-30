import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import { orders } from '../../src/schema/orders.js';
import { profileSymbols } from '../../src/schema/profile-symbols.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * Account-scoped happy-path matrix for `packages/db/src/repo/profile-symbols.ts`.
 * Every exported fn takes a `ProfileScope`, so a wrong-owner call cannot be
 * expressed — ownership is proven once by `scopeProfile`. Cross-account
 * rejection lives in `cross-account.test.ts`.
 *
 * Skipped when `DATABASE_TEST_URL` is not set so `bun run test` works on
 * workstations without a Postgres available.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('profile-symbols account-scoped reads and writes', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    // Seed one symbol. The composite PK (profile_id, symbol) means each
    // (profile, symbol) pair holds exactly one row.
    await ap.profileSymbols.upsert('BTCUSDT', 'BTC', {
      overrideConfig: { tag: 'alice-btc' },
    });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('listForProfile returns only the owner-scoped rows on the happy path', async () => {
    const rows = await ap.profileSymbols.listForProfile();
    expect(rows.map((r) => r.profileId)).toEqual([fx.alice.profileId]);
    expect(rows[0]?.overrideConfig).toEqual({ tag: 'alice-btc' });
  });

  it('upsert replaces in place on the owner happy path', async () => {
    await ap.profileSymbols.upsert('BTCUSDT', 'BTC', {
      overrideConfig: { tag: 'alice-btc-v2' },
    });
    const rows = await ap.profileSymbols.listForProfile();
    expect(rows.filter((r) => r.symbol === 'BTCUSDT')).toHaveLength(1);
    expect(rows.find((r) => r.symbol === 'BTCUSDT')?.overrideConfig).toEqual({
      tag: 'alice-btc-v2',
    });
  });

  it('remove deletes the targeted row on the owner happy path', async () => {
    // Self-contained — seed a row inside this test so removal doesn't
    // poison shared state for later tests in the suite. Keeps the suite
    // order-independent.
    await ap.profileSymbols.upsert('XRPUSDT', 'XRP', {
      overrideConfig: { tag: 'alice-xrp' },
    });
    await ap.profileSymbols.remove('XRPUSDT');
    const rows = await ap.profileSymbols.listForProfile();
    expect(rows.find((r) => r.symbol === 'XRPUSDT')).toBeUndefined();
  });

  it('table-level invariant: every profile_symbols row resolves to its owning profile', async () => {
    // Belt-and-braces scan: every row must FK-resolve to a profile that
    // still exists. Catches a hypothetical migration regression where rows
    // orphan from their profile.
    //
    // Scoped to THIS fixture's profiles (#487 flake class, mirrors the fix in
    // trade-archive.test.ts): the isolation files share one `binance_test` DB
    // and run in parallel, so an unscoped scan captures rows owned by other
    // files' fixtures. When such a file's afterAll CASCADE-deletes its profile
    // between the scan and the per-row owner lookup, the foreign row resolves to
    // zero profiles ('expected [] to have length 1'). Only this file deletes
    // these profiles (in afterAll), so scoping the scan makes it deterministic.
    const ownIds = [fx.alice.profileId, fx.bob.profileId];
    const rows = await fx.db
      .select()
      .from(profileSymbols)
      .where(inArray(profileSymbols.profileId, ownIds));
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
 * Provenance and reap-protection are two independent columns, and this block pins that they stay independent. `source` records who created the binding; `pinned` alone gates the reap, together with flatness (zero held quantity, no open orders). The flatness inputs (avg_entry_prices, orders) are seeded directly so each branch is exercised.
 */
describeIfDb('profile-symbols provenance + pin + flat-guard', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  // Seeds one open (closed_at null) order so the flat-guard sees a resting order.
  const seedOpenOrder = async (symbol: string): Promise<void> => {
    await fx.db.insert(orders).values({
      accountId: fx.alice.accountId,
      profileId: fx.alice.profileId,
      symbol,
      side: 'BUY',
      intent: 'grid-buy',
      binanceOrderId: 1n,
      clientOrderId: `coid-${symbol}`,
      status: 'NEW',
      raw: {},
    });
  };

  it('a freshly attached symbol defaults to source=manual and UNPINNED', async () => {
    await ap.profileSymbols.upsert('AAAUSDT', 'AAA', { overrideConfig: null });
    const row = await ap.profileSymbols.findForSymbol('AAAUSDT');
    expect(row?.source).toBe('manual');
    // Reap protection is never granted by default. A seam that means to protect a binding says so; one that merely re-binds must not silently exempt the coin from rotation forever.
    expect(row?.pinned).toBe(false);
    expect(row?.pinnedAt).toBeNull();
    expect(row?.lastFlattenAt).toBeNull();
  });

  it('setSource records provenance and is idempotent; returns null for a missing symbol', async () => {
    await ap.profileSymbols.upsert('BBBUSDT', 'BBB', { overrideConfig: null });
    expect((await ap.profileSymbols.setSource('BBBUSDT', 'auto'))?.source).toBe('auto');
    expect((await ap.profileSymbols.setSource('BBBUSDT', 'unknown'))?.source).toBe('unknown');
    expect((await ap.profileSymbols.setSource('BBBUSDT', 'manual'))?.source).toBe('manual');
    expect((await ap.profileSymbols.setSource('BBBUSDT', 'manual'))?.source).toBe('manual');
    expect(await ap.profileSymbols.setSource('NOPEUSDT', 'manual')).toBeNull();
  });

  it('a pin/unpin round-trip moves the pin and its stamp, and never touches provenance', async () => {
    await ap.profileSymbols.upsert('PINUSDT', 'PIN', { overrideConfig: null });
    await ap.profileSymbols.setSource('PINUSDT', 'auto');
    const at = new Date('2026-08-24T10:00:00.000Z');

    const pinned = await ap.profileSymbols.setPinned('PINUSDT', true, at);
    expect(pinned?.pinned).toBe(true);
    expect(pinned?.pinnedAt?.toISOString()).toBe(at.toISOString());
    // Pinning a coin discovery rotated in does not make the operator its author; the archive's provenance column would start lying if it did.
    expect(pinned?.source).toBe('auto');

    const unpinned = await ap.profileSymbols.setPinned('PINUSDT', false, at);
    expect(unpinned?.pinned).toBe(false);
    // The stamp goes with the pin, so a later re-pin cannot inherit a stale date and a null stamp keeps meaning exactly one thing.
    expect(unpinned?.pinnedAt).toBeNull();
    expect(unpinned?.source).toBe('auto');

    expect(await ap.profileSymbols.setPinned('NOPEUSDT', true, at)).toBeNull();
  });

  it('an ordinary re-bind leaves an existing pin and its stamp alone', async () => {
    const at = new Date('2026-08-24T11:00:00.000Z');
    await ap.profileSymbols.upsert('KEEPUSDT', 'KEEP', { overrideConfig: null });
    await ap.profileSymbols.setPinned('KEEPUSDT', true, at);
    // A config reset or a discovery re-add says nothing about the pin, so writing one here would silently release a coin the operator ringfenced.
    await ap.profileSymbols.upsert('KEEPUSDT', 'KEEP', { overrideConfig: null });
    const row = await ap.profileSymbols.findForSymbol('KEEPUSDT');
    expect(row?.pinned).toBe(true);
    expect(row?.pinnedAt?.toISOString()).toBe(at.toISOString());
  });

  it('recordFlatten stamps last_flatten_at; returns null for a missing symbol', async () => {
    await ap.profileSymbols.upsert('FLATUSDT', 'FLAT', { overrideConfig: null });
    const at = new Date('2026-06-09T00:00:00.000Z');
    const row = await ap.profileSymbols.recordFlatten('FLATUSDT', at);
    expect(row?.lastFlattenAt?.toISOString()).toBe(at.toISOString());
    expect(await ap.profileSymbols.recordFlatten('NOPEUSDT', at)).toBeNull();
  });

  it('removeUnpinnedIfFlat returns not-found for an unattached symbol', async () => {
    expect(await ap.profileSymbols.removeUnpinnedIfFlat('GHOSTUSDT')).toBe('not-found');
  });

  it('removeUnpinnedIfFlat refuses to reap a pinned symbol', async () => {
    await ap.profileSymbols.upsert('CCCUSDT', 'CCC', { overrideConfig: null });
    await ap.profileSymbols.setPinned('CCCUSDT', true, new Date());
    expect(await ap.profileSymbols.removeUnpinnedIfFlat('CCCUSDT')).toBe('pinned');
    expect(await ap.profileSymbols.findForSymbol('CCCUSDT')).not.toBeNull();
  });

  it('removeUnpinnedIfFlat REAPS an unpinned source=manual row — provenance alone protects nothing', async () => {
    // The whole point of the split. A binding can carry operator provenance and still be rotatable, and the recovery paths that used to claim `manual` purely to survive the reap are exactly why.
    await ap.profileSymbols.upsert('MANUSDT', 'MAN', { overrideConfig: null });
    expect((await ap.profileSymbols.findForSymbol('MANUSDT'))?.source).toBe('manual');
    expect(await ap.profileSymbols.removeUnpinnedIfFlat('MANUSDT')).toBe('removed');
    expect(await ap.profileSymbols.findForSymbol('MANUSDT')).toBeNull();
  });

  it('removeUnpinnedIfFlat reaps a system-recovered (source=unknown) row once it is flat', async () => {
    await ap.profileSymbols.upsert('RECUSDT', 'REC', { overrideConfig: null, source: 'unknown' });
    expect(await ap.profileSymbols.removeUnpinnedIfFlat('RECUSDT')).toBe('removed');
    expect(await ap.profileSymbols.findForSymbol('RECUSDT')).toBeNull();
  });

  it('removeUnpinnedIfFlat reaps an unpinned symbol that is flat', async () => {
    await ap.profileSymbols.upsert('DDDUSDT', 'DDD', { overrideConfig: null });
    await ap.profileSymbols.setSource('DDDUSDT', 'auto');
    expect(await ap.profileSymbols.removeUnpinnedIfFlat('DDDUSDT')).toBe('removed');
    expect(await ap.profileSymbols.findForSymbol('DDDUSDT')).toBeNull();
  });

  it('removeUnpinnedIfFlat refuses an unpinned symbol holding a position (quantity > 0)', async () => {
    await ap.profileSymbols.upsert('EEEUSDT', 'EEE', { overrideConfig: null });
    await ap.profileSymbols.setSource('EEEUSDT', 'auto');
    await ap.avgEntryPrices.upsert('EEEUSDT', { avgEntryPrice: '100', quantity: '0.5' });
    expect(await ap.profileSymbols.removeUnpinnedIfFlat('EEEUSDT')).toBe('held');
    expect(await ap.profileSymbols.findForSymbol('EEEUSDT')).not.toBeNull();
  });

  it('removeUnpinnedIfFlat refuses an unpinned symbol with an open order', async () => {
    await ap.profileSymbols.upsert('FFFUSDT', 'FFF', { overrideConfig: null });
    await ap.profileSymbols.setSource('FFFUSDT', 'auto');
    await seedOpenOrder('FFFUSDT');
    expect(await ap.profileSymbols.removeUnpinnedIfFlat('FFFUSDT')).toBe('held');
    expect(await ap.profileSymbols.findForSymbol('FFFUSDT')).not.toBeNull();
  });

  it('removeUnpinnedIfFlat refuses an unpinned symbol holding a position AND an open order', async () => {
    await ap.profileSymbols.upsert('IIIUSDT', 'III', { overrideConfig: null });
    await ap.profileSymbols.setSource('IIIUSDT', 'auto');
    await ap.avgEntryPrices.upsert('IIIUSDT', { avgEntryPrice: '100', quantity: '0.5' });
    await seedOpenOrder('IIIUSDT');
    expect(await ap.profileSymbols.removeUnpinnedIfFlat('IIIUSDT')).toBe('held');
    expect(await ap.profileSymbols.findForSymbol('IIIUSDT')).not.toBeNull();
  });

  it('a PINNED symbol holding a position reports the pin, not held — the operator must unpin first', async () => {
    // Both refusals leave the row in place, but they need different operator actions, and the tick-boundary self-heal prints a different sentence for each.
    await ap.profileSymbols.upsert('JJJUSDT', 'JJJ', { overrideConfig: null });
    await ap.profileSymbols.setPinned('JJJUSDT', true, new Date());
    await ap.avgEntryPrices.upsert('JJJUSDT', { avgEntryPrice: '100', quantity: '0.5' });
    expect(await ap.profileSymbols.removeUnpinnedIfFlat('JJJUSDT')).toBe('pinned');
  });

  it('removeUnpinnedIfFlat treats a zero-quantity ledger row as flat', async () => {
    await ap.profileSymbols.upsert('GGGUSDT', 'GGG', { overrideConfig: null });
    await ap.profileSymbols.setSource('GGGUSDT', 'auto');
    await ap.avgEntryPrices.upsert('GGGUSDT', { avgEntryPrice: '100', quantity: '0' });
    expect(await ap.profileSymbols.removeUnpinnedIfFlat('GGGUSDT')).toBe('removed');
  });

  it('removeUnpinnedIfFlat ignores a closed order (closed_at set) when judging flatness', async () => {
    await ap.profileSymbols.upsert('HHHUSDT', 'HHH', { overrideConfig: null });
    await ap.profileSymbols.setSource('HHHUSDT', 'auto');
    await fx.db.insert(orders).values({
      accountId: fx.alice.accountId,
      profileId: fx.alice.profileId,
      symbol: 'HHHUSDT',
      side: 'BUY',
      intent: 'grid-buy',
      binanceOrderId: 2n,
      clientOrderId: 'coid-HHH-closed',
      status: 'FILLED',
      raw: {},
      closedAt: new Date(),
    });
    expect(await ap.profileSymbols.removeUnpinnedIfFlat('HHHUSDT')).toBe('removed');
  });
});
