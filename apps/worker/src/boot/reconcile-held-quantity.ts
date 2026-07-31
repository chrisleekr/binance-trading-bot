// Boot-time wallet reconciler for TT state `heldQuantity`.
//
// The fill-adopter maintains `state.heldQuantity` by mutating it on every
// executionReport. That keeps state aligned with the strategy's view of
// every fill the worker observed — but two windows are unobservable:
//
//   1. Worker downtime: fills landed while the worker was offline; the
//      user-stream replay only covers a short window.
//   2. External base-asset movement: operator withdraws to cold storage,
//      deposits a new lump, or pays a fee in the base asset (BNB-on-BTC
//      discount). The wallet shifts but no fill event fires.
//
// In either case, the next sell would emit a quantity that doesn't match
// the wallet — Binance rejects (under-funded) or the strategy leaves a
// hanging position. This module closes the gap once at boot, after the
// profile manager has loaded the enabled set and before tick workers
// start dequeuing.
//
// Policy: read `wallet.free + wallet.locked` for each (profile, symbol)
// baseAsset. If `|wallet - heldQuantity| > stepSize`, log an `info`
// warning and adopt the SMALLER of the two as the new `heldQuantity`.
// "Smaller" is the safety stance — sell-sizing will never request more
// than the wallet actually holds.
//
// Cross-profile shared base asset: base-asset exclusivity (one base asset per
// Binance account, enforced in `profileSymbols.upsert` via
// `findOwningSiblingByBase`) now stops two SIBLING profiles from managing the
// same base asset on one account — including the two-symbols-one-base case
// (BTCUSDT under one profile, BTCFDUSD under another), which the older
// symbol-level guard missed. So no two profiles can share a wallet line.
// The only residual is one profile binding two symbols over the same base
// (BTCUSDT and BTCFDUSD under the SAME profile): the guard excludes self, so it
// is allowed, and both rows then track the one BTC balance. This reconciler
// treats `wallet.free + locked` as belonging to the (profile, symbol) under
// inspection, so on that intra-profile overlap each symbol's tracked qty could
// be shrunk to the combined cap. Rare (it needs two quote markets on one base
// bound to the same profile); a future fix would sum same-base LBP rows first.

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { Decimal } from '@app/money';
import type { BinanceMode, MyTradeDto } from '@app/binance';

import { profileRepo, repo, type Database, type ProfileScope } from '@app/db';
import { unwrapId, type AccountId, type ProfileId, type UserId } from '@app/contracts';
import type { PositionStateAdapter } from '@app/strategy-core';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';
import { buildSymbolInfoKey } from 'executor/redis-namespace.js';
import type { ChainByKey } from 'lib/chain-by-key.js';
import { reserveAdjustedBalance } from 'lib/reserve.js';
import { runStateMigration } from 'state/migrate-state.js';
import { mutateSymbolState, type MutateSymbolStateDeps } from 'state/version-aware-mutate.js';
import { openPositionFromFills } from 'queues/pipeline-handlers/open-position-from-fills.js';
import { reviveAvgEntryPriceForTarget, type ReviveAction } from './revive-avg-entry-price.js';

/**
 * Pure reconciliation core. No I/O — the caller passes the wallet
 * balance, the live state, and the step size for the symbol; the
 * function returns the action to take and the post-reconciliation
 * `heldQuantity` (null if no adjustment is warranted).
 *
 * `null` heldQuantity in state means "no fill-derived value yet" — the
 * reconciler seeds it from the wallet whenever the wallet holds at
 * least one step's worth. A zero wallet with null state is a no-op.
 */
export interface ReconcileInput {
  readonly heldQuantity: string | null;
  readonly walletFree: string;
  readonly walletLocked: string;
  readonly stepSize: string;
}

export type ReconcileAction =
  | 'no-op'
  | 'seed-from-wallet'
  | 'adopt-wallet-smaller'
  | 'adopt-state-smaller'
  | 'skip-schema-version';

export interface ReconcileResult {
  readonly action: ReconcileAction;
  readonly nextHeldQuantity: string | null;
}

/**
 * Pure reconciliation. Decimal-safe end-to-end; never coerces money to
 * `number`. Returns `{action: 'no-op', nextHeldQuantity: <unchanged>}`
 * when no write is needed so callers can short-circuit the persistence
 * step.
 */
