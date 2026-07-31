import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { ProfileScope } from '@app/db';

// `runHeldQuantityReconciliation` resolves `profileRepo` from `@app/db`.
// Mock at module level so the orchestrator test can drive scope methods
// (findById, avgEntryPrices.findBySymbol, avgEntryPrices.remove,
// symbolStates.findBySymbol/upsert) without touching a real DB.
const repoMocks = vi.hoisted(() => ({
  profileFindById: vi.fn(),
  avgEntryPricesFindBySymbol: vi.fn(),
  avgEntryPricesRemove: vi.fn(),
  avgEntryPricesUpsert: vi.fn(),
  symbolStatesFindBySymbol: vi.fn(),
  profileSymbolsListForProfile: vi.fn(),
  // Binance mode is a per-account attribute now, read via repo.accounts.
  binanceModeById: vi.fn(),
}));

vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return {
    ...orig,
    profileRepo: vi.fn(
      async (_db: unknown, operatorId: UserId, accountId: AccountId, profileId: ProfileId) => ({
        scope: { userId: operatorId, accountId, profileId },
        profile: {
          findById: repoMocks.profileFindById,
        },
        avgEntryPrices: {
          findBySymbol: repoMocks.avgEntryPricesFindBySymbol,
          remove: repoMocks.avgEntryPricesRemove,
          upsert: repoMocks.avgEntryPricesUpsert,
        },
        symbolStates: {
          findBySymbol: repoMocks.symbolStatesFindBySymbol,
        },
        profileSymbols: {
          listForProfile: repoMocks.profileSymbolsListForProfile,
        },
      }),
    ),
    repo: {
      ...orig.repo,
      accounts: { ...orig.repo.accounts, binanceModeById: repoMocks.binanceModeById },
    },
  };
});

import {
  ensureCostBasisFromTrades,
  migrateProfileIfNeeded,
  reconcileHeldQuantity,
  reconcileHeldQuantityForTarget,
  reconcileSymbol,
  runHeldQuantityReconciliation,
  type BinanceAccountClient,
  type MigrationStrategy,
  type ReconcileOrchestratorDeps,
  type ReconcileSymbolTarget,
  type ReconcileWalletDeps,
  type StrategyLookup,
} from '../../src/boot/reconcile-held-quantity.js';
import { buildSymbolInfoKey } from '../../src/executor/redis-namespace.js';
import { createChainByKey } from '../../src/lib/chain-by-key.js';
import { trailingTradePositionAdapter } from '@app/strategy-trailing-trade';

const USER_ID = 'u1' as unknown as UserId;
const ACCOUNT_ID = 'a1' as unknown as AccountId;
const PROFILE_ID = 'p1' as unknown as ProfileId;
// Proven scope the boot reconciler threads into the migrated-state write.
// `db` is unused (the persister is stubbed); only the id pair is read.
const SCOPE = { userId: USER_ID, profileId: PROFILE_ID } as unknown as ProfileScope;

// Attach the real TT position adapter so the orchestrator resolves a
// capability for the profile; the adapter's schemaVersion gate then drives
// the per-symbol skip-vs-reconcile decision off the row body, exactly as
// production does.
const stubStrategies = (strategy: MigrationStrategy | null): StrategyLookup => ({
  get: () => (strategy ? { ...strategy, position: trailingTradePositionAdapter } : undefined),
});

const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

describe('reconcileHeldQuantity (pure core)', () => {
  it('no-ops when state and wallet agree within stepSize', () => {
    const r = reconcileHeldQuantity({
      heldQuantity: '0.0010',
      walletFree: '0.0010',
      walletLocked: '0',
      stepSize: '0.0001',
    });
    expect(r.action).toBe('no-op');
    expect(r.nextHeldQuantity).toBe('0.0010');
  });

  it('no-ops when diff is exactly stepSize (boundary)', () => {
    const r = reconcileHeldQuantity({
      heldQuantity: '0.0011',
      walletFree: '0.0010',
      walletLocked: '0',
      stepSize: '0.0001',
    });
    expect(r.action).toBe('no-op');
  });

  it('adopts wallet when wallet < heldQuantity by more than stepSize (operator withdrew)', () => {
    const r = reconcileHeldQuantity({
      heldQuantity: '0.0010',
      walletFree: '0.0005',
      walletLocked: '0',
      stepSize: '0.0001',
    });
    expect(r.action).toBe('adopt-wallet-smaller');
    expect(r.nextHeldQuantity).toBe('0.0005');
  });

  it('adopts state when state < wallet by more than stepSize (external deposit)', () => {
    const r = reconcileHeldQuantity({
      heldQuantity: '0.0005',
      walletFree: '0.0020',
      walletLocked: '0',
      stepSize: '0.0001',
    });
    expect(r.action).toBe('adopt-state-smaller');
    expect(r.nextHeldQuantity).toBe('0.0005');
  });

  it('counts locked in wallet total', () => {
    const r = reconcileHeldQuantity({
      heldQuantity: '0.0010',
      walletFree: '0.0003',
      walletLocked: '0.0004',
      stepSize: '0.0001',
    });
    expect(r.action).toBe('adopt-wallet-smaller');
    expect(r.nextHeldQuantity).toBe('0.0007');
  });

  it('seeds heldQuantity from wallet when state is null and wallet >= stepSize', () => {
    const r = reconcileHeldQuantity({
      heldQuantity: null,
      walletFree: '0.0050',
      walletLocked: '0',
      stepSize: '0.0001',
    });
    expect(r.action).toBe('seed-from-wallet');
    expect(r.nextHeldQuantity).toBe('0.005');
  });

  it('no-ops when state null and wallet < stepSize (dust)', () => {
    const r = reconcileHeldQuantity({
      heldQuantity: null,
      walletFree: '0.00005',
      walletLocked: '0',
      stepSize: '0.0001',
    });
    expect(r.action).toBe('no-op');
    expect(r.nextHeldQuantity).toBeNull();
  });

  it('treats a corrupt heldQuantity string as a re-seed from wallet', () => {
    const r = reconcileHeldQuantity({
      heldQuantity: 'not-a-number',
      walletFree: '0.0010',
      walletLocked: '0',
      stepSize: '0.0001',
    });
    expect(r.action).toBe('seed-from-wallet');
    expect(r.nextHeldQuantity).toBe('0.001');
  });
});

