import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { ProfileScope } from '@app/db';
import { Decimal } from '@app/money';

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
  readTickerPrice,
  reconcileHeldQuantityForTarget,
  reconcileSymbol,
  resolveWalletFields,
  runHeldQuantityReconciliation,
  type BinanceAccountClient,
  type MigrationStrategy,
  type ReconcileOrchestratorDeps,
  type ReconcileSymbolTarget,
  type ReconcileWalletDeps,
  type StrategyLookup,
} from '../../src/boot/reconcile-held-quantity.js';
import type { MyTradeDto, PriceTickerDto } from '@app/binance';
import { GLOBAL_KEYS } from '@app/db';
import { buildSymbolInfoKey } from '../../src/executor/redis-namespace.js';
import { createChainByKey, type ChainByKey } from '../../src/lib/chain-by-key.js';
import type { MetricsSink } from '../../src/metrics/catalog.js';
import { TTStateSchema, trailingTradePositionAdapter } from '@app/strategy-trailing-trade';

// These cases assert reconcile ACTIONS, not counters. The sink is required by the dep bag so a construction site cannot forget it, and a no-op satisfies that requirement without pinning anything here; the counter assertions live in the value-bound suite.
const noopMetrics = (): MetricsSink => ({ record: () => undefined, forget: () => undefined });

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

/** The `state` a persister hands back is `unknown` by contract. The position adapter is the only thing that can read that body, so its own parameter type is where a test narrows it. */
type TTStateBody = Parameters<typeof trailingTradePositionAdapter.readPosition>[0];

const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

