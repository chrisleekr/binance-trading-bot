import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../../src/repo/_scoped.js';
import { profileRepo, profileRepoFromScope, type ProfileRepo } from '../../src/repo/index.js';
import { avgEntryPrices } from '../../src/schema/avg-entry-prices.js';
import { conditionStates } from '../../src/schema/condition-states.js';
import { orders } from '../../src/schema/orders.js';
import { overrideActions } from '../../src/schema/override-actions.js';
import { symbolStates } from '../../src/schema/symbol-states.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * Unbinding a symbol must take its per-symbol state with it, in the same
 * statement that drops the binding.
 *
 * A `condition_states` row is closed only by the owning tick writing a null
 * code, and an unbound symbol never ticks again, so a row left behind can never
 * close: it is read forever as a live blocker on a coin the profile does not
 * own. Selection bias makes the leak systematic rather than occasional — the
 * flat-guard reaps precisely the symbols that never entered, and the reason they
 * never entered IS the open condition row.
 *
 * The teardown therefore belongs inside the unbind, not in a helper each caller
 * must remember; these cases assert the four per-symbol surfaces from the
 * binding side, so every caller inherits the guarantee.
 *
 * Skipped when `DATABASE_TEST_URL` is not set so `bun run test` works on
 * workstations without a Postgres available.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

/** Live rows on each per-symbol surface for one (profile, symbol). */
interface SurfaceCounts {
  conditions: number;
  states: number;
  avgEntry: number;
  pendingOverrides: number;
}

const SEEDED: SurfaceCounts = { conditions: 1, states: 1, avgEntry: 1, pendingOverrides: 1 };
const CLEARED: SurfaceCounts = { conditions: 0, states: 0, avgEntry: 0, pendingOverrides: 0 };