describe('reconcileHeldQuantityForTarget (persist-side wrapper)', () => {
  const buildState = (heldQuantity: string | null) => ({
    schemaVersion: '2.0.0' as const,
    avgEntryPrice: heldQuantity === null ? null : '50000',
    heldQuantity,
    disabledUntilMs: null,
    triggers: { override: null },
    highSinceBuy: null,
    currentGridTradeIndex: null,
    autoTriggerBuyAtMs: null,
  });

  it('writes via mutate when an adjustment is needed; mutator merges onto the live slice', async () => {
    // The wrapper hands the mutator to `deps.mutate`. Production routes
    // that through `mutateSymbolState`, which calls the mutator with the
    // post-migration `live` body. The unit test substitutes a fake that
    // immediately invokes the mutator with the same snapshot, and
    // asserts the projected next body carries the reconciled qty.
    const inputState = buildState('0.0010');
    const mutate = vi.fn(async (_sym, mutator) => {
      void mutator(inputState);
    });
    const deps: ReconcileWalletDeps = {
      logger: fakeLogger,
      mutate,
      position: trailingTradePositionAdapter,
    };
    const action = await reconcileHeldQuantityForTarget(deps, {
      userId: 'u1',
      profileId: 'p1',
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      stepSize: '0.0001',
      walletFree: '0.0005',
      walletLocked: '0',
      state: inputState,
    });
    expect(action).toBe('adopt-wallet-smaller');
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toBe('BTCUSDT');
    // Replay the mutator independently to assert its projected body.
    const projected = mutate.mock.calls[0]?.[1](inputState) as {
      heldQuantity: string;
    } | null;
    expect(projected?.heldQuantity).toBe('0.0005');
  });

  it('mutator returns null on a non-object live slice (no write)', async () => {
    // Defensive contract: even though the schema gate above filters the
    // snapshot, `mutateSymbolState` can hand the mutator any shape (e.g.
    // a strategy whose `initialState` returns null until configured).
    const mutate = vi.fn(async (_sym, mutator) => {
      // `mutator(null)` must yield null, which the production helper
      // skips, asserts the wrapper does not blindly spread a non-object.
      expect(mutator(null)).toBeNull();
      expect(mutator('not-an-object')).toBeNull();
    });
    const deps: ReconcileWalletDeps = {
      logger: fakeLogger,
      mutate,
      position: trailingTradePositionAdapter,
    };
    await reconcileHeldQuantityForTarget(deps, {
      userId: 'u1',
      profileId: 'p1',
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      stepSize: '0.0001',
      walletFree: '0.0005',
      walletLocked: '0',
      state: buildState('0.0010'),
    });
  });

  it('skips mutate on a no-op outcome', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);
    const deps: ReconcileWalletDeps = {
      logger: fakeLogger,
      mutate,
      position: trailingTradePositionAdapter,
    };
    const action = await reconcileHeldQuantityForTarget(deps, {
      userId: 'u1',
      profileId: 'p1',
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      stepSize: '0.0001',
      walletFree: '0.0010',
      walletLocked: '0',
      state: buildState('0.0010'),
    });
    expect(action).toBe('no-op');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('defers an un-migrated 1.0.0 state row to the next boot after migration', async () => {
    const mutate = vi.fn();
    const info = vi.fn();
    const deps: ReconcileWalletDeps = {
      logger: { ...fakeLogger, info } as unknown as Logger,
      mutate,
      position: trailingTradePositionAdapter,
    };
    const action = await reconcileHeldQuantityForTarget(deps, {
      userId: 'u1',
      profileId: 'p1',
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      stepSize: '0.0001',
      walletFree: '0.5',
      walletLocked: '0',
      state: {
        schemaVersion: '1.0.0',
        avgEntryPrice: '50000',
      },
    });
    expect(action).toBe('skip-schema-version');
    expect(mutate).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalled();
  });

  it('logs and skips a non-object state row', async () => {
    const mutate = vi.fn();
    const warn = vi.fn();
    const deps: ReconcileWalletDeps = {
      logger: { ...fakeLogger, warn } as unknown as Logger,
      mutate,
      position: trailingTradePositionAdapter,
    };
    const action = await reconcileHeldQuantityForTarget(deps, {
      userId: 'u1',
      profileId: 'p1',
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      stepSize: '0.0001',
      walletFree: '0',
      walletLocked: '0',
      state: 'not-an-object' as unknown,
    });
    expect(action).toBe('no-op');
    expect(mutate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('defers a current-schema body whose position field is malformed (readPosition null)', async () => {
    // After the capability refactor the strategy's position adapter owns
    // field-shape validation: a 2.0.0 body with a non-string/non-null
    // heldQuantity reads back as `null` from readPosition, so the worker
    // defers the row (skip-schema-version) instead of acting on garbage.
    // The malformed-shape detail itself is asserted in the TT adapter's
    // own tests; here we only lock the worker's deferral behaviour.
    const mutate = vi.fn();
    const info = vi.fn();
    const deps: ReconcileWalletDeps = {
      logger: { ...fakeLogger, info } as unknown as Logger,
      mutate,
      position: trailingTradePositionAdapter,
    };
    const action = await reconcileHeldQuantityForTarget(deps, {
      userId: 'u1',
      profileId: 'p1',
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      stepSize: '0.0001',
      walletFree: '0.001',
      walletLocked: '0',
      state: { schemaVersion: '2.0.0', heldQuantity: 42 } as unknown,
    });
    expect(action).toBe('skip-schema-version');
    expect(mutate).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });
});

describe('runHeldQuantityReconciliation (orchestrator wiring — #262 prune)', () => {
  const reset = (): void => {
    repoMocks.profileFindById.mockReset();
    repoMocks.avgEntryPricesFindBySymbol.mockReset();
    repoMocks.avgEntryPricesRemove.mockReset();
    repoMocks.avgEntryPricesUpsert.mockReset();
    repoMocks.symbolStatesFindBySymbol.mockReset();
    // Default: no per-symbol reserve. Tests that exercise a reserve override this.
    repoMocks.profileSymbolsListForProfile.mockReset();
    repoMocks.profileSymbolsListForProfile.mockResolvedValue([]);
    // Default account mode is live; the testnet-keyspace test overrides to 'test'.
    repoMocks.binanceModeById.mockReset();
    repoMocks.binanceModeById.mockResolvedValue('live');
  };

  const makeRedis = (symbolInfo: Record<string, unknown>): Redis =>
    ({
      get: vi.fn(async (key: string) => {
        if (key === buildSymbolInfoKey('BTCUSDT')) {
          return JSON.stringify(symbolInfo);
        }
        return null;
      }),
    }) as unknown as Redis;

  // In-memory redis stub satisfying the subset `mutateSymbolState`
  // consumes (get/set/del). The fill-adopter and tick-handler share
  // the same surface; matching them here keeps the orchestrator test
  // running through the real `mutateSymbolState` code path instead of
  // bypassing it.
  const stubRedis = () => {
    const store = new Map<string, string>();
    return {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
        return 'OK';
      }),
      del: vi.fn(async (k: string) => {
        store.delete(k);
        return 1;
      }),
    } as unknown as Redis;
  };

  const stubSymbolStateDeps = (strategy = { name: 'trailing-trade', version: '2.0.0' }) => ({
    redis: stubRedis(),
    logger: fakeLogger,
    // The mutator uses `initialState(config)` only when the durable
    // row is missing — every orchestrator test in this file mocks a
    // row, so a stub that throws is enough to flag a regression.
    registry: {
      get: () => ({
        ...strategy,
        initialState: () => ({ schemaVersion: strategy.version }),
      }),
    },
    persistSymbolState: vi.fn(async () => true),
  });

  const makeDeps = (overrides: {
    redis: Redis;
    balances?: { asset: string; free: string; locked: string }[];
    myTrades?: import('@app/binance').MyTradeDto[];
  }): ReconcileOrchestratorDeps => ({
    db: {} as never,
    redis: overrides.redis,
    logger: fakeLogger,
    listActive: () => [
      {
        userId: USER_ID,
        operatorId: USER_ID,
        accountId: ACCOUNT_ID,
        profileId: PROFILE_ID,
        symbols: ['BTCUSDT'],
      } as Parameters<
        typeof runHeldQuantityReconciliation
      >[0]['listActive'] extends () => readonly (infer T)[]
        ? T
        : never,
    ],
    resolveBinance: async () => ({
      getAccount: vi.fn(async () => ({
        balances: overrides.balances ?? [{ asset: 'BTC', free: '0', locked: '0' }],
      })),
      // Cost-basis reconstruction reads the account's trades. Default to an
      // empty history so the common path is a no-op; the held-but-unpriced
      // test overrides this with a single BUY fill.
      getMyTrades: vi.fn(async () => overrides.myTrades ?? []),
    }),
    strategies: stubStrategies({
      name: 'trailing-trade',
      version: '2.0.0',
    }),
    persistMigratedState: vi.fn(async () => undefined),
    symbolStateDeps: stubSymbolStateDeps(),
    chain: createChainByKey(),
  });

  it('subtracts the per-symbol reserve before adoption so a fully-reserved wallet stays flat', async () => {
    // Operator holds exactly their reserve (0.002 BTC reserved, 0.002 in wallet).
    // The reserve is invisible, so the bot must adopt NOTHING: a null state row is
    // left flat (no seed-from-wallet) and the strategy opens a fresh trade on top
    // instead of treating the reserve as a pre-existing position. Without the
    // reserve the same 0.002 wallet would seed-from-wallet, so a 0 count proves
    // the reserve reached the adoption path.
    reset();
    repoMocks.profileSymbolsListForProfile.mockResolvedValue([
      { symbol: 'BTCUSDT', reserveBaseQuantity: '0.00200000' },
    ]);
    const flatBody = {
      schemaVersion: '2.0.0',
      avgEntryPrice: null,
      heldQuantity: null,
      triggers: { override: null },
      highSinceBuy: null,
      currentGridTradeIndex: null,
      autoTriggerBuyAtMs: null,
      disabledUntilMs: null,
    };
    repoMocks.profileFindById.mockResolvedValue({
      binanceMode: 'live',
      state: flatBody,
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      config: {},
    });
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      strategyVersion: '2.0.0',
      state: flatBody,
    });
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
    const redis = makeRedis({ baseAsset: 'BTC', filters: { stepSize: '0.00001000' } });

    const tally = await runHeldQuantityReconciliation(
      makeDeps({ redis, balances: [{ asset: 'BTC', free: '0.00200000', locked: '0' }] }),
    );

    expect(tally.heldQuantity['seed-from-wallet']).toBe(0);
    expect(tally.heldQuantity['no-op']).toBe(1);
    expect(repoMocks.avgEntryPricesUpsert).not.toHaveBeenCalled();
  });

  it('DELETEs the phantom LBP row and tallies prune-phantom-ledger when wallet is empty', async () => {
    // Live repro from issue #262: ledger holds 0.00147 BTC @ $68k from a
    // prior fill; wallet free+locked = 0 because operator sold on Binance
    // outside the bot. Boot orchestrator must:
    // (a) seed heldQuantity from wallet (null/0)
    // (b) call avgEntryPrices.remove('BTCUSDT')
    // (c) report prune-phantom-ledger in the revival tally.
    reset();
    repoMocks.profileFindById.mockResolvedValue({
      binanceMode: 'live',
      state: {
        schemaVersion: '2.0.0',
        avgEntryPrice: null,
        heldQuantity: null,
        triggers: { override: null },
        highSinceBuy: null,
        currentGridTradeIndex: null,
        autoTriggerBuyAtMs: null,
        disabledUntilMs: null,
      },
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      config: {},
    });
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      strategyVersion: '2.0.0',
      state: {
        schemaVersion: '2.0.0',
        avgEntryPrice: null,
        heldQuantity: null,
        triggers: { override: null },
        highSinceBuy: null,
        currentGridTradeIndex: null,
        autoTriggerBuyAtMs: null,
        disabledUntilMs: null,
      },
    });
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
      avgEntryPrice: '68000',
      quantity: '0.001470590000000000',
    });
    const redis = makeRedis({ baseAsset: 'BTC', filters: { stepSize: '0.00001000' } });

    const tally = await runHeldQuantityReconciliation(makeDeps({ redis }));

    expect(repoMocks.avgEntryPricesRemove).toHaveBeenCalledOnce();
    expect(repoMocks.avgEntryPricesRemove).toHaveBeenCalledWith('BTCUSDT');
    expect(tally.avgEntryPriceRevival['prune-phantom-ledger']).toBe(1);
    expect(tally.avgEntryPriceRevival['revive-from-ledger']).toBe(0);
  });

  it('reconstructs cost basis from myTrades and seeds a priced body for a held-but-unpriced adopt', async () => {
    // A fresh operator orphan-adopt: the wallet holds the coin, but the
    // strategy state has avgEntryPrice null and no avg_entry_prices ledger
    // row exists yet. ensureCostBasisFromTrades must reconstruct the average
    // entry price from myTrades, upsert the ledger, and apply a synthetic
    // buy onto strategy state so the entry gate stops seeing the position as
    // flat. Verified end-to-end through the REAL trailingTradePositionAdapter.
    reset();
    repoMocks.profileFindById.mockResolvedValue({
      binanceMode: 'live',
      state: { schemaVersion: '2.0.0', avgEntryPrice: null, heldQuantity: null },
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      config: {},
    });
    // A current-schema body that prices nothing yet — the held-but-unpriced
    // shape the adopt leaves behind.
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      strategyVersion: '2.0.0',
      state: {
        schemaVersion: '2.0.0',
        avgEntryPrice: null,
        heldQuantity: null,
        triggers: { override: null },
        highSinceBuy: null,
        currentGridTradeIndex: null,
        autoTriggerBuyAtMs: null,
        disabledUntilMs: null,
      },
    });
    // No ledger row yet — the reviver has nothing to restore from.
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);

    // Capture every persisted body so the final state can be read back
    // through the real adapter.
    const persistedSymbolStates: { symbol: string; state: unknown }[] = [];
    const symbolStateDeps = {
      ...stubSymbolStateDeps(),
      persistSymbolState: vi.fn(async (_scope, symbol: string, state: unknown) => {
        persistedSymbolStates.push({ symbol, state });
        return true;
      }),
    };

    const redis = makeRedis({ baseAsset: 'BTC', filters: { stepSize: '0.00001000' } });
    const deps: ReconcileOrchestratorDeps = {
      ...makeDeps({
        redis,
        // Wallet holds 2 BTC (>= stepSize) — a real position to price.
        balances: [{ asset: 'BTC', free: '2', locked: '0' }],
        // Bought 2 BTC for 200 quote -> avg 100.
        myTrades: [
          {
            id: 1,
            orderId: 1,
            symbol: 'BTCUSDT',
            price: '100',
            qty: '2',
            quoteQty: '200',
            commission: '0',
            commissionAsset: 'USDT',
            time: 1000,
            isBuyer: true,
            isMaker: false,
          },
        ],
      }),
      symbolStateDeps,
    };

    await runHeldQuantityReconciliation(deps);

    // Ledger seeded from the reconstructed cost basis.
    expect(repoMocks.avgEntryPricesUpsert).toHaveBeenCalledWith('BTCUSDT', {
      avgEntryPrice: '100',
      quantity: '2',
    });
    // The persisted symbol-state body carries the priced position. Read it
    // back through the production adapter so the assertion proves the body
    // is shaped the way the entry gate (which also reads via the adapter)
    // expects — not just that some fields were spread.
    const finalWrite = persistedSymbolStates.at(-1);
    expect(finalWrite?.symbol).toBe('BTCUSDT');
    const view = trailingTradePositionAdapter.readPosition(finalWrite?.state);
    expect(view).toEqual({ avgEntryPrice: '100', heldQuantity: '2' });
  });

  it('short-circuits the reviver when reconciler skipped on schemaVersion (#266)', async () => {
    // #266 invariant survives at per-symbol granularity: when the
    // per-symbol reconciler returns 'skip-schema-version' for a given
    // symbol, the orchestrator must not invoke
    // reviveAvgEntryPriceForTarget for that same symbol. That would emit
    // a misleading "schemaVersion not 2.0.0 after migration; investigate"
    // WARN even though migrateProfileIfNeeded already short-circuited
    // (no migration was attempted). Verify:
    //   - avgEntryPrices.findBySymbol is never called (proves the
    //     reviver was skipped entirely, not its WARN suppressed)
    //   - reviveTally['skip-schema-version'] is incremented so the boot
    //     summary line stays honest
    reset();
    repoMocks.profileFindById.mockResolvedValue({
      binanceMode: 'live',
      state: { schemaVersion: '1.0.0' },
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.0',
      config: {},
    });
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      strategyVersion: '1.0.0',
      state: {
        schemaVersion: '1.0.0',
        avgEntryPrice: null,
      },
    });
    const redis = makeRedis({ baseAsset: 'BTC', filters: { stepSize: '0.00001000' } });
    const deps: ReconcileOrchestratorDeps = {
      ...makeDeps({ redis }),
      // Strategy at 1.0.0 with no migrateState — migrateProfileIfNeeded
      // short-circuits, reconcileHeldQuantityForTarget skips on the gate.
      strategies: stubStrategies({ name: 'trailing-trade', version: '1.0.0' }),
    };

    const tally = await runHeldQuantityReconciliation(deps);

    expect(repoMocks.avgEntryPricesFindBySymbol).not.toHaveBeenCalled();
    expect(repoMocks.avgEntryPricesRemove).not.toHaveBeenCalled();
    expect(tally.heldQuantity['skip-schema-version']).toBe(1);
    expect(tally.avgEntryPriceRevival['skip-schema-version']).toBe(1);
    expect(tally.avgEntryPriceRevival['no-op']).toBe(0);
  });

  it('does NOT prune when the wallet backs the ledger row (real position)', async () => {
    reset();
    repoMocks.profileFindById.mockResolvedValue({
      binanceMode: 'live',
      state: { schemaVersion: '2.0.0' },
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      config: {},
    });
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      strategyVersion: '2.0.0',
      state: {
        schemaVersion: '2.0.0',
        avgEntryPrice: '68000',
        heldQuantity: '0.0142',
        triggers: { override: null },
        highSinceBuy: null,
        currentGridTradeIndex: null,
        autoTriggerBuyAtMs: null,
        disabledUntilMs: null,
      },
    });
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
      avgEntryPrice: '68000',
      quantity: '0.0142',
    });
    const redis = makeRedis({ baseAsset: 'BTC', filters: { stepSize: '0.00001000' } });

    const tally = await runHeldQuantityReconciliation(
      makeDeps({
        redis,
        balances: [{ asset: 'BTC', free: '0.0142', locked: '0' }],
      }),
    );

    expect(repoMocks.avgEntryPricesRemove).not.toHaveBeenCalled();
    expect(tally.avgEntryPriceRevival['prune-phantom-ledger']).toBe(0);
  });

  it('serialises the per-symbol body on the chainByKey lock so a boot-window fill cannot interleave (#294)', async () => {
    // version-aware-mutate's contract: callers MUST hold the
    // `(profileId, symbol)` chain lock before mutating. A user-stream
    // executionReport can drive fillAdopter.adopt on the same slice
    // during the boot window. This test holds that fill mid-flight on the
    // shared chain, lets the reconciler run far enough to reach its write,
    // and asserts the reconcile write lands AFTER the fill — proving the
    // reconciler queues behind the fill rather than interleaving. Under
    // the pre-fix bare-call path the reconcile write fired immediately
    // (before the fill released) and this assertion fails.
    reset();
    repoMocks.profileFindById.mockResolvedValue({
      binanceMode: 'live',
      state: { schemaVersion: '2.0.0' },
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      config: {},
    });
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      strategyVersion: '2.0.0',
      state: { schemaVersion: '2.0.0', heldQuantity: null },
    });
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
    const redis = makeRedis({ baseAsset: 'BTC', filters: { stepSize: '0.00001000' } });

    const events: string[] = [];
    const baseChain = createChainByKey();
    const runSpy = vi.fn(baseChain.run);
    const chain = { run: runSpy, size: baseChain.size };
    const chainKey = `${PROFILE_ID as unknown as string}:BTCUSDT`;

    // A fill grabs the (profile, symbol) chain key first and is held
    // mid-flight until released below.
    let releaseFill!: () => void;
    const fillGate = new Promise<void>((resolve) => {
      releaseFill = resolve;
    });
    const fillPromise = chain.run(chainKey, async () => {
      await fillGate;
      events.push('fill-write');
    });

    const symbolStateDeps = {
      ...stubSymbolStateDeps(),
      persistSymbolState: vi.fn(async () => {
        events.push('reconcile-write');
        return true;
      }),
    };
    const deps: ReconcileOrchestratorDeps = {
      ...makeDeps({ redis, balances: [{ asset: 'BTC', free: '0.0142', locked: '0' }] }),
      chain,
      symbolStateDeps,
    };

    const reconcilePromise = runHeldQuantityReconciliation(deps);
    // Give the reconciler ample time to reach its write. Blocked behind
    // the held fill on the same key, it cannot persist until released.
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseFill();
    await Promise.all([fillPromise, reconcilePromise]);

    expect(events).toEqual(['fill-write', 'reconcile-write']);
    expect(symbolStateDeps.persistSymbolState).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith(chainKey, expect.any(Function));
  });

  it('reads the testnet symbol-info keyspace for a test-mode profile (not production stepSize)', async () => {
    // #582: a test-mode profile must round the adopted wallet quantity against
    // TESTNET stepSize. Serve the symbol-info ONLY under the test keyspace and
    // leave the live key empty: had the reconciler read the live key (the bug)
    // it would find nothing and skip; reading the test key seeds the position.
    reset();
    // Test-mode account: mode resolves via repo.accounts.binanceModeById.
    repoMocks.binanceModeById.mockResolvedValue('test');
    repoMocks.profileFindById.mockResolvedValue({
      state: { schemaVersion: '2.0.0', avgEntryPrice: null, heldQuantity: null },
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      config: {},
    });
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      strategyVersion: '2.0.0',
      state: { schemaVersion: '2.0.0', avgEntryPrice: null, heldQuantity: null },
    });
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
    const testKey = buildSymbolInfoKey('BTCUSDT', 'test');
    const redis = {
      get: vi.fn(async (key: string) =>
        key === testKey
          ? JSON.stringify({ baseAsset: 'BTC', filters: { stepSize: '0.00001000' } })
          : null,
      ),
    } as unknown as Redis;
    const symbolStateDeps = {
      ...stubSymbolStateDeps(),
      persistSymbolState: vi.fn(async () => true),
    };
    const deps: ReconcileOrchestratorDeps = {
      ...makeDeps({ redis, balances: [{ asset: 'BTC', free: '0.0142', locked: '0' }] }),
      symbolStateDeps,
    };

    await runHeldQuantityReconciliation(deps);

    // Read the testnet key (proves mode threading), never the live key, and seeded.
    expect(redis.get).toHaveBeenCalledWith(testKey);
    expect(redis.get).not.toHaveBeenCalledWith(buildSymbolInfoKey('BTCUSDT'));
    expect(symbolStateDeps.persistSymbolState).toHaveBeenCalled();
  });

  it('narrows a pass to one (profile, symbol) and pays no IO for the rest', async () => {
    // The `symbol-reconcile` job knows exactly which slice drifted. A fleet-wide
    // sweep would pay a getAccount per profile and a symbol-info read per symbol
    // to converge state nobody suspects — on the account's Binance weight budget,
    // on every -2011 fill. Prove the filter runs BEFORE the IO, not after.
    reset();
    repoMocks.profileFindById.mockResolvedValue({
      binanceMode: 'live',
      state: { schemaVersion: '2.0.0' },
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      config: {},
    });
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      strategyVersion: '2.0.0',
      state: { schemaVersion: '2.0.0', heldQuantity: null },
    });
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
    const redis = makeRedis({ baseAsset: 'BTC', filters: { stepSize: '0.00001000' } });

    const base = makeDeps({ redis, balances: [{ asset: 'BTC', free: '0', locked: '0' }] });
    const resolveBinance = vi.fn(base.resolveBinance);
    const active = base.listActive()[0]!;
    const deps: ReconcileOrchestratorDeps = {
      ...base,
      resolveBinance,
      listActive: () => [
        { ...active, symbols: ['BTCUSDT', 'ETHUSDT'] },
        { ...active, profileId: 'p2' as unknown as ProfileId },
      ],
    };

    await runHeldQuantityReconciliation(deps, {
      only: { profileId: PROFILE_ID, symbols: ['BTCUSDT'] },
    });

    // The sibling profile never even resolved a Binance client.
    expect(resolveBinance).toHaveBeenCalledTimes(1);
    // And within the target profile, only the named symbol was looked at.
    expect(redis.get).toHaveBeenCalledTimes(1);
    expect(redis.get).toHaveBeenCalledWith(buildSymbolInfoKey('BTCUSDT'));
  });
});