export const reconcileHeldQuantity = (input: ReconcileInput): ReconcileResult => {
  const free = safe(input.walletFree);
  const locked = safe(input.walletLocked);
  const step = safe(input.stepSize);
  if (free === null || locked === null || step === null || step.lte(0)) {
    return { action: 'no-op', nextHeldQuantity: input.heldQuantity };
  }
  const wallet = free.plus(locked);

  if (input.heldQuantity === null) {
    if (wallet.lt(step)) {
      return { action: 'no-op', nextHeldQuantity: null };
    }
    return { action: 'seed-from-wallet', nextHeldQuantity: wallet.toFixed() };
  }

  const held = safe(input.heldQuantity);
  if (held === null) {
    // Corrupt heldQuantity string — fall back to wallet so the next sell
    // doesn't crash on parse.
    return { action: 'seed-from-wallet', nextHeldQuantity: wallet.toFixed() };
  }

  const diff = held.minus(wallet).abs();
  if (diff.lte(step)) {
    return { action: 'no-op', nextHeldQuantity: input.heldQuantity };
  }
  // Adopt the smaller — safest behaviour: never let sell sizing exceed
  // either source.
  if (wallet.lt(held)) {
    return { action: 'adopt-wallet-smaller', nextHeldQuantity: wallet.toFixed() };
  }
  return { action: 'adopt-state-smaller', nextHeldQuantity: held.toFixed() };
};

const safe = (raw: string): Decimal | null => {
  try {
    return new Decimal(raw);
  } catch {
    return null;
  }
};

export interface ReconcileTarget {
  readonly userId: string;
  readonly profileId: string;
  readonly symbol: string;
  readonly baseAsset: string;
  readonly stepSize: string;
  readonly walletFree: string;
  readonly walletLocked: string;
  readonly state: unknown;
}

export interface ReconcileWalletDeps {
  readonly logger: Logger;
  /**
   * Apply a per-(profile, symbol) state mutation. Production routes
   * through `mutateSymbolState`, so the helper reads and writes one
   * `symbol_states` row, sibling symbols on the same profile no longer
   * race a shared blob. The mutator returns `null` to signal no change.
   */
  readonly mutate: (symbol: string, mutator: (state: unknown) => unknown | null) => Promise<void>;
  /**
   * Strategy's position capability. The reconciler reads `heldQuantity`
   * via {@link PositionStateAdapter.readPosition} and writes it back via
   * `setHeldQuantity`, so this module never names the strategy's state
   * fields or its schema version (core invariant #1).
   */
  readonly position: PositionStateAdapter;
}

/**
 * Persist-side wrapper. Runs the pure reconciler for one (profile,
 * symbol) target, logs the outcome, and writes the new heldQuantity via
 * the per-symbol mutator when an adjustment is needed. The strategy's
 * `position` capability owns the state schema: a `null` position view
 * means the body is not the strategy's current schema, so the row is
 * deferred (the cold-load path migrates first and the next boot
 * reconciles).
 */
export const reconcileHeldQuantityForTarget = async (
  deps: ReconcileWalletDeps,
  target: ReconcileTarget,
): Promise<ReconcileAction> => {
  // A non-object body is a distinct failure class from an old-schema body
  // and never carries a position; skip it without deferring.
  if (!target.state || typeof target.state !== 'object') {
    deps.logger.warn(
      { userId: target.userId, profileId: target.profileId, symbol: target.symbol },
      'reconcileHeldQuantity: state is not an object; skipping',
    );
    return 'no-op';
  }
  const view = deps.position.readPosition(target.state);
  if (view === null) {
    deps.logger.info(
      { userId: target.userId, profileId: target.profileId, symbol: target.symbol },
      'reconcileHeldQuantity: state not at current strategy schema; deferring to next boot after migration',
    );
    return 'skip-schema-version';
  }
  const result = reconcileHeldQuantity({
    heldQuantity: view.heldQuantity,
    walletFree: target.walletFree,
    walletLocked: target.walletLocked,
    stepSize: target.stepSize,
  });
  if (result.action === 'no-op') return 'no-op';

  const logCtx = {
    userId: target.userId,
    profileId: target.profileId,
    symbol: target.symbol,
    baseAsset: target.baseAsset,
    previous: view.heldQuantity,
    next: result.nextHeldQuantity,
    walletFree: target.walletFree,
    walletLocked: target.walletLocked,
    stepSize: target.stepSize,
    action: result.action,
  };
  // Surface the wallet-smaller-than-state case at `warn`: it implies the
  // wallet shrank relative to the strategy's tracked position (external
  // withdrawal, BNB fee burn on base asset, or a fill we missed). All
  // other actions are first-boot / external-deposit and stay at `info`.
  if (result.action === 'adopt-wallet-smaller') {
    deps.logger.warn(
      logCtx,
      'reconcileHeldQuantity: wallet smaller than tracked position; adjusting',
    );
  } else {
    deps.logger.info(logCtx, 'reconcileHeldQuantity: adjusting heldQuantity');
  }
  // Apply onto the post-migration `live` slice that `mutateSymbolState`
  // pulled through the cache reconciliation; never against the stale
  // `target.state` snapshot. The plugin merges the new heldQuantity onto
  // its own body.
  await deps.mutate(target.symbol, (live) =>
    deps.position.setHeldQuantity(live, result.nextHeldQuantity),
  );
  return result.action;
};