describe('reconcileHeldQuantity (pure core)', () => {
  it('no-ops when state and wallet agree within stepSize', () => {
    const r = reconcileHeldQuantity({
      minNotional: null,
      referencePrice: null,
      heldQuantity: '0.0010',
      walletFree: '0.0010',
      walletLocked: '0',
      unreservedWalletTotal: '0.001',
      stepSize: '0.0001',
    });
    expect(r.action).toBe('no-op');
    expect(r.nextHeldQuantity).toBe('0.0010');
  });

  it('does NOT seed an untracked balance worth less than one minimum order', () => {
    // The live ENAUSDT strand. Without this the fill fold flattens the position and the very next reconcile pass reads the same untradeable 0.01184 ENA off the wallet and re-creates it, so the symbol never leaves the dashboard.
    const r = reconcileHeldQuantity({
      heldQuantity: null,
      walletFree: '0.01184',
      walletLocked: '0',
      unreservedWalletTotal: '0.01184',
      stepSize: '0.01',
      minNotional: '5',
      referencePrice: '0.1094',
    });
    expect(r.action).toBe('no-op');
    expect(r.nextHeldQuantity).toBeNull();
  });

  it('still seeds an untracked balance worth at least one minimum order', () => {
    const r = reconcileHeldQuantity({
      heldQuantity: null,
      walletFree: '421.30',
      walletLocked: '0',
      unreservedWalletTotal: '421.3',
      stepSize: '0.01',
      minNotional: '5',
      referencePrice: '0.1094',
    });
    expect(r.action).toBe('seed-from-wallet');
    expect(r.nextHeldQuantity).toBe('421.3');
  });

  it('seeds a sub-notional balance when no reference price is available', () => {
    // Guessing a price could orphan a real holding, so an absent ticker restores the increment-only behaviour rather than assuming dust.
    const r = reconcileHeldQuantity({
      heldQuantity: null,
      walletFree: '0.01184',
      walletLocked: '0',
      unreservedWalletTotal: '0.01184',
      stepSize: '0.01',
      minNotional: '5',
      referencePrice: null,
    });
    expect(r.action).toBe('seed-from-wallet');
  });

  it('does NOT flatten a deliberate partial remainder that merely sits below minNotional', () => {
    // `rebalance` trims to a target weight on purpose; 4 of a prior 12 is a holding, not residue, even though it is under the 5 floor.
    const r = reconcileHeldQuantity({
      heldQuantity: '12',
      walletFree: '4',
      walletLocked: '0',
      unreservedWalletTotal: '4',
      stepSize: '0.01',
      minNotional: '5',
      referencePrice: '1',
    });
    expect(r.action).toBe('adopt-wallet-smaller');
    expect(r.nextHeldQuantity).toBe('4');
  });

  it('keeps adopting a crumb when no reference price is available (value bound skipped)', () => {
    // Guessing a price could flatten a real position, so an absent ticker restores the increment-only behaviour rather than assuming dust.
    const r = reconcileHeldQuantity({
      heldQuantity: '420.88184',
      walletFree: '0.01184',
      walletLocked: '0',
      unreservedWalletTotal: '0.01184',
      stepSize: '0.01',
      minNotional: '5',
      referencePrice: null,
    });
    expect(r.action).toBe('adopt-wallet-smaller');
    expect(r.nextHeldQuantity).toBe('0.01184');
  });

  it('flattens rather than adopting a wallet crumb below minNotional', () => {
    // Deliberately NOT the converged flatten. The tracked 420.88 is worth USD 46, so the CLAIM is not valueless and the destructive branch stands down — which is what protects a position whose BUY filled after the once-per-profile `getAccount` snapshot was taken. This path converges the quantity through `adopt-wallet-smaller` and `isUnsellableDust`, which nulls the quantity while leaving the cost-basis row alone for the prune to judge.
    const r = reconcileHeldQuantity({
      heldQuantity: '420.88184',
      walletFree: '0.01184',
      walletLocked: '0',
      unreservedWalletTotal: '0.01184',
      stepSize: '0.01',
      minNotional: '5',
      referencePrice: '0.1094',
    });
    expect(r.action).toBe('adopt-wallet-smaller');
    expect(r.nextHeldQuantity).toBeNull();
  });

  it('flattens a converged strand where the claim is as valueless as the wallet', () => {
    // The live shape once the strand has converged: held and wallet agree exactly, both worth USD 0.0013 against a USD 5 floor. This is the case the stale-snapshot guard must still let through, so it is pinned separately from the drifted case above.
    const r = reconcileHeldQuantity({
      heldQuantity: '0.01184',
      walletFree: '0.01184',
      walletLocked: '0',
      unreservedWalletTotal: '0.01184',
      stepSize: '0.01',
      minNotional: '5',
      referencePrice: '0.1094',
    });
    expect(r.action).toBe('flatten-sub-notional-dust');
    expect(r.nextHeldQuantity).toBeNull();
  });

  it('flattens a corrupt heldQuantity over a valueless wallet (a corrupt claim is no claim)', () => {
    const r = reconcileHeldQuantity({
      heldQuantity: 'not-a-number',
      walletFree: '0.01184',
      walletLocked: '0',
      unreservedWalletTotal: '0.01184',
      stepSize: '0.01',
      minNotional: '5',
      referencePrice: '0.1094',
    });
    expect(r.action).toBe('flatten-sub-notional-dust');
    expect(r.nextHeldQuantity).toBeNull();
  });

  it('does not flatten a freshly-bought position against a stale dust snapshot', () => {
    // The race this MR would otherwise introduce: `getAccount` is read once per profile, outside the per-symbol loop, so by the Nth symbol the balance is several REST round trips old. A BUY that filled in that window leaves a fresh 420-ENA claim over a stale dust wallet. Deleting its cost basis would be strictly worse than the pre-MR behaviour, so the claim's own value has to clear the bar too.
    const r = reconcileHeldQuantity({
      heldQuantity: '420',
      walletFree: '0.01184',
      walletLocked: '0',
      unreservedWalletTotal: '0.01184',
      stepSize: '0.01',
      minNotional: '5',
      referencePrice: '0.1158',
    });
    expect(r.action).toBe('adopt-wallet-smaller');
  });

  it('seeds a reserved holding whose tradeable surplus alone is sub-notional', () => {
    // The operator reserves 45 of their 50 ENA, so `walletFree` carries the 5 the strategy may trade, worth USD 0.579. The SEED bar is the full USD 5 floor, unscaled, so those two numbers straddle it and this case discriminates: mis-wire the bound to the surplus and 0.579 < 5 refuses to seed a position backed by USD 5.79 of real coins. The converged FLATTEN cannot be pinned this way — its bar is the 1%-scaled USD 0.05, which 0.579 clears by more than 10x under either wiring — so the deep-reserve cases below carry that half.
    const r = reconcileHeldQuantity({
      heldQuantity: null,
      walletFree: '5',
      walletLocked: '0',
      stepSize: '0.01',
      minNotional: '5',
      referencePrice: '0.1158',
      unreservedWalletTotal: '50',
    });
    expect(r.action).toBe('seed-from-wallet');
    expect(r.nextHeldQuantity).toBe('5');
  });

  it('does not flatten a position whose whole balance is locked in a resting SELL', () => {
    // `walletLocked` counts toward the holding: a position with its exit resting on the book reads `free: 0`, and treating that as an empty wallet would delete the cost basis of the very position the order is trying to close.
    const r = reconcileHeldQuantity({
      heldQuantity: '50',
      walletFree: '0',
      walletLocked: '50',
      stepSize: '0.01',
      minNotional: '5',
      referencePrice: '0.1158',
      unreservedWalletTotal: '50',
    });
    expect(r.action).toBe('no-op');
    expect(r.nextHeldQuantity).toBe('50');
  });

  // The next two cases sit in the DEEP-RESERVE BAND, the only band where threading the pre-reserve total and quietly reading the reserve-adjusted balance disagree. The operator holds 50 ENA worth USD 5.79 and reserves 49.7 of it, leaving 0.3 tradeable and worth USD 0.03474 — under the scaled floor of USD 0.05, so the wrong wiring destroys a real position while the right one keeps it. Every shallower reserve clears that floor by more than 10x and reads identically either way, which is why a case built on a small reserve pins nothing.
  //
  // Note the direction these run in. A DROPPED field disarms the bound, so it can only ever be caught by a case that demands a DELETE; a MIS-WIRED field substitutes a smaller number, so it can only be caught by a case that forbids one. Both detectors are needed and neither substitutes for the other.
  it('seeds a deeply-reserved holding the strategy may only trade a sliver of', () => {
    const r = reconcileHeldQuantity({
      heldQuantity: null,
      walletFree: '0.3',
      walletLocked: '0',
      stepSize: '0.01',
      minNotional: '5',
      referencePrice: '0.1158',
      unreservedWalletTotal: '50',
    });
    expect(r.action).toBe('seed-from-wallet');
    expect(r.nextHeldQuantity).toBe('0.3');
  });

  it('does not flatten a deeply-reserved position whose tradeable sliver is below the scaled floor', () => {
    const r = reconcileHeldQuantity({
      heldQuantity: '0.3',
      walletFree: '0.3',
      walletLocked: '0',
      stepSize: '0.01',
      minNotional: '5',
      referencePrice: '0.1158',
      unreservedWalletTotal: '50',
    });
    expect(r.action).toBe('no-op');
    expect(r.nextHeldQuantity).toBe('0.3');
  });

  it('no-ops when diff is exactly stepSize (boundary)', () => {
    const r = reconcileHeldQuantity({
      minNotional: null,
      referencePrice: null,
      heldQuantity: '0.0011',
      walletFree: '0.0010',
      walletLocked: '0',
      unreservedWalletTotal: '0.001',
      stepSize: '0.0001',
    });
    expect(r.action).toBe('no-op');
  });

  it('adopts wallet when wallet < heldQuantity by more than stepSize (operator withdrew)', () => {
    const r = reconcileHeldQuantity({
      minNotional: null,
      referencePrice: null,
      heldQuantity: '0.0010',
      walletFree: '0.0005',
      walletLocked: '0',
      unreservedWalletTotal: '0.0005',
      stepSize: '0.0001',
    });
    expect(r.action).toBe('adopt-wallet-smaller');
    expect(r.nextHeldQuantity).toBe('0.0005');
  });

  it('adopts state when state < wallet by more than stepSize (external deposit)', () => {
    const r = reconcileHeldQuantity({
      minNotional: null,
      referencePrice: null,
      heldQuantity: '0.0005',
      walletFree: '0.0020',
      walletLocked: '0',
      unreservedWalletTotal: '0.002',
      stepSize: '0.0001',
    });
    expect(r.action).toBe('adopt-state-smaller');
    expect(r.nextHeldQuantity).toBe('0.0005');
  });

  it('counts locked in wallet total', () => {
    const r = reconcileHeldQuantity({
      minNotional: null,
      referencePrice: null,
      heldQuantity: '0.0010',
      walletFree: '0.0003',
      walletLocked: '0.0004',
      unreservedWalletTotal: '0.0007',
      stepSize: '0.0001',
    });
    expect(r.action).toBe('adopt-wallet-smaller');
    expect(r.nextHeldQuantity).toBe('0.0007');
  });

  it('seeds heldQuantity from wallet when state is null and wallet >= stepSize', () => {
    const r = reconcileHeldQuantity({
      minNotional: null,
      referencePrice: null,
      heldQuantity: null,
      walletFree: '0.0050',
      walletLocked: '0',
      unreservedWalletTotal: '0.005',
      stepSize: '0.0001',
    });
    expect(r.action).toBe('seed-from-wallet');
    expect(r.nextHeldQuantity).toBe('0.005');
  });

  it('no-ops when state null and wallet < stepSize (dust)', () => {
    const r = reconcileHeldQuantity({
      minNotional: null,
      referencePrice: null,
      heldQuantity: null,
      walletFree: '0.00005',
      walletLocked: '0',
      unreservedWalletTotal: '0.00005',
      stepSize: '0.0001',
    });
    expect(r.action).toBe('no-op');
    expect(r.nextHeldQuantity).toBeNull();
  });

  it('treats a corrupt heldQuantity string as a re-seed from wallet', () => {
    const r = reconcileHeldQuantity({
      minNotional: null,
      referencePrice: null,
      heldQuantity: 'not-a-number',
      walletFree: '0.0010',
      walletLocked: '0',
      unreservedWalletTotal: '0.001',
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
      removeLedgerRow: vi.fn(async () => undefined),
    };
    const action = await reconcileHeldQuantityForTarget(deps, {
      minNotional: null,
      referencePrice: null,
      unreservedWalletTotal: null,
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

  it('flattens sub-notional dust with the fill-adopter full clear and drops the ledger row', async () => {
    // `setHeldQuantity(null)` would leave `avgEntryPrice` set, and a body holding a cost basis with no quantity is the shape the cost-basis adoption no-ops on forever. The flatten therefore takes `applyFill({kind:'empty'})`, the one primitive that empties both, and deletes the ledger row so the next boot revive cannot rehydrate what was just erased.
    const inputState = buildState('0.01184');
    const projections: unknown[] = [];
    const mutate = vi.fn(async (_sym, mutator) => {
      projections.push(mutator(inputState));
    });
    const removeLedgerRow = vi.fn(async () => undefined);
    const deps: ReconcileWalletDeps = {
      logger: fakeLogger,
      mutate,
      position: trailingTradePositionAdapter,
      removeLedgerRow,
    };
    const action = await reconcileHeldQuantityForTarget(deps, {
      userId: 'u1',
      profileId: 'p1',
      symbol: 'ENAUSDT',
      baseAsset: 'ENA',
      stepSize: '0.01',
      minNotional: '5',
      referencePrice: '0.1158',
      walletFree: '0.01184',
      walletLocked: '0',
      unreservedWalletTotal: '0.01184',
      state: inputState,
    });

    expect(action).toBe('flatten-sub-notional-dust');
    expect(projections).toHaveLength(1);
    expect(projections[0]).toMatchObject({ heldQuantity: null, avgEntryPrice: null });
    expect(removeLedgerRow).toHaveBeenCalledWith('u1', 'p1', 'ENAUSDT');
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
      removeLedgerRow: vi.fn(async () => undefined),
    };
    await reconcileHeldQuantityForTarget(deps, {
      minNotional: null,
      referencePrice: null,
      unreservedWalletTotal: null,
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
      removeLedgerRow: vi.fn(async () => undefined),
    };
    const action = await reconcileHeldQuantityForTarget(deps, {
      minNotional: null,
      referencePrice: null,
      unreservedWalletTotal: null,
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
      removeLedgerRow: vi.fn(async () => undefined),
    };
    const action = await reconcileHeldQuantityForTarget(deps, {
      minNotional: null,
      referencePrice: null,
      unreservedWalletTotal: null,
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
      removeLedgerRow: vi.fn(async () => undefined),
    };
    const action = await reconcileHeldQuantityForTarget(deps, {
      minNotional: null,
      referencePrice: null,
      unreservedWalletTotal: null,
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
      removeLedgerRow: vi.fn(async () => undefined),
    };
    const action = await reconcileHeldQuantityForTarget(deps, {
      minNotional: null,
      referencePrice: null,
      unreservedWalletTotal: null,
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
        if (key === buildSymbolInfoKey('BTCUSDT', 'live')) {
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
        candleInterval: '1h',
        technicalsIntervals: [],
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
      // No REST price by default, matching the absent ticker key: every case in this
      // block pins the increment half of the bounds, so a fallback price would arm the
      // value half and change verdicts the tallies below assert.
      getPriceTickers: vi.fn(async (): Promise<PriceTickerDto[]> => []),
    }),
    strategies: stubStrategies({
      name: 'trailing-trade',
      version: '2.0.0',
    }),
    metrics: noopMetrics(),
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
    const view = trailingTradePositionAdapter.readPosition(finalWrite?.state as TTStateBody);
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
    const runSpy = vi.fn();
    const chain: ChainByKey = {
      run: (key, fn) => {
        runSpy(key, fn);
        return baseChain.run(key, fn);
      },
      size: baseChain.size,
    };
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
    expect(redis.get).not.toHaveBeenCalledWith(buildSymbolInfoKey('BTCUSDT', 'live'));
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
    const redisGet = vi.fn(async (key: string) =>
      key === buildSymbolInfoKey('BTCUSDT', 'live')
        ? JSON.stringify({ baseAsset: 'BTC', filters: { stepSize: '0.00001000' } })
        : null,
    );
    const redis = { get: redisGet } as unknown as Redis;

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
    // And within the target profile, only the named symbol was looked at. Asserted as the exact key SET rather than a call count: the count moves whenever a per-symbol read is added (the ticker read for the dust valuation did exactly that), while the property under guard is that no key for a non-narrowed symbol is ever fetched.
    const fetchedKeys = redisGet.mock.calls.map(([key]) => key);
    expect(new Set(fetchedKeys)).toEqual(
      new Set([buildSymbolInfoKey('BTCUSDT', 'live'), GLOBAL_KEYS.ticker('BTCUSDT')]),
    );
    expect(fetchedKeys.some((key) => key.includes('ETHUSDT'))).toBe(false);
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
      profile: { findById: vi.fn(async () => ({ strategyName: 'trailing-trade', config: {} })) },
      avgEntryPrices: { findBySymbol: ledgerFind, remove },
      symbolStates: { findBySymbol: vi.fn(async () => row) },
    } as unknown as Scope;
    return { scope, remove, ledgerFind };
  };

  // `apps/worker/tsconfig.json` compiles `src/**` only, so nothing type-checks this factory: a target missing a field the value bounds read yields `undefined` at runtime and disarms them while every case here still passes. `unreservedWalletTotal` is therefore DERIVED from the merged wallet rather than hardcoded — these fixtures model a symbol with no operator reserve, and a case that overrides `walletFree` must not leave the bounds judging a stale number.
  const withUnreservedTotal = (t: ReconcileSymbolTarget): ReconcileSymbolTarget => ({
    ...t,
    unreservedWalletTotal:
      t.unreservedWalletTotal ?? new Decimal(t.walletFree).plus(t.walletLocked).toFixed(),
  });

  const target = (o?: Partial<ReconcileSymbolTarget>): ReconcileSymbolTarget =>
    withUnreservedTotal({
      userId: USER_ID,
      profileId: PROFILE_ID,
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      stepSize: '0.00001000',
      minNotional: null,
      referencePrice: null,
      unreservedWalletTotal: null,
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
      { logger: fakeLogger, symbolStateDeps: symbolStateDeps(), metrics: noopMetrics() },
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
      { logger: fakeLogger, symbolStateDeps: symbolStateDeps(), metrics: noopMetrics() },
      scope,
      POSITION,
      target({ walletFree: '0.0142', walletLocked: '0' }),
    );
    expect(result.action).toBe('adopt-wallet-smaller');
  });

  it('flattens a converged strand, deletes its ledger row, and leaves the reviver nothing to resurrect', async () => {
    // The pure core proves the DECISION and the wrapper test proves the two writes; only this proves they are wired to the real sinks and that the reviver running immediately afterwards does not put the cost basis straight back. The ledger lookup here reflects the delete, as the database does: the reviver reads AFTER `remove` has run.
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
      metrics: noopMetrics(),
    } as unknown as Parameters<typeof reconcileSymbol>[0];
    const { scope, remove, ledgerFind } = makeScope(
      { state: ttState({ avgEntryPrice: '0.4587', heldQuantity: '0.01184' }) },
      { avgEntryPrice: '0.4587', quantity: '0.01184' },
    );
    // `mutateSymbolState` resolves the strategy through the profile row before it
    // touches state, so an unstubbed `findById` makes every write in this harness a
    // silent no-op — which would make the state assertions below pass vacuously.
    (scope.profile.findById as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      strategyName: 'trailing-trade',
      config: {},
    });
    let ledgerRow: { avgEntryPrice: string; quantity: string } | null = {
      avgEntryPrice: '0.4587',
      quantity: '0.01184',
    };
    remove.mockImplementation(async () => {
      ledgerRow = null;
    });
    ledgerFind.mockImplementation(async () => ledgerRow);

    const { action, reviveAction } = await reconcileSymbol(
      deps,
      scope,
      POSITION,
      target({
        symbol: 'ENAUSDT',
        baseAsset: 'ENA',
        stepSize: '0.01',
        minNotional: '5',
        referencePrice: '0.1158',
        walletFree: '0.01184',
        walletLocked: '0',
      }),
    );

    expect(action).toBe('flatten-sub-notional-dust');
    expect(remove).toHaveBeenCalledWith('ENAUSDT');
    // Nothing left to revive from, so the reviver is a no-op rather than a second delete.
    expect(reviveAction).toBe('no-op');
    // The STATE, not just the action name: a flatten that left `avgEntryPrice` behind is the half-cleared row the cost-basis adoption then no-ops on forever.
    expect(persisted.at(-1)?.symbol).toBe('ENAUSDT');
    expect(persisted.at(-1)?.state).toMatchObject({ heldQuantity: null, avgEntryPrice: null });
  });

  it('does not let a stale wallet snapshot delete the cost basis of a freshly-bought position', async () => {
    // The full stale-snapshot path, end to end, because the two deletes on it are reached through different doors and guarding only one leaves the position dead anyway. `getAccount` is read once per profile, so the Nth symbol's balance is several REST round trips old; a BUY that filled in that window leaves a fresh 420-unit claim over a stale dust wallet. The flatten declines (the claim is worth USD 48), control falls to `adopt-wallet-smaller`, which nulls the quantity and leaves the cost basis — and then the prune must decline too, on the PRE-reconcile claim, or it deletes by the other door what the flatten just refused to touch.
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
      metrics: noopMetrics(),
    } as unknown as Parameters<typeof reconcileSymbol>[0];
    const { scope, remove } = makeScope(
      { state: ttState({ avgEntryPrice: '0.0984', heldQuantity: '420' }) },
      { avgEntryPrice: '0.0984', quantity: '420' },
    );
    (scope.profile.findById as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      strategyName: 'trailing-trade',
      config: {},
    });

    const { action, reviveAction } = await reconcileSymbol(
      deps,
      scope,
      POSITION,
      target({
        symbol: 'ENAUSDT',
        baseAsset: 'ENA',
        stepSize: '0.01',
        minNotional: '5',
        referencePrice: '0.1158',
        walletFree: '0.01184',
        walletLocked: '0',
      }),
    );

    expect(action).toBe('adopt-wallet-smaller');
    expect(reviveAction).toBe('no-op');
    // The cost basis is the thing being protected, so assert IT, not the action name.
    expect(remove).not.toHaveBeenCalled();
    expect(persisted.at(-1)?.state).toMatchObject({ avgEntryPrice: '0.0984' });
  });

  it('deletes a residue-backed handoff row that no state body will ever let the prune reach', async () => {
    // The disposal handoff shape: `avg_entry_prices` moved with the position, `symbol_states` did not, so there is a ledger row and no body. The reviver returns early on a non-object state before its value bound runs, so nothing downstream can clear this row — the cost-basis step has to delete it where it declines to seed from it, or the next disposal's seeding check blocks on it forever.
    const { scope, remove, ledgerFind } = makeScope(null, {
      avgEntryPrice: '0.4587',
      quantity: '0.87',
    });
    let ledgerRow: { avgEntryPrice: string; quantity: string } | null = {
      avgEntryPrice: '0.4587',
      quantity: '0.87',
    };
    remove.mockImplementation(async () => {
      ledgerRow = null;
    });
    ledgerFind.mockImplementation(async () => ledgerRow);
    const enaTarget = target({
      symbol: 'ENAUSDT',
      baseAsset: 'ENA',
      stepSize: '0.01',
      minNotional: '5',
      referencePrice: '0.1158',
      walletFree: '0.01184',
      walletLocked: '0',
    });

    const costBasisAction = await ensureCostBasisFromTrades(
      { logger: fakeLogger, symbolStateDeps: symbolStateDeps() },
      scope,
      POSITION,
      { getAccount: vi.fn(), getMyTrades: vi.fn(async () => []) } as unknown as Parameters<
        typeof ensureCostBasisFromTrades
      >[3],
      enaTarget,
    );
    const { reviveAction } = await reconcileSymbol(
      { logger: fakeLogger, symbolStateDeps: symbolStateDeps(), metrics: noopMetrics() },
      scope,
      POSITION,
      enaTarget,
    );

    expect(costBasisAction).toBe('no-op');
    expect(remove).toHaveBeenCalledWith('ENAUSDT');
    // Proves the claim this branch used to make and could not keep: the reviver never
    // reaches its value bound here, so it is not what cleared the row.
    expect(reviveAction).toBe('no-op');
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
      { logger: fakeLogger, symbolStateDeps: symbolStateDeps(), metrics: noopMetrics() },
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
          initialState: () => TTStateSchema.parse({ schemaVersion: '2.0.0' }),
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
  ): { scope: Scope; upsert: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } => {
    const upsert = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const scope = {
      scope: SCOPE,
      profile: {
        findById: vi.fn(async () => ({ strategyName: 'trailing-trade', config: {} })),
      },
      avgEntryPrices: { findBySymbol: vi.fn(async () => ledger), upsert, remove },
      symbolStates: { findBySymbol: vi.fn(async () => row) },
    } as unknown as Scope;
    return { scope, upsert, remove };
  };

  // `apps/worker/tsconfig.json` compiles `src/**` only, so nothing type-checks this factory: a target missing a field the value bounds read yields `undefined` at runtime and disarms them while every case here still passes. `unreservedWalletTotal` is therefore DERIVED from the merged wallet rather than hardcoded — these fixtures model a symbol with no operator reserve, and a case that overrides `walletFree` must not leave the bounds judging a stale number.
  const withUnreservedTotal = (t: ReconcileSymbolTarget): ReconcileSymbolTarget => ({
    ...t,
    unreservedWalletTotal:
      t.unreservedWalletTotal ?? new Decimal(t.walletFree).plus(t.walletLocked).toFixed(),
  });

  const target = (o?: Partial<ReconcileSymbolTarget>): ReconcileSymbolTarget =>
    withUnreservedTotal({
      userId: USER_ID,
      profileId: PROFILE_ID,
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      stepSize: '0.00001000',
      minNotional: null,
      referencePrice: null,
      unreservedWalletTotal: null,
      walletFree: '2',
      walletLocked: '0',
      ...o,
    });

  const buyFill = (over: Partial<MyTradeDto>): MyTradeDto => ({
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
    expect(POSITION.readPosition(last?.state as TTStateBody)).toMatchObject({
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

  it('adopts a deeply-reserved holding, valuing the operator balance rather than the surplus', async () => {
    // The adoption gate reads the pre-reserve total too, and nothing else pins that. The operator holds 50 ENA (USD 5.79) with 45 reserved, leaving 5 tradeable (USD 0.579); the two straddle the UNSCALED USD 5 floor this branch uses, so mis-wiring the gate to the reserve-adjusted wallet refuses to price a real position and leaves it reading FLAT.
    const { scope, upsert } = makeScope(null, null);
    const getMyTrades = vi.fn(async () => [buyFill({})]);

    const action = await ensureCostBasisFromTrades(
      { logger: fakeLogger, symbolStateDeps: symbolStateDeps() },
      scope,
      POSITION,
      client(getMyTrades),
      target({
        symbol: 'ENAUSDT',
        baseAsset: 'ENA',
        stepSize: '0.01',
        minNotional: '5',
        referencePrice: '0.1158',
        walletFree: '5',
        walletLocked: '0',
        unreservedWalletTotal: '50',
      }),
    );

    expect(action).toBe('reconstructed-from-trades');
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('still seeds a handoff ledger row worth less than one minimum order but more than residue', async () => {
    // A handoff target holding USD 4 against a USD 5 floor is a REAL position, and the row is a durable statement that it exists. Refusing it here returns `no-op`, `assertTargetSeeded` throws, and the disposal retries into a dead letter with the source already disabled — so this branch is gated at the residue bar, not at the floor.
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
    const { scope } = makeScope(null, { avgEntryPrice: '1', quantity: '4' });

    const action = await ensureCostBasisFromTrades(
      deps,
      scope,
      POSITION,
      client(vi.fn(async () => [buyFill({})])),
      target({
        stepSize: '0.01',
        minNotional: '5',
        referencePrice: '1',
        walletFree: '4',
        walletLocked: '0',
      }),
    );

    expect(action).toBe('seeded-from-ledger');
    expect(persisted.at(-1)?.state).toMatchObject({ avgEntryPrice: '1', heldQuantity: '4' });
  });

  it('deletes rather than seeds a ledger handoff row backed only by residue', async () => {
    // Same disposal-handoff branch as above, on coins that have since decayed to residue. Seeding a body from the row would hand the strategy a position it can never exit — and merely declining would strand the row forever, because this branch only runs when there is NO state body and the reviver returns early on exactly that, never reaching its own value bound. So the row is deleted here.
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
    const { scope, upsert, remove } = makeScope(null, {
      avgEntryPrice: '0.4587',
      quantity: '0.87',
    });
    const getMyTrades = vi.fn(async () => [buyFill({})]);

    const action = await ensureCostBasisFromTrades(
      deps,
      scope,
      POSITION,
      client(getMyTrades),
      target({
        symbol: 'ENAUSDT',
        baseAsset: 'ENA',
        stepSize: '0.01',
        minNotional: '5',
        referencePrice: '0.1158',
        walletFree: '0.01184',
        walletLocked: '0',
      }),
    );

    expect(action).toBe('no-op');
    expect(getMyTrades).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(persisted).toHaveLength(0);
    expect(remove).toHaveBeenCalledWith('ENAUSDT');
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

describe('readTickerPrice (the only thing that arms a value bound)', () => {
  // Every bound in this module is disarmed by a null here, so each way of returning
  // null is a way of silently standing the bounds down. They are cheap to pin and
  // each one is a sentence the module's comments already promise.
  const redisWith = (raw: string | null): Redis =>
    ({ get: vi.fn(async () => raw) }) as unknown as Redis;

  it('returns null when no ticker is cached', async () => {
    await expect(readTickerPrice(redisWith(null), 'ENAUSDT')).resolves.toBeNull();
  });

  it('returns null on a malformed cache entry rather than throwing', async () => {
    await expect(readTickerPrice(redisWith('{'), 'ENAUSDT')).resolves.toBeNull();
  });

  it('returns null when the cached price is a JSON number, not a decimal string', async () => {
    // Money crosses this boundary as a string; a number has already been through
    // IEEE-754 and must not be trusted as a price.
    await expect(
      readTickerPrice(redisWith(JSON.stringify({ price: 0.1158 })), 'ENAUSDT'),
    ).resolves.toBeNull();
  });

  it('returns null on a non-positive price', async () => {
    await expect(
      readTickerPrice(redisWith(JSON.stringify({ price: '0' })), 'ENAUSDT'),
    ).resolves.toBeNull();
  });

  it('returns null on a non-finite price, which .gt(0) alone would accept', async () => {
    // `new Decimal('Infinity').gt(0)` is true, so a positivity test passes it through. Every finite holding is below an infinite floor, so letting it reach the target ARMS the value bounds against a real position instead of standing them down.
    await expect(
      readTickerPrice(redisWith(JSON.stringify({ price: 'Infinity' })), 'ENAUSDT'),
    ).resolves.toBeNull();
  });

  it('returns null on an unparseable price', async () => {
    await expect(
      readTickerPrice(redisWith(JSON.stringify({ price: 'abc' })), 'ENAUSDT'),
    ).resolves.toBeNull();
  });

  it('returns the cached price verbatim, without re-formatting it', async () => {
    await expect(
      readTickerPrice(redisWith(JSON.stringify({ price: '0.11580000' })), 'ENAUSDT'),
    ).resolves.toBe('0.11580000');
  });

  it('reads the global ticker key for the symbol', async () => {
    const get = vi.fn(async () => null);
    await readTickerPrice({ get } as unknown as Redis, 'ENAUSDT');
    expect(get).toHaveBeenCalledWith(GLOBAL_KEYS.ticker('ENAUSDT'));
  });
});

describe('resolveWalletFields (a bad balance must disarm, never throw)', () => {
  it('drains the reserve and reports the pre-reserve total', () => {
    expect(resolveWalletFields({ free: '100', locked: '0' }, '99.5')).toEqual({
      walletFree: '0.5',
      walletLocked: '0',
      unreservedWalletTotal: '100',
    });
  });

  it('treats an absent balance row as a real zero', () => {
    // Binance omits the asset entirely when the holding is zero, which is a holding of none, not an unknown.
    expect(resolveWalletFields(undefined, null)).toEqual({
      walletFree: '0',
      walletLocked: '0',
      unreservedWalletTotal: '0',
    });
  });

  it.each([
    ['unparseable free', { free: 'not-a-number', locked: '0' }],
    ['unparseable locked', { free: '1', locked: 'nope' }],
    ['non-finite free', { free: 'Infinity', locked: '0' }],
  ])('does not throw on a %s leg, and disarms the value bound instead', (_label, balance) => {
    // This runs in the per-symbol loop where the only try covers `getAccount`, so a throw would abort the sweep for every remaining symbol and every remaining profile over one malformed string.
    const fields = resolveWalletFields(balance, null);
    expect(fields.unreservedWalletTotal).toBeNull();
    // The raw leg is passed through rather than defaulted to '0', because zero reads as an empty wallet and an empty wallet is what arms the phantom prune.
    expect(fields.walletFree).toBe(balance.free);
    expect(fields.walletLocked).toBe(balance.locked);
    // And the reconciler's own guard then declines to act on it.
    expect(
      reconcileHeldQuantity({
        heldQuantity: '100',
        walletFree: fields.walletFree,
        walletLocked: fields.walletLocked,
        unreservedWalletTotal: fields.unreservedWalletTotal,
        stepSize: '0.01',
        minNotional: '5',
        referencePrice: '1',
      }),
    ).toEqual({ action: 'no-op', nextHeldQuantity: '100' });
  });
});