describe('migrateProfileIfNeeded (orchestrator migration step)', () => {
  it('runs the strategy migrate path and persists state+version atomically when the schema is behind', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const migrate = vi.fn(({ state }: { state: unknown }) => ({
      ...(state as Record<string, unknown>),
      schemaVersion: '1.1.0',
      heldQuantity: null,
    }));
    const strategy: MigrationStrategy = {
      name: 'trailing-trade',
      version: '1.1.0',
      migrateState: migrate,
    };
    const next = await migrateProfileIfNeeded({
      logger: fakeLogger,
      strategies: stubStrategies(strategy),
      persistMigratedState: persist,
      scope: SCOPE,
      userId: USER_ID,
      profileId: PROFILE_ID,
      profile: {
        strategyName: 'trailing-trade',
        strategyVersion: '1.0.0',
        state: { schemaVersion: '1.0.0', avgEntryPrice: '50000' },
      },
    });
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ schemaVersion: '1.1.0', heldQuantity: null }),
      '1.1.0',
    );
    expect(next.strategyVersion).toBe('1.1.0');
    expect((next.state as { schemaVersion: string }).schemaVersion).toBe('1.1.0');
  });

  it('walks multi-hop migrations until the target version is reached', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const migrate = vi.fn(({ fromVersion, state }: { fromVersion: string; state: unknown }) => {
      const map: Record<string, string> = { '1.0.0': '1.1.0', '1.1.0': '1.2.0' };
      return {
        ...(state as Record<string, unknown>),
        schemaVersion: map[fromVersion] ?? fromVersion,
      };
    });
    const strategy: MigrationStrategy = {
      name: 'trailing-trade',
      version: '1.2.0',
      migrateState: migrate,
    };
    const next = await migrateProfileIfNeeded({
      logger: fakeLogger,
      strategies: stubStrategies(strategy),
      persistMigratedState: persist,
      scope: SCOPE,
      userId: USER_ID,
      profileId: PROFILE_ID,
      profile: {
        strategyName: 'trailing-trade',
        strategyVersion: '1.0.0',
        state: { schemaVersion: '1.0.0' },
      },
    });
    expect(migrate).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ schemaVersion: '1.2.0' }),
      '1.2.0',
    );
    expect(next.strategyVersion).toBe('1.2.0');
  });

  it('is a no-op when the persisted strategyVersion already matches the registered strategy', async () => {
    const persist = vi.fn();
    const migrate = vi.fn();
    const strategy: MigrationStrategy = {
      name: 'trailing-trade',
      version: '1.1.0',
      migrateState: migrate,
    };
    const original = {
      strategyName: 'trailing-trade',
      strategyVersion: '1.1.0',
      state: { schemaVersion: '1.1.0', heldQuantity: '0.5' },
    };
    const next = await migrateProfileIfNeeded({
      logger: fakeLogger,
      strategies: stubStrategies(strategy),
      persistMigratedState: persist,
      scope: SCOPE,
      userId: USER_ID,
      profileId: PROFILE_ID,
      profile: original,
    });
    expect(migrate).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(next).toBe(original);
  });

  it('leaves the profile untouched when no strategy is registered for the name', async () => {
    const persist = vi.fn();
    const original = {
      strategyName: 'unknown-plugin',
      strategyVersion: '0.1.0',
      state: { schemaVersion: '0.1.0' },
    };
    const next = await migrateProfileIfNeeded({
      logger: fakeLogger,
      strategies: stubStrategies(null),
      persistMigratedState: persist,
      scope: SCOPE,
      userId: USER_ID,
      profileId: PROFILE_ID,
      profile: original,
    });
    expect(persist).not.toHaveBeenCalled();
    expect(next).toBe(original);
  });

  it('catches migrate throws, logs, and returns the original profile so the reconciler skips on the schema gate', async () => {
    const warn = vi.fn();
    const persist = vi.fn();
    const migrate = vi.fn(() => {
      throw new Error('boom');
    });
    const strategy: MigrationStrategy = {
      name: 'trailing-trade',
      version: '1.1.0',
      migrateState: migrate,
    };
    const original = {
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.0',
      state: { schemaVersion: '1.0.0' },
    };
    const next = await migrateProfileIfNeeded({
      logger: { ...fakeLogger, warn } as unknown as Logger,
      strategies: stubStrategies(strategy),
      persistMigratedState: persist,
      scope: SCOPE,
      userId: USER_ID,
      profileId: PROFILE_ID,
      profile: original,
    });
    expect(persist).not.toHaveBeenCalled();
    expect(next).toBe(original);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('migrates when profiles.strategy_version claims at-version but state.schemaVersion is behind (GitLab #264 divergence)', async () => {
    const warn = vi.fn();
    const persist = vi.fn().mockResolvedValue(undefined);
    const migrate = vi.fn(({ state }: { state: unknown }) => ({
      ...(state as Record<string, unknown>),
      schemaVersion: '1.1.0',
      heldQuantity: null,
    }));
    const strategy: MigrationStrategy = {
      name: 'trailing-trade',
      version: '1.1.0',
      migrateState: migrate,
    };
    const next = await migrateProfileIfNeeded({
      logger: { ...fakeLogger, warn } as unknown as Logger,
      strategies: stubStrategies(strategy),
      persistMigratedState: persist,
      scope: SCOPE,
      userId: USER_ID,
      profileId: PROFILE_ID,
      profile: {
        strategyName: 'trailing-trade',
        strategyVersion: '1.1.0',
        state: { schemaVersion: '1.0.0', avgEntryPrice: '2083.6' },
      },
    });
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledWith({
      fromVersion: '1.0.0',
      state: expect.objectContaining({ schemaVersion: '1.0.0' }),
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ schemaVersion: '1.1.0', heldQuantity: null }),
      '1.1.0',
    );
    expect((next.state as { schemaVersion: string }).schemaVersion).toBe('1.1.0');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        suppliedFromVersion: '1.1.0',
        stateSchemaVersion: '1.0.0',
      }),
      expect.stringContaining('state.schemaVersion diverges from supplied fromVersion'),
    );
  });

  it('heals column drift when state body is already at-version but strategy_version column lags (GitLab #264 inverse)', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const migrate = vi.fn();
    const strategy: MigrationStrategy = {
      name: 'trailing-trade',
      version: '1.1.0',
      migrateState: migrate,
    };
    const body = { schemaVersion: '1.1.0', heldQuantity: '0.5' };
    const next = await migrateProfileIfNeeded({
      logger: fakeLogger,
      strategies: stubStrategies(strategy),
      persistMigratedState: persist,
      scope: SCOPE,
      userId: USER_ID,
      profileId: PROFILE_ID,
      profile: {
        strategyName: 'trailing-trade',
        strategyVersion: '1.0.0',
        state: body,
      },
    });
    expect(migrate).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(SCOPE, body, '1.1.0');
    expect(next.strategyVersion).toBe('1.1.0');
    expect(next.state).toBe(body);
  });

  it('breaks the migration loop and skips persistence when a migrate branch fails to advance the version', async () => {
    const warn = vi.fn();
    const persist = vi.fn();
    const migrate = vi.fn(({ state }: { state: unknown }) => state as Record<string, unknown>);
    const strategy: MigrationStrategy = {
      name: 'trailing-trade',
      version: '1.1.0',
      migrateState: migrate,
    };
    const original = {
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.0',
      state: { schemaVersion: '1.0.0' },
    };
    const next = await migrateProfileIfNeeded({
      logger: { ...fakeLogger, warn } as unknown as Logger,
      strategies: stubStrategies(strategy),
      persistMigratedState: persist,
      scope: SCOPE,
      userId: USER_ID,
      profileId: PROFILE_ID,
      profile: original,
    });
    expect(persist).not.toHaveBeenCalled();
    expect(next).toBe(original);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('reconcileSymbol (per-symbol reconcile + revive unit)', () => {
  const POSITION = trailingTradePositionAdapter;

  // In-memory redis satisfying the get/set/del subset mutateSymbolState
  // consumes, so the unit runs through the real persist path.
  const stubRedis = (): Redis => {
    const store = new Map<string, string>();
    return {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
        return 'OK';
      }),
      del: vi.fn(async (k: string) => {
        store.delete(k);
        return 1;
      }),
    } as unknown as Redis;
  };

  const symbolStateDeps = (): ReconcileOrchestratorDeps['symbolStateDeps'] =>
    ({
      redis: stubRedis(),
      logger: fakeLogger,
      registry: {
        get: () => ({
          name: 'trailing-trade',
          version: '2.0.0',
          initialState: () => ({ schemaVersion: '2.0.0' }),
        }),
      },
      persistSymbolState: vi.fn(async () => true),
    }) as unknown as ReconcileOrchestratorDeps['symbolStateDeps'];

  type Scope = Awaited<ReturnType<typeof import('@app/db').profileRepo>>;
  const makeScope = (
    row: { state: unknown } | null,
    ledger: { avgEntryPrice: string; quantity: string } | null,
  ): { scope: Scope; remove: ReturnType<typeof vi.fn>; ledgerFind: ReturnType<typeof vi.fn> } => {
    const remove = vi.fn(async () => undefined);
    const ledgerFind = vi.fn(async () => ledger);
    const scope = {
      scope: SCOPE,
      profile: { findById: vi.fn() },
      avgEntryPrices: { findBySymbol: ledgerFind, remove },
      symbolStates: { findBySymbol: vi.fn(async () => row) },
    } as unknown as Scope;
    return { scope, remove, ledgerFind };
  };

  const target = (o?: Partial<ReconcileSymbolTarget>): ReconcileSymbolTarget => ({
    userId: USER_ID,
    profileId: PROFILE_ID,
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    stepSize: '0.00001000',
    walletFree: '0',
    walletLocked: '0',
    ...o,
  });

  const ttState = (o: Record<string, unknown>): Record<string, unknown> => ({
    schemaVersion: '2.0.0',
    avgEntryPrice: null,
    heldQuantity: null,
    triggers: { override: null },
    highSinceBuy: null,
    currentGridTradeIndex: null,
    autoTriggerBuyAtMs: null,
    disabledUntilMs: null,
    ...o,
  });

  it('is a no-op on a clean target — wallet matches state, ledger backs the position', async () => {
    const { scope, remove, ledgerFind } = makeScope(
      { state: ttState({ avgEntryPrice: '68000', heldQuantity: '0.0142' }) },
      { avgEntryPrice: '68000', quantity: '0.0142' },
    );
    const result = await reconcileSymbol(
      { logger: fakeLogger, symbolStateDeps: symbolStateDeps() },
      scope,
      POSITION,
      target({ walletFree: '0.0142', walletLocked: '0' }),
    );
    expect(result.action).toBe('no-op');
    expect(result.reviveAction).toBe('no-op');
    expect(remove).not.toHaveBeenCalled();
    // The reviver runs (ledger is consulted) but finds nothing to revive.
    expect(ledgerFind).toHaveBeenCalledOnce();
  });

  it('reconciles a drifted held-quantity by adopting the smaller wallet value', async () => {
    const { scope } = makeScope(
      { state: ttState({ avgEntryPrice: '68000', heldQuantity: '0.0200' }) },
      { avgEntryPrice: '68000', quantity: '0.0142' },
    );
    const result = await reconcileSymbol(
      { logger: fakeLogger, symbolStateDeps: symbolStateDeps() },
      scope,
      POSITION,
      target({ walletFree: '0.0142', walletLocked: '0' }),
    );
    expect(result.action).toBe('adopt-wallet-smaller');
  });

  it('reconciles but does not revive a schema-skipped target (#266)', async () => {
    // A body at a prior schemaVersion yields a null position view, so the
    // reconciler returns 'skip-schema-version' and the reviver is never
    // consulted (avgEntryPrices.findBySymbol stays uncalled).
    const { scope, ledgerFind } = makeScope(
      { state: { schemaVersion: '1.0.0', avgEntryPrice: null } },
      null,
    );
    const result = await reconcileSymbol(
      { logger: fakeLogger, symbolStateDeps: symbolStateDeps() },
      scope,
      POSITION,
      target(),
    );
    expect(result.action).toBe('skip-schema-version');
    expect(result.reviveAction).toBe('skip-schema-version');
    expect(ledgerFind).not.toHaveBeenCalled();
  });
});