/**
 * Shape of a Binance REST account snapshot the reconciler reads. Keeping
 * it minimal here lets the wiring layer pass any client that exposes
 * `getAccount()` — the existing mode-pinned `BinanceRest` returned by
 * `resolveBinance` satisfies this without any cast.
 */
export interface BinanceAccountClient {
  getAccount(): Promise<{
    readonly balances: readonly {
      readonly asset: string;
      readonly free: string;
      readonly locked: string;
    }[];
  }>;
  /**
   * Account's own trades for a symbol, oldest first. Read to reconstruct the
   * cost basis of a held-but-unpriced position (see
   * {@link ensureCostBasisFromTrades}). The resolved `BinanceRest` already
   * implements this, so both `resolveBinance` (boot) and `resolveBinanceClient`
   * (pipeline) satisfy this interface with no cast.
   */
  getMyTrades(params: {
    symbol: string;
    fromId?: number;
    limit?: number;
  }): Promise<readonly MyTradeDto[]>;
}

/**
 * Minimal structural view of a strategy plugin used by the orchestrator
 * to upgrade a profile's stored state to the strategy's current schema
 * before reconciliation. Mirrors the relevant fields on `AnyStrategy`
 * without forcing the worker to import the full plugin contract here.
 */
export interface MigrationStrategy {
  readonly name: string;
  readonly version: string;
  migrateState?(input: { readonly fromVersion: string; readonly state: unknown }): unknown;
  /**
   * Position-mutation capability. Present when the strategy manages a
   * single long position per (profile, symbol); the boot reconcilers read
   * and converge the position through it. Absent strategies are skipped.
   */
  readonly position?: PositionStateAdapter;
}

export interface StrategyLookup {
  get(name: string): MigrationStrategy | undefined;
}

export interface ReconcileOrchestratorDeps {
  readonly db: Database;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly listActive: () => readonly ActiveProfile[];
  readonly resolveBinance: (
    operatorId: UserId,
    accountId: AccountId,
  ) => Promise<BinanceAccountClient | null>;
  /**
   * Strategy registry lookup. Used to migrate a profile's persisted state
   * in-line before the schemaVersion gate runs. Without this step a legacy
   * profile whose state is on a prior schema would be skipped here and
   * only migrated on the first tick — leaving heldQuantity null forever.
   */
  readonly strategies: StrategyLookup;
  /**
   * Atomic write of both `state` and `strategy_version` columns. Routes
   * to the tick handler's `persistProfileState` in production so a single
   * UPDATE statement keeps the schema stamp and the state body in sync. A
   * state-only writer (one that touches `state` without `strategy_version`)
   * is intentionally NOT used here: it would leave strategy_version stale and
   * force the next tick to migrate again.
   */
  readonly persistMigratedState: (
    scope: ProfileScope,
    nextState: unknown,
    nextStrategyVersion: string,
  ) => Promise<void>;
  /**
   * Dependencies threaded into {@link mutateSymbolState} for every
   * per-(profile, symbol) reconcile/revive write. Bundled here so the
   * orchestrator hands the same registry + atomic-symbol persister to
   * both reconcilers without re-plumbing each call site.
   */
  readonly symbolStateDeps: MutateSymbolStateDeps;
  /**
   * Same `chainByKey` instance the tick handler and fill-adopter hold.
   * `mutateSymbolState`'s contract requires the caller to serialise on
   * the `(profileId, symbol)` key; a user-stream `executionReport` can
   * land in the boot window and drive `fillAdopter.adopt` on the same
   * slice, so the reconcile/revive writes MUST run under this lock to
   * avoid interleaving read/migrate/write with that fill.
   */
  readonly chain: ChainByKey;
}