describeIfDb('profile-symbols unbind tears down per-symbol state', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;
  let bp: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  /**
   * Seeds the four per-symbol surfaces an unbind must clear. `quantity` drives
   * the flat-guard: '0' is a flat price marker, anything positive is a held
   * position.
   */
  const seedSurfaces = async (repo: ProfileRepo, symbol: string, quantity = '0'): Promise<void> => {
    await repo.conditionStates.recordCondition({
      condition: 'entry-blocked',
      symbol,
      code: 'knife-guard',
      detail: { drop: '-0.08' },
      now: new Date(),
    });
    await repo.symbolStates.upsert(symbol, {
      state: { schemaVersion: '1.0.0' },
      strategyVersion: '1.0.0',
    });
    await repo.avgEntryPrices.upsert(symbol, { avgEntryPrice: '100', quantity });
    await repo.overrideActions.record({
      symbol,
      action: 'buy',
      actionAt: new Date(),
      payload: { tag: symbol },
      triggeredBy: 'test',
    });
  };

  const countSurfaces = async (profileId: string, symbol: string): Promise<SurfaceCounts> => {
    const conditions = await fx.db
      .select()
      .from(conditionStates)
      .where(and(eq(conditionStates.profileId, profileId), eq(conditionStates.symbol, symbol)));
    const states = await fx.db
      .select()
      .from(symbolStates)
      .where(and(eq(symbolStates.profileId, profileId), eq(symbolStates.symbol, symbol)));
    const avgEntry = await fx.db
      .select()
      .from(avgEntryPrices)
      .where(and(eq(avgEntryPrices.profileId, profileId), eq(avgEntryPrices.symbol, symbol)));
    const pendingOverrides = await fx.db
      .select()
      .from(overrideActions)
      .where(
        and(
          eq(overrideActions.profileId, profileId),
          eq(overrideActions.symbol, symbol),
          isNull(overrideActions.consumedAt),
          isNull(overrideActions.processingAt),
        ),
      );
    return {
      conditions: conditions.length,
      states: states.length,
      avgEntry: avgEntry.length,
      pendingOverrides: pendingOverrides.length,
    };
  };

  // Seeds one open (closed_at null) order so the flat-guard sees a resting order.
  const seedOpenOrder = async (symbol: string): Promise<void> => {
    await fx.db.insert(orders).values({
      accountId: fx.alice.accountId,
      profileId: fx.alice.profileId,
      symbol,
      side: 'BUY',
      intent: 'grid-buy',
      binanceOrderId: 1n,
      clientOrderId: `coid-teardown-${symbol}`,
      status: 'NEW',
      raw: {},
    });
  };

  const bindAuto = async (symbol: string, baseAsset: string): Promise<void> => {
    await ap.profileSymbols.upsert(symbol, baseAsset, { overrideConfig: null });
    await ap.profileSymbols.setSource(symbol, 'auto');
  };

  it('removeAutoIfFlat leaves no per-symbol row behind when it reaps', async () => {
    await bindAuto('TDAUSDT', 'TDA');
    await seedSurfaces(ap, 'TDAUSDT');
    expect(await countSurfaces(fx.alice.profileId, 'TDAUSDT')).toEqual(SEEDED);

    expect(await ap.profileSymbols.removeAutoIfFlat('TDAUSDT')).toBe('removed');
    expect(await countSurfaces(fx.alice.profileId, 'TDAUSDT')).toEqual(CLEARED);
  });

  it('a settled override_action survives the reap', async () => {
    // Teardown clears PENDING work only. A consumed row is history the
    // dust-transfer view still reads, so wiping it would destroy an operator
    // record rather than cancel queued work.
    await bindAuto('TDBUSDT', 'TDB');
    const pending = await ap.overrideActions.record({
      symbol: 'TDBUSDT',
      action: 'dust-transfer',
      actionAt: new Date(),
      payload: { tag: 'settled' },
      triggeredBy: 'test',
    });
    await ap.overrideActions.settle(pending.id, { status: 'applied' });

    expect(await ap.profileSymbols.removeAutoIfFlat('TDBUSDT')).toBe('removed');
    const rows = await fx.db
      .select()
      .from(overrideActions)
      .where(
        and(
          eq(overrideActions.profileId, fx.alice.profileId),
          eq(overrideActions.symbol, 'TDBUSDT'),
        ),
      );
    expect(rows.map((r) => r.id)).toEqual([pending.id]);
  });

  it('removeAutoIfFlat touches nothing when the symbol is not attached', async () => {
    await seedSurfaces(ap, 'TDCUSDT');
    expect(await ap.profileSymbols.removeAutoIfFlat('TDCUSDT')).toBe('not-found');
    expect(await countSurfaces(fx.alice.profileId, 'TDCUSDT')).toEqual(SEEDED);
  });

  it('removeAutoIfFlat touches nothing when the symbol is manual', async () => {
    await ap.profileSymbols.upsert('TDDUSDT', 'TDD', { overrideConfig: null }); // defaults manual
    await seedSurfaces(ap, 'TDDUSDT');
    expect(await ap.profileSymbols.removeAutoIfFlat('TDDUSDT')).toBe('not-auto');
    expect(await countSurfaces(fx.alice.profileId, 'TDDUSDT')).toEqual(SEEDED);
  });

  it('removeAutoIfFlat touches nothing when the symbol holds a position', async () => {
    await bindAuto('TDEUSDT', 'TDE');
    await seedSurfaces(ap, 'TDEUSDT', '0.5');
    expect(await ap.profileSymbols.removeAutoIfFlat('TDEUSDT')).toBe('held');
    expect(await countSurfaces(fx.alice.profileId, 'TDEUSDT')).toEqual(SEEDED);
  });

  it('removeAutoIfFlat touches nothing when the symbol has an open order', async () => {
    await bindAuto('TDFUSDT', 'TDF');
    await seedSurfaces(ap, 'TDFUSDT');
    await seedOpenOrder('TDFUSDT');
    expect(await ap.profileSymbols.removeAutoIfFlat('TDFUSDT')).toBe('held');
    expect(await countSurfaces(fx.alice.profileId, 'TDFUSDT')).toEqual(SEEDED);
  });

  it('remove leaves no per-symbol row behind', async () => {
    await ap.profileSymbols.upsert('TDGUSDT', 'TDG', { overrideConfig: null });
    await seedSurfaces(ap, 'TDGUSDT', '0.5');
    expect(await countSurfaces(fx.alice.profileId, 'TDGUSDT')).toEqual(SEEDED);

    await ap.profileSymbols.remove('TDGUSDT');
    expect(await ap.profileSymbols.findForSymbol('TDGUSDT')).toBeNull();
    expect(await countSurfaces(fx.alice.profileId, 'TDGUSDT')).toEqual(CLEARED);
  });

  it('remove joins an outer transaction rather than opening its own', async () => {
    // The disposal handoff calls `remove` from inside its own transaction, so the
    // teardown's `db.transaction` nests. Drizzle's node-postgres driver emits a
    // SAVEPOINT for that, which means the work is the outer transaction's to keep
    // or discard. A second connection would commit independently and survive this
    // rollback, so the rows still being here is what proves it nested.
    await ap.profileSymbols.upsert('TDJUSDT', 'TDJ', { overrideConfig: null });
    await seedSurfaces(ap, 'TDJUSDT');

    const abort = new Error('roll the outer transaction back');
    await expect(
      fx.db.transaction(async (tx) => {
        await profileRepoFromScope(withTx(ap.scope, tx)).profileSymbols.remove('TDJUSDT');
        throw abort;
      }),
    ).rejects.toBe(abort);

    expect(await ap.profileSymbols.findForSymbol('TDJUSDT')).not.toBeNull();
    expect(await countSurfaces(fx.alice.profileId, 'TDJUSDT')).toEqual(SEEDED);
  });

  it('teardown is scoped to the unbinding profile, not the symbol', async () => {
    // Two profiles under different accounts legitimately track the same coin.
    // A teardown keyed on symbol alone would blank the sibling's live state.
    await ap.profileSymbols.upsert('TDHUSDT', 'TDH', { overrideConfig: null });
    await bp.profileSymbols.upsert('TDHUSDT', 'TDH', { overrideConfig: null });
    await seedSurfaces(ap, 'TDHUSDT');
    await seedSurfaces(bp, 'TDHUSDT');

    await ap.profileSymbols.remove('TDHUSDT');
    expect(await countSurfaces(fx.alice.profileId, 'TDHUSDT')).toEqual(CLEARED);
    expect(await countSurfaces(fx.bob.profileId, 'TDHUSDT')).toEqual(SEEDED);
  });

  it('a profile-level condition survives a per-symbol teardown', async () => {
    // The profile subject is stored as the empty-string sentinel, so a teardown
    // that filtered loosely on the profile alone would take "discovery found
    // nothing" down with one coin.
    await bindAuto('TDIUSDT', 'TDI');
    await seedSurfaces(ap, 'TDIUSDT');
    await ap.conditionStates.recordCondition({
      condition: 'discovery-idle',
      code: 'no-candidates',
      now: new Date(),
    });

    expect(await ap.profileSymbols.removeAutoIfFlat('TDIUSDT')).toBe('removed');
    expect(await countSurfaces(fx.alice.profileId, 'TDIUSDT')).toEqual(CLEARED);
    expect(await ap.conditionStates.findOne('discovery-idle')).toBeDefined();
  });
});