describe('ensureCostBasisFromTrades (cost-basis reconstruction step)', () => {
  const POSITION = trailingTradePositionAdapter;

  const stubRedis = (): Redis => {
    const store = new Map<string, string>();
    return {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
        return 'OK';
      }),
      del: vi.fn(async (k: string) => {
        store.delete(k);
        return 1;
      }),
    } as unknown as Redis;
  };

  const persisted: { symbol: string; state: unknown }[] = [];
  const symbolStateDeps = (): ReconcileOrchestratorDeps['symbolStateDeps'] =>
    ({
      redis: stubRedis(),
      logger: fakeLogger,
      registry: {
        get: () => ({
          name: 'trailing-trade',
          version: '2.0.0',
          initialState: () => POSITION.setHeldQuantity({ schemaVersion: '2.0.0' }, null),
        }),
      },
      persistSymbolState: vi.fn(async (_scope, symbol: string, state: unknown) => {
        persisted.push({ symbol, state });
        return true;
      }),
    }) as unknown as ReconcileOrchestratorDeps['symbolStateDeps'];

  type Scope = Awaited<ReturnType<typeof import('@app/db').profileRepo>>;
  const makeScope = (
    row: { state: unknown } | null,
    ledger: { avgEntryPrice: string; quantity: string } | null,
  ): { scope: Scope; upsert: ReturnType<typeof vi.fn> } => {
    const upsert = vi.fn(async () => undefined);
    const scope = {
      scope: SCOPE,
      profile: {
        findById: vi.fn(async () => ({ strategyName: 'trailing-trade', config: {} })),
      },
      avgEntryPrices: { findBySymbol: vi.fn(async () => ledger), upsert },
      symbolStates: { findBySymbol: vi.fn(async () => row) },
    } as unknown as Scope;
    return { scope, upsert };
  };

  const target = (o?: Partial<ReconcileSymbolTarget>): ReconcileSymbolTarget => ({
    userId: USER_ID,
    profileId: PROFILE_ID,
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    stepSize: '0.00001000',
    walletFree: '2',
    walletLocked: '0',
    ...o,
  });

  const buyFill = (over: Record<string, unknown>): unknown => ({
    id: 1,
    orderId: 1,
    symbol: 'BTCUSDT',
    price: '50',
    qty: '2',
    quoteQty: '100',
    commission: '0',
    commissionAsset: 'USDT',
    time: 1000,
    isBuyer: true,
    isMaker: false,
    ...over,
  });

  const client = (getMyTrades: BinanceAccountClient['getMyTrades']): BinanceAccountClient =>
    ({ getAccount: vi.fn(), getMyTrades }) as unknown as BinanceAccountClient;

  it('reconstructs + upserts + writes state for a held-but-unpriced position (no row, no ledger)', async () => {
    persisted.length = 0;
    const { scope, upsert } = makeScope(null, null);
    const getMyTrades = vi.fn(async () => [buyFill({})]); // 2 @ 50 -> avg 50
    const action = await ensureCostBasisFromTrades(
      { logger: fakeLogger, symbolStateDeps: symbolStateDeps() },
      scope,
      POSITION,
      client(getMyTrades),
      target(),
    );
    expect(action).toBe('reconstructed-from-trades');
    expect(upsert).toHaveBeenCalledWith('BTCUSDT', { avgEntryPrice: '50', quantity: '2' });
    // State written through the persist path with the priced position.
    const last = persisted.at(-1);
    expect(last?.symbol).toBe('BTCUSDT');
    expect(POSITION.readPosition(last?.state)).toMatchObject({
      avgEntryPrice: '50',
      heldQuantity: '2',
    });
  });

  it('skips when the strategy state already has avgEntryPrice', async () => {
    const { scope, upsert } = makeScope(
      { state: { schemaVersion: '2.0.0', avgEntryPrice: '40', heldQuantity: '2' } },
      null,
    );
    const getMyTrades = vi.fn(async () => [buyFill({})]);
    const action = await ensureCostBasisFromTrades(
      { logger: fakeLogger, symbolStateDeps: symbolStateDeps() },
      scope,
      POSITION,
      client(getMyTrades),
      target(),
    );
    expect(action).toBe('no-op');
    expect(getMyTrades).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('seeds the state FROM the ledger row when the profile has no state body yet', async () => {
    // The cost basis is already known, so there is nothing to reconstruct from
    // trades — but the reviver restores a price ONTO a state body, and a profile that
    // has never ticked this symbol has none. That is exactly a disposal's handoff
    // TARGET: it owns the coins and the ledger row, and without this it would read
    // FLAT — arming no protective stop and buying again on the next signal.
    const persisted: { symbol: string; state: unknown }[] = [];
    const deps = {
      logger: fakeLogger,
      symbolStateDeps: {
        ...symbolStateDeps(),
        persistSymbolState: vi.fn(async (_scope: unknown, symbol: string, state: unknown) => {
          persisted.push({ symbol, state });
          return true;
        }),
      },
    } as unknown as Parameters<typeof ensureCostBasisFromTrades>[0];
    const { scope, upsert } = makeScope(null, { avgEntryPrice: '40', quantity: '2' });
    const getMyTrades = vi.fn(async () => [buyFill({})]);

    const action = await ensureCostBasisFromTrades(
      deps,
      scope,
      POSITION,
      client(getMyTrades),
      target(),
    );

    expect(action).toBe('seeded-from-ledger');
    // Nothing to reconstruct and nothing to re-write: the ledger IS the truth here.
    expect(getMyTrades).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(persisted.at(-1)?.state).toMatchObject({ avgEntryPrice: '40', heldQuantity: '2' });
  });

  it('leaves an existing state body alone when a ledger row exists (the reviver owns that)', async () => {
    const { scope, upsert } = makeScope(
      { state: { schemaVersion: '2.0.0', heldQuantity: '2', avgEntryPrice: '40' } },
      { avgEntryPrice: '40', quantity: '2' },
    );
    const getMyTrades = vi.fn(async () => [buyFill({})]);
    const action = await ensureCostBasisFromTrades(
      { logger: fakeLogger, symbolStateDeps: symbolStateDeps() },
      scope,
      POSITION,
      client(getMyTrades),
      target(),
    );
    expect(action).toBe('no-op');
    expect(getMyTrades).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('skips when the wallet holds less than one stepSize', async () => {
    const { scope, upsert } = makeScope(null, null);
    const getMyTrades = vi.fn(async () => [buyFill({})]);
    const action = await ensureCostBasisFromTrades(
      { logger: fakeLogger, symbolStateDeps: symbolStateDeps() },
      scope,
      POSITION,
      client(getMyTrades),
      target({ walletFree: '0.000001', walletLocked: '0', stepSize: '0.0001' }),
    );
    expect(action).toBe('no-op');
    expect(getMyTrades).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('best-effort: getMyTrades throws -> no upsert, no throw, warn logged', async () => {
    const { scope, upsert } = makeScope(null, null);
    const getMyTrades = vi.fn(async () => {
      throw new Error('binance down');
    });
    const action = await ensureCostBasisFromTrades(
      { logger: fakeLogger, symbolStateDeps: symbolStateDeps() },
      scope,
      POSITION,
      client(getMyTrades),
      target(),
    );
    expect(action).toBe('no-op');
    expect(upsert).not.toHaveBeenCalled();
    expect(fakeLogger.warn).toHaveBeenCalled();
  });

  it('skips a held position whose trade history fully nets out (open qty 0 -> null)', async () => {
    const { scope, upsert } = makeScope(null, null);
    // Bought 2, sold 2 -> openPositionFromFills returns null.
    const getMyTrades = vi.fn(async () => [
      buyFill({ id: 1, time: 1000, qty: '2', quoteQty: '100', isBuyer: true }),
      buyFill({ id: 2, time: 2000, qty: '2', quoteQty: '120', isBuyer: false }),
    ]);
    const action = await ensureCostBasisFromTrades(
      { logger: fakeLogger, symbolStateDeps: symbolStateDeps() },
      scope,
      POSITION,
      client(getMyTrades),
      target(),
    );
    expect(action).toBe('no-op');
    expect(upsert).not.toHaveBeenCalled();
  });
});