export interface MigrateProfileInput {
  readonly logger: Logger;
  readonly strategies: StrategyLookup;
  readonly persistMigratedState: ReconcileOrchestratorDeps['persistMigratedState'];
  /** Proven scope for the migrated-state write; ownership already checked. */
  readonly scope: ProfileScope;
  readonly userId: UserId;
  readonly profileId: ProfileId;
  readonly profile: { state: unknown; strategyName: string; strategyVersion: string };
}

/**
 * Idempotent in-line schema migration. When the strategy registered for a
 * profile is newer than the persisted `strategy_version`, delegates to
 * `runStateMigration` for the per-hop walk. On success, persists
 * `(state, strategy_version)` atomically and returns the migrated profile
 * so the caller can continue reconciliation against the up-to-date shape.
 * On any failure the original profile is returned untouched and the
 * schemaVersion gate in the reconciler skips the row safely.
 */
export const migrateProfileIfNeeded = async (
  input: MigrateProfileInput,
): Promise<{ state: unknown; strategyName: string; strategyVersion: string }> => {
  const strategy = input.strategies.get(input.profile.strategyName);
  if (!strategy) return input.profile;
  const result = await runStateMigration({
    strategy,
    fromVersion: input.profile.strategyVersion,
    state: input.profile.state,
    logger: input.logger,
    logContext: { userId: input.userId, profileId: input.profileId },
  });
  if (result === null || !result.migrated) return input.profile;
  await input.persistMigratedState(input.scope, result.state, result.version);
  input.logger.info(
    {
      userId: input.userId,
      profileId: input.profileId,
      fromVersion: input.profile.strategyVersion,
      toVersion: result.version,
    },
    'reconcileHeldQuantity: migrated profile state to current schema before reconciliation',
  );
  return { ...input.profile, state: result.state, strategyVersion: result.version };
};

/**
 * Iterates active profiles and reconciles each (profile, symbol) pair.
 * Best-effort: a per-target failure is logged and skipped so one bad
 * profile cannot prevent the worker from starting. Returns a per-action
 * tally for observability — callers can log a single summary line.
 */
export interface BootReconciliationTally {
  readonly heldQuantity: Record<ReconcileAction, number>;
  readonly avgEntryPriceRevival: Record<ReviveAction, number>;
}

/**
 * Resolved per-(profile, symbol) reconcile target. The orchestrator
 * enumerates these from the active set, the cached symbolInfo, and the
 * wallet snapshot; {@link reconcileSymbol} consumes one.
 */
export interface ReconcileSymbolTarget {
  readonly userId: UserId;
  readonly profileId: ProfileId;
  readonly symbol: string;
  readonly baseAsset: string;
  readonly stepSize: string;
  readonly walletFree: string;
  readonly walletLocked: string;
}

export interface ReconcileSymbolResult {
  readonly action: ReconcileAction;
  readonly reviveAction: ReviveAction;
}

export type CostBasisAction = 'no-op' | 'reconstructed-from-trades' | 'seeded-from-ledger';

/**
 * Cost-basis seeding for a held-but-unpriced position, run BEFORE the
 * avgEntryPrice revive. A fresh operator adopt subscribes a symbol whose wallet
 * already holds the coin while the strategy state and the `avg_entry_prices`
 * ledger are both empty. With no ledger row the boot reviver has nothing to
 * restore from, so the entry gate keeps seeing the symbol as flat and places
 * erroneous re-entry BUYs. This step reconstructs the average entry price from
 * Binance `myTrades` and writes it to the ledger; the existing reviver then
 * restores it into state.
 *
 * On a hit it upserts the ledger AND applies a synthetic buy onto the strategy
 * state through `mutateSymbolState` (which seeds the strategy's `initialState`
 * when no `symbol_states` row exists yet — the fresh-adopt case, where
 * `reconcileSymbol` alone would defer the null row). `applyFill('buy')` is the
 * same primitive the fill-adopter uses, so the seeded body is byte-shape
 * identical to one a real entry fill produces (cost basis + held qty set,
 * trailing high-water mark reset). The downstream revive then finds
 * avgEntryPrice already set and no-ops idempotently.
 *
 * No-op (the common case) when the strategy already knows the position
 * (`avgEntryPrice` set), a ledger row already exists, or the wallet holds less
 * than one stepSize. Best-effort on the Binance side: a `getMyTrades` failure
 * logs at `warn` and returns `no-op` so a flaky exchange never breaks boot or a
 * reconfigure.
 *
 * Window limitation: `getMyTrades` returns at most the most recent 1000 fills.
 * A position whose lifetime spans more trades reconstructs its average from a
 * truncated window (best-effort). The held QUANTITY is not at risk — the
 * `reconcileSymbol` pass right after pins it to wallet truth — only the average
 * price is approximate for such histories, which is far beyond this bot's
 * per-symbol fill volume.
 */
export const ensureCostBasisFromTrades = async (
  deps: Pick<ReconcileOrchestratorDeps, 'logger' | 'symbolStateDeps'>,
  scope: Awaited<ReturnType<typeof profileRepo>>,
  position: PositionStateAdapter,
  client: BinanceAccountClient,
  target: ReconcileSymbolTarget,
): Promise<CostBasisAction> => {
  const row = await scope.symbolStates.findBySymbol(target.symbol);
  if (row?.state && typeof row.state === 'object') {
    const view = position.readPosition(row.state);
    // A non-null view at a stale/unknown schema means the body is not the
    // strategy's current shape. The reconciler/reviver own that schema-skip
    // path; do not reconstruct against a body we cannot read.
    if (view === null) return 'no-op';
    // Strategy already prices the position — nothing to reconstruct.
    if (view.avgEntryPrice != null) return 'no-op';
  }

  const existingLedger = await scope.avgEntryPrices.findBySymbol(target.symbol);

  // Wallet holds less than one step — dust the strategy cannot trade.
  const wallet = walletTotal(target);
  const step = safe(target.stepSize);
  if (wallet === null || step === null || step.lte(0) || wallet.lt(step)) return 'no-op';

  // A ledger row exists, so the cost basis is already known and there is nothing to
  // reconstruct from trades. The reviver restores the price ONTO A STATE BODY — and
  // when there is no body at all (a profile that has never ticked this symbol, which
  // is exactly what a disposal's handoff target is), it has nothing to restore onto
  // and the position stays invisible: the strategy reads FLAT while holding the
  // coins, arms no stop, and buys again on the next signal. Seed the body straight
  // from the ledger instead, through the same `applyFill('buy')` primitive a real
  // entry fill uses, so it is byte-shape identical to one.
  if (existingLedger) {
    if (row?.state != null) return 'no-op';
    await mutateSymbolState(deps.symbolStateDeps, scope, target.symbol, (live) =>
      position.applyFill(live, {
        kind: 'buy',
        avgEntryPrice: existingLedger.avgEntryPrice,
        heldQuantity: existingLedger.quantity,
      }),
    );
    deps.logger.info(
      {
        userId: unwrapId(target.userId),
        profileId: unwrapId(target.profileId),
        symbol: target.symbol,
        avgEntryPrice: existingLedger.avgEntryPrice,
        quantity: existingLedger.quantity,
      },
      'ensureCostBasis: seeded strategy state from the existing cost-basis ledger row',
    );
    return 'seeded-from-ledger';
  }

  let reconstructed: ReturnType<typeof openPositionFromFills>;
  try {
    // limit 1000 (Binance max) widens the window so the average-cost walk
    // accounts for as much of the position's lifetime as one call allows.
    const fills = await client.getMyTrades({ symbol: target.symbol, limit: 1000 });
    reconstructed = openPositionFromFills(fills);
  } catch (err) {
    deps.logger.warn(
      {
        err,
        userId: unwrapId(target.userId),
        profileId: unwrapId(target.profileId),
        symbol: target.symbol,
      },
      'ensureCostBasis: getMyTrades failed; leaving position unpriced',
    );
    return 'no-op';
  }
  if (reconstructed === null) return 'no-op';

  // The ledger row backs the avgEntryPrice revive only; its `quantity` is the
  // reconstruction artifact, NOT live held qty. `reconcileSymbol` below pins
  // state.heldQuantity to wallet truth, which can differ from this window-
  // derived qty — that divergence is expected and harmless (no consumer sizes
  // a position off the ledger quantity).
  await scope.avgEntryPrices.upsert(target.symbol, {
    avgEntryPrice: reconstructed.avgEntryPrice,
    quantity: reconstructed.quantity,
  });
  // Apply the reconstructed position onto the strategy state so the entry gate
  // sees it immediately (before any tick). `mutateSymbolState` seeds
  // `initialState` when the row is missing, so a fresh adopt with no prior tick
  // still lands a priced body. `applyFill('buy')` is the fill-adopter's own
  // primitive — the seeded body matches a real entry fill exactly (cost basis +
  // held qty set, trailing high reset, grid index left at the held level).
  await mutateSymbolState(deps.symbolStateDeps, scope, target.symbol, (live) =>
    position.applyFill(live, {
      kind: 'buy',
      avgEntryPrice: reconstructed.avgEntryPrice,
      heldQuantity: reconstructed.quantity,
    }),
  );
  deps.logger.info(
    {
      userId: unwrapId(target.userId),
      profileId: unwrapId(target.profileId),
      symbol: target.symbol,
      avgEntryPrice: reconstructed.avgEntryPrice,
      quantity: reconstructed.quantity,
    },
    'ensureCostBasis: reconstructed cost basis from myTrades for held-but-unpriced position',
  );
  return 'reconstructed-from-trades';
};

const walletTotal = (target: { walletFree: string; walletLocked: string }): Decimal | null => {
  const free = safe(target.walletFree);
  const locked = safe(target.walletLocked);
  if (free === null || locked === null) return null;
  return free.plus(locked);
};

/**
 * One per-(profile, symbol) reconcile + revive pass. Extracted from the
 * boot orchestrator so the "reconcile heldQuantity, then revive
 * avgEntryPrice unless the reconciler already skipped on schema" sequence
 * is a unit under test rather than an inline closure only reachable
 * through the full doubly-nested orchestrator. The caller owns
 * enumeration and the `chain.run` per-symbol lock; this owns the logic.
 * Account-scoped reads/writes stay bound to the proven `scope` (invariant
 * #4); `mutateSymbolState` performs the authoritative read/migrate/write.
 *
 * `currentState` tracks the last mutator-emitted body so the reviver's
 * phantom-ledger gate sees the reconciler's heldQuantity adjustment. A
 * missing row yields `null` and the schema gate drops the symbol cleanly:
 * the next boot, after a tick has seeded the row, reconciles.
 */
export const reconcileSymbol = async (
  deps: Pick<ReconcileOrchestratorDeps, 'logger' | 'symbolStateDeps'>,
  scope: Awaited<ReturnType<typeof profileRepo>>,
  position: PositionStateAdapter,
  target: ReconcileSymbolTarget,
): Promise<ReconcileSymbolResult> => {
  const row = await scope.symbolStates.findBySymbol(target.symbol);
  let currentState: unknown = row?.state ?? null;
  const mutate = async (
    sym: string,
    mutator: (state: unknown) => unknown | null,
  ): Promise<void> => {
    await mutateSymbolState(deps.symbolStateDeps, scope, sym, (live: unknown) => {
      const next = mutator(live);
      if (next !== null) currentState = next;
      return next;
    });
  };

  const action = await reconcileHeldQuantityForTarget(
    { logger: deps.logger, mutate, position },
    {
      userId: unwrapId(target.userId),
      profileId: unwrapId(target.profileId),
      symbol: target.symbol,
      baseAsset: target.baseAsset,
      stepSize: target.stepSize,
      walletFree: target.walletFree,
      walletLocked: target.walletLocked,
      state: currentState,
    },
  );

  // #266: short-circuit when the upstream reconciler already skipped on
  // schemaVersion. The reviver's gate would otherwise fire the same skip
  // with an "after migration; investigate" WARN that misleads operators
  // into chasing a phantom regression — no migration was attempted here.
  // Tally under the same action so the boot summary line stays honest.
  if (action === 'skip-schema-version') {
    return { action, reviveAction: 'skip-schema-version' };
  }
  // Revive `state.avgEntryPrice` from the ledger when the state forgot the
  // position (missed fill-adoption, mid-tick crash, manual order). Also
  // prunes phantom ledger rows (#262): a row backed by zero wallet balance
  // is DELETEd here before any revive can rehydrate from it.
  const ledgerRow = await scope.avgEntryPrices.findBySymbol(target.symbol);
  const reviveAction = await reviveAvgEntryPriceForTarget(
    {
      logger: deps.logger,
      mutate,
      position,
      removeLedgerRow: async (_u, _p, sym) => {
        await scope.avgEntryPrices.remove(sym);
      },
    },
    {
      userId: unwrapId(target.userId),
      profileId: unwrapId(target.profileId),
      symbol: target.symbol,
      state: currentState,
      ledgerAvgEntryPrice: ledgerRow?.avgEntryPrice ?? null,
      ledgerQuantity: ledgerRow?.quantity ?? null,
      // The prune tests the WALLET, not the heldQuantity we just pinned from it:
      // a wallet holding exactly one stepSize is the smallest LEGAL position on
      // many alts, and pruning it would disarm the stop and let the entry gate
      // re-buy.
      walletQuantity: walletTotal(target)?.toFixed() ?? null,
      stepSize: target.stepSize,
    },
  );
  return { action, reviveAction };
};

/**
 * Narrows a reconciliation pass to a single target. Without it the sweep is
 * fleet-wide, which is right at boot and on the periodic backstop but wrong for
 * the `symbol-reconcile` job: that job knows exactly which (profile, symbol)
 * drifted, and reconciling every OTHER profile would pay a `getAccount` per
 * profile and a trade-history read per symbol to converge state nobody suspects.
 */
export interface ReconcileOnly {
  readonly profileId: ProfileId;
  /** Omitted ⇒ every symbol of that profile. */
  readonly symbols?: readonly string[];
}

export const runHeldQuantityReconciliation = async (
  deps: ReconcileOrchestratorDeps,
  opts?: { readonly only?: ReconcileOnly },
): Promise<BootReconciliationTally> => {
  const tally: Record<ReconcileAction, number> = {
    'no-op': 0,
    'seed-from-wallet': 0,
    'adopt-wallet-smaller': 0,
    'adopt-state-smaller': 0,
    'skip-schema-version': 0,
  };
  const reviveTally: Record<ReviveAction, number> = {
    'no-op': 0,
    'revive-from-ledger': 0,
    'prune-phantom-ledger': 0,
    'skip-schema-version': 0,
  };
  const only = opts?.only;
  for (const active of deps.listActive()) {
    // Filter BEFORE any IO so a narrowed pass pays nothing for the profiles it
    // is not interested in.
    if (only && active.profileId !== only.profileId) continue;
    const rest = await deps.resolveBinance(active.operatorId, active.accountId).catch(() => null);
    if (!rest) {
      // No credentials (test-mode profile without testnet keys) — the
      // strategy can't sell anyway, so reconciliation is meaningless.
      continue;
    }
    let scope;
    try {
      scope = await profileRepo(deps.db, active.operatorId, active.accountId, active.profileId);
    } catch (err) {
      deps.logger.warn(
        { err, userId: active.userId, profileId: active.profileId },
        'reconcileHeldQuantity: profileRepo failed; skipping profile',
      );
      continue;
    }
    const profileRow = await scope.profile.findById();
    if (!profileRow) continue;

    // Symbol filters (`stepSize`) differ between production and testnet, so the
    // adopted-quantity rounding below MUST read the keyspace matching this
    // profile's Binance mode — a test-mode profile rounding against production
    // filters records the wrong held quantity until the next mode-correct tick.
    const binanceMode = await repo.accounts.binanceModeById(deps.db, active.accountId);
    const mode: BinanceMode = binanceMode === 'live' ? 'live' : 'test';

    // Resolve the strategy's position capability once per profile. A
    // strategy without it has no single-position model to reconcile —
    // skip the whole profile (capability-presence replaces the old
    // hardcoded schemaVersion gate).
    const positionAdapter = deps.strategies.get(profileRow.strategyName)?.position;
    if (!positionAdapter) {
      deps.logger.info(
        {
          userId: active.userId,
          profileId: active.profileId,
          strategyName: profileRow.strategyName,
        },
        'reconcileHeldQuantity: strategy has no position capability; skipping profile',
      );
      continue;
    }

    // Heal the legacy per-profile `(state, strategy_version)` row in
    // lockstep before the per-symbol path runs. After the cutover the
    // reconciler reads per-symbol bodies, but the profile-level columns
    // still back legacy consumers (#264 inverse), keeping this step
    // gated on the registered strategy avoids a divergence window.
    // The returned profile is not consumed here: per-symbol rows are
    // the source of truth for the wallet reconcile.
    await migrateProfileIfNeeded({
      logger: deps.logger,
      strategies: deps.strategies,
      persistMigratedState: deps.persistMigratedState,
      scope: scope.scope,
      userId: active.userId,
      profileId: active.profileId,
      profile: profileRow,
    });

    let account;
    try {
      account = await rest.getAccount();
    } catch (err) {
      deps.logger.warn(
        { err, userId: active.userId, profileId: active.profileId },
        'reconcileHeldQuantity: getAccount failed; skipping profile',
      );
      continue;
    }

    // Per-symbol reserve floors (base units) the operator wants the bot to
    // always hold. Subtracted from the wallet BEFORE adoption so the reconciler
    // claims only the tradeable surplus as the position, never the reserve — a
    // fully-reserved holding then reconciles flat and the bot trades on top.
    // One read per profile; a symbol with no row defaults to no reserve.
    const reserveBySymbol = new Map<string, string | null>(
      (await scope.profileSymbols.listForProfile()).map((r) => [r.symbol, r.reserveBaseQuantity]),
    );

    for (const symbol of active.symbols) {
      if (only?.symbols && !only.symbols.includes(symbol)) continue;
      const infoRaw = await deps.redis.get(buildSymbolInfoKey(symbol, mode));
      if (infoRaw === null) {
        deps.logger.info(
          { userId: active.userId, profileId: active.profileId, symbol },
          'reconcileHeldQuantity: no cached symbolInfo; deferring to first cold-load',
        );
        continue;
      }
      let info: { baseAsset: string; filters: { stepSize: string } };
      try {
        info = JSON.parse(infoRaw) as typeof info;
      } catch {
        continue;
      }
      const bal = account.balances.find((b) => b.asset === info.baseAsset);
      // Drain the reserve from the wallet (free first, then locked) so the
      // reconcile + cost-basis steps below see only the tradeable surplus.
      const adjusted = reserveAdjustedBalance(
        new Decimal(bal?.free ?? '0'),
        new Decimal(bal?.locked ?? '0'),
        reserveBySymbol.get(symbol) ?? null,
      );
      const walletFree = adjusted.free.toFixed();
      const walletLocked = adjusted.locked.toFixed();

      // Serialise the whole per-symbol body (reconcile + revive) on the
      // same `(profileId, symbol)` key the tick handler and fill-adopter
      // hold. A user-stream `executionReport` can drive `fillAdopter.adopt`
      // on this slice during the boot window; without the lock the two
      // interleave read/migrate/write and one mutation is lost — exactly
      // the hazard `mutateSymbolState`'s contract names. Wrapping both
      // writes in one `chain.run` also keeps them atomic against that fill
      // rather than two separately-locked windows.
      const { action, reviveAction } = await deps.chain.run(
        `${unwrapId(active.profileId)}:${symbol}`,
        async () => {
          const symbolTarget: ReconcileSymbolTarget = {
            userId: active.userId,
            profileId: active.profileId,
            symbol,
            baseAsset: info.baseAsset,
            stepSize: info.filters.stepSize,
            walletFree,
            walletLocked,
          };
          // Seed the ledger from trade history FIRST so a held-but-unpriced
          // position (a fresh adopt, or a fill never observed) has a row for
          // the revive below to restore avgEntryPrice from.
          await ensureCostBasisFromTrades(deps, scope, positionAdapter, rest, symbolTarget);
          return reconcileSymbol(deps, scope, positionAdapter, symbolTarget);
        },
      );
      tally[action] += 1;
      reviveTally[reviveAction] += 1;
    }
  }
  return { heldQuantity: tally, avgEntryPriceRevival: reviveTally };
};
