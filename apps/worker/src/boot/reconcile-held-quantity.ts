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
import { isRateLimitError } from '@app/binance';
import type { BinanceMode, MyTradeDto, PriceTickerDto } from '@app/binance';

import { GLOBAL_KEYS, profileRepo, repo, type Database, type ProfileScope } from '@app/db';
import { unwrapId, type AccountId, type ProfileId, type UserId } from '@app/contracts';
import {
  isBelowMinNotional,
  isUnsellableDust,
  isValuelessResidue,
  type PositionStateAdapter,
} from '@app/strategy-core';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';
import { buildSymbolInfoKey } from 'executor/redis-namespace.js';
import type { ChainByKey } from 'lib/chain-by-key.js';
import type { MetricsSink } from 'metrics/catalog.js';
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
 * reconciler seeds it from the wallet whenever the wallet holds a
 * SELLABLE amount. A zero wallet with null state is a no-op.
 *
 * Sellable is `isUnsellableDust`'s answer, not a bare step comparison, and the two differ in the case that matters. A wallet crumb left by fee and step rounding can sit above one LOT_SIZE step while being worth far less than one minimum order, and seeding from it re-creates the very position the fill fold just flattened — the symbol then never leaves the operator's dashboard and no exit can ever close it. `referencePrice` supplies the valuation; when it is absent the value bound is skipped and the increment bound alone decides, which is the historical behaviour.
 */
export interface ReconcileInput {
  readonly heldQuantity: string | null;
  readonly walletFree: string;
  readonly walletLocked: string;
  readonly stepSize: string;
  readonly minNotional: string | null;
  readonly referencePrice: string | null;
  /** `free + locked` for the base asset BEFORE the operator's base-asset RESERVE was drained out of it, or null, which DISARMS the dust value bounds rather than substituting the reserve-adjusted total — the one number guaranteed to read a fully-reserved holding as worthless. Only the dust VALUE bounds read it, and only they should: a reserve is an operator policy about what the STRATEGY may trade, while `minNotional` is a fact about what the EXCHANGE will accept, so "is this holding real or is it residue?" has to be asked of the coins the operator actually owns. Sizing and adoption keep reading the reserve-adjusted `walletFree`/`walletLocked`, unchanged. Required-but-nullable, not optional: an omitted field is one a forwarding hop can drop silently, and a silently-dropped bound input is exactly how an earlier fix here shipped as a no-op. */
  readonly unreservedWalletTotal: string | null;
}

export type ReconcileAction =
  | 'no-op'
  | 'seed-from-wallet'
  | 'adopt-wallet-smaller'
  | 'adopt-state-smaller'
  | 'flatten-sub-notional-dust'
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
  const minNotional = input.minNotional == null ? null : safe(input.minNotional);
  const referencePrice = input.referencePrice == null ? null : safe(input.referencePrice);
  // Every VALUE bound below is asked of the operator's own balance, not of the slice the strategy is allowed to trade. The reserve is drained upstream, so `walletFree`/`walletLocked` already exclude coins the operator told the bot to hold and never sell; valuing that number would read a fully-reserved holding as dust and delete its cost basis over a figure the operator can undo by lowering the reserve.
  //
  // Null therefore DISARMS the bound rather than falling back, the same rule `referencePrice` and `minNotional` already follow and for the same reason: these bounds only ever REMOVE a position, so a missing input has to mean "do not act", never "act on whatever number is nearest". Here the nearest number is the worst one available — the reserve-adjusted balance is precisely the figure that reads a fully-reserved holding as dust, so a forwarding hop that dropped the field would re-arm the deletion this field exists to prevent.
  const unreserved = input.unreservedWalletTotal == null ? null : safe(input.unreservedWalletTotal);

  if (input.heldQuantity === null) {
    // Both bounds, and the crumb share test does not apply: there is no prior position to be a share OF, and seeding is precisely where a written-off crumb comes back. The fill fold flattens an unsellable residue; without this the very next reconcile pass reads the same untradeable balance off the wallet and re-creates the position, so the symbol never leaves the operator's dashboard. Refusing to seed can leave a genuinely-owned sub-notional balance untracked, which is the accepted cost: no strategy can place a sell for it either, so tracking it only manufactures a position nothing can close.
    if (
      wallet.lt(step) ||
      (unreserved !== null && isBelowMinNotional(unreserved, referencePrice, minNotional))
    ) {
      return { action: 'no-op', nextHeldQuantity: null };
    }
    return { action: 'seed-from-wallet', nextHeldQuantity: wallet.toFixed() };
  }

  const held = safe(input.heldQuantity);

  // Something is tracked, and BOTH the wallet behind it and the claim itself are worth a rounding error of one minimum order. Nothing downstream can act on that: no sell clears NOTIONAL, so the position can only sit on the dashboard claiming coins that will never move. It has to be answered HERE, ahead of the `diff.lte(step)` band, because the band is where such a position ends up: the reconciler pins `heldQuantity` to the wallet, held and wallet then agree exactly, and every later pass short-circuits on a difference of zero before any dust test is reached. That is the shape a strand converges to, and it is unrecoverable by construction rather than merely wrong.
  //
  // Testing the CLAIM as well as the wallet is what makes this destructive branch safe against a stale balance, and the asymmetry is the point: the caller reads `getAccount` once per profile, outside the per-symbol loop, while `heldQuantity` is read inside the per-symbol lock. So the wallet can be several REST round trips old and the claim cannot. A BUY that fills mid-sweep on a symbol that held dust at snapshot time would otherwise present as "wallet is dust, held is fresh" and this branch would delete the cost basis of a position bought seconds earlier. Requiring the claim to be valueless too sends that case down to `adopt-wallet-smaller`, which converges the quantity and leaves the cost basis intact. A converged strand is unaffected: held equals the wallet, so both are valueless together.
  //
  // An unparseable `heldQuantity` is NOT a claim and must not protect the row — it is treated as valueless, so a corrupt body over a dust wallet still flattens.
  //
  // A `heldQuantity` of exactly zero is the opposite case and must NOT flatten. `isValuelessResidue(0, …)` is trivially true, so without the `gt(0)` test every idle symbol carrying the very common "row exists, quantity zero" body would take this destructive arm instead of falling through to the `diff.lte(step)` no-op: a state write, a ledger DELETE, a warn reading "dropping its cost basis", and a `reconcile_position_removed_total` increment, for a symbol that never held a position. `valueBoundDisarmReason` already reads a zero claim this way; the two must agree, because `heldBefore` buckets it the same.
  //
  // The bound is `isValuelessResidue`, not `isUnsellableDust`: a converged position is its own denominator, so the share test computes exactly 1 and can never fire.
  if (
    unreserved !== null &&
    isValuelessResidue(unreserved, referencePrice, minNotional) &&
    (held === null || (held.gt(0) && isValuelessResidue(held, referencePrice, minNotional)))
  ) {
    return { action: 'flatten-sub-notional-dust', nextHeldQuantity: null };
  }

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
    // The tracked position is the denominator the crumb share test needs, so the full dust rule applies here: writing an untradeable crumb back would pin the symbol to a position no sell can ever close. But the two halves of that rule are asked of DIFFERENT balances, and handing both `wallet` is what the invariant above forbids.
    //
    // The INCREMENT half is legitimately an adjusted-balance question: no order can be placed for less than one step of the slice the strategy is allowed to trade, so a surplus under one step really is untradeable however much the operator reserves behind it.
    //
    // The VALUE half is not. `isUnsellableDust`'s closing clause is `isCrumb && isBelowMinNotional(remaining, …)`, and asked of `wallet` it reads a heavily-reserved holding as a crumb: 100 units at price 1 against a 99.5 reserve and a floor of 5 leaves a 0.5 surplus that is 0.5% of the claim and worth 0.5, so both tests pass and a position worth 100 is nulled over operator policy. The same inputs without the reserve are a plain no-op. So the value pair is asked of `unreserved`, like every other value bound in this module, with the claim still supplying the share denominator.
    if (
      wallet.lt(step) ||
      (unreserved !== null && isUnsellableDust(unreserved, held, referencePrice, null, minNotional))
    ) {
      return { action: 'adopt-wallet-smaller', nextHeldQuantity: null };
    }
    return { action: 'adopt-wallet-smaller', nextHeldQuantity: wallet.toFixed() };
  }
  return { action: 'adopt-state-smaller', nextHeldQuantity: held.toFixed() };
};

// Finite-only. `decimal.js` accepts `Infinity` and `NaN` as values rather than throwing, and a non-finite `minNotional` is the dangerous direction: every finite holding is "below" an infinite floor, so it would ARM the dust bounds against a real position instead of disarming them. Null is the safe answer for all of these inputs, since null disarms.
const safe = (raw: string): Decimal | null => {
  try {
    const parsed = new Decimal(raw);
    return parsed.isFinite() ? parsed : null;
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
  readonly minNotional: string | null;
  /** Latest cached quote-asset price, used only to value a wallet crumb against `minNotional`. Null when no ticker is cached, which skips the value bound rather than guessing. Required-but-nullable, not optional: an omitted field silently disarms the value bound, and dropping it in one forwarding hop is exactly how the first attempt at this fix stayed a no-op. */
  readonly referencePrice: string | null;
  readonly walletFree: string;
  readonly walletLocked: string;
  /** `free + locked` for the base asset BEFORE the operator's base-asset RESERVE was drained out of it, or null, which DISARMS the dust value bounds rather than substituting the reserve-adjusted total — the one number guaranteed to read a fully-reserved holding as worthless. Only the dust VALUE bounds read it, and only they should: a reserve is an operator policy about what the STRATEGY may trade, while `minNotional` is a fact about what the EXCHANGE will accept, so "is this holding real or is it residue?" has to be asked of the coins the operator actually owns. Sizing and adoption keep reading the reserve-adjusted `walletFree`/`walletLocked`, unchanged. Required-but-nullable, not optional: an omitted field is one a forwarding hop can drop silently, and a silently-dropped bound input is exactly how an earlier fix here shipped as a no-op. */
  readonly unreservedWalletTotal: string | null;
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
  /**
   * DELETE the `avg_entry_prices` row for the given symbol. Only the sub-notional flatten calls it, and it MUST: that flatten is the reconciler asserting the position does not exist, so leaving the ledger row behind would let the very next boot revive rehydrate the cost basis it just erased. Routed to `scope.avgEntryPrices.remove(symbol)` in production, the same sink the phantom-ledger prune uses.
   *
   * @param userId - Operator the row belongs to, carried for the caller's own scoping/logging.
   * @param profileId - Profile the row belongs to, carried for the caller's own scoping/logging.
   * @param symbol - Market whose cost-basis row is to be removed.
   * @returns Resolves once the delete has been issued.
   */
  readonly removeLedgerRow: (userId: string, profileId: string, symbol: string) => Promise<void>;
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
    minNotional: target.minNotional,
    referencePrice: target.referencePrice,
    unreservedWalletTotal: target.unreservedWalletTotal,
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
    minNotional: target.minNotional,
    referencePrice: target.referencePrice,
    unreservedWalletTotal: target.unreservedWalletTotal,
    action: result.action,
  };

  // A flatten is a DELETE, not an adjustment, so it takes the fill-adopter's own full-exit primitive rather than `setHeldQuantity(null)`. `clearPosition` is not enough either: it leaves `heldQuantity` set, and a body carrying a held quantity with no cost basis is precisely the shape that makes the cost-basis adoption no-op on it forever. `applyFill({kind:'empty'})` is the one call that empties both, and every strategy's position adapter implements it identically for exactly that reason.
  //
  // State first, ledger second, deliberately: the two writes are not atomic, and a crash between them must leave the recoverable half behind. Losing the delete leaves a ledger row with a cleared state, which the next pass prunes AS LONG AS it can price the symbol — with `referencePrice` null every value bound stands down, so that pass instead re-seeds from the wallet and revives from the row, re-creating the strand. The miniTicker cache alone could not carry that: its keys hold a 60s TTL and only the live market stream writes them, so any restart longer than a minute used to land in exactly that state and wait for the periodic backstop cron to run once the stream had refilled the cache. `resolveSweepPrices` now falls back to one batched REST call for whatever the cache is missing, so the recovering pass prices the symbol itself and prunes on the spot; the wait returns only for a symbol Binance will not price at all. Losing the clear is the worse half and stays the reason for this order: a state claim with no ledger row to heal it makes the revive no-op on it forever.
  //
  // No `archive-grid-trade` is enqueued, matching the phantom prune. A flatten is the reconciler asserting the position never existed, not a cycle closing: there is no exit fill, no proceeds, and no realised P/L, so archiving one would write a phantom row into Trade History.
  if (result.action === 'flatten-sub-notional-dust') {
    deps.logger.warn(
      logCtx,
      'reconcileHeldQuantity: wallet backs the position with sub-notional residue only; flattening and dropping its cost basis',
    );
    await deps.mutate(target.symbol, (live) => deps.position.applyFill(live, { kind: 'empty' }));
    await deps.removeLedgerRow(target.userId, target.profileId, target.symbol);
    return result.action;
  }
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
  /**
   * Last traded price for a batch of symbols. Required, not optional: it is the ONLY price source at cold boot, and an optional method is the one a stub omits — which would silently restore the disarmed bounds this exists to fix.
   *
   * @param symbols - The symbols the caller could not price from the live cache.
   * @returns One row per symbol Binance recognised, keyed on `symbol` rather than position.
   */
  getPriceTickers(symbols: readonly string[]): Promise<readonly PriceTickerDto[]>;
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
  /**
   * Required, not optional. The two counters below are the only machine-readable evidence that a position was deleted or that a value bound went unenforced, so a sink a caller may omit is a signal that reads exactly like a working one while emitting nothing. Required makes the omission a compile error at the construction site instead of silence in Prometheus.
   */
  readonly metrics: MetricsSink;
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
 * Latest cached price for `symbol`, or null when there is none to trust.
 *
 * Deliberately total: a missing key, malformed JSON, or a non-positive price all yield null, and null skips the value bound in {@link isUnsellableDust}. The bound only ever REMOVES a position, so guessing a price here could flatten a real one, while returning null merely restores the older increment-only behaviour.
 *
 * @param redis - Connection holding the worker's miniTicker price cache.
 * @param symbol - Trading pair whose cached price is wanted.
 * @returns The decimal price string, or null when absent, unparseable, or not positive.
 */
export const readTickerPrice = async (redis: Redis, symbol: string): Promise<string | null> => {
  const raw = await redis.get(GLOBAL_KEYS.ticker(symbol));
  if (raw === null) return null;
  try {
    const price = (JSON.parse(raw) as { price?: unknown }).price;
    if (typeof price !== 'string') return null;
    // `.gt(0)` alone accepts `'Infinity'`, which every finite holding is "below": it would arm the value bounds against a real position rather than disarm them.
    const parsed = new Decimal(price);
    return parsed.isFinite() && parsed.gt(0) ? price : null;
  } catch {
    return null;
  }
};

/**
 * Which input a dust VALUE bound was missing on a pass that actually reached one.
 *
 * Named per input because the remedies differ: no price is a cold miniTicker cache or a failed REST fallback, no NOTIONAL filter is a stale exchange-info refresh, and no pre-reserve total is a forwarding hop that dropped the field.
 */
export const VALUE_BOUND_DISARM_REASONS = [
  'no-reference-price',
  'no-min-notional',
  'no-unreserved-total',
] as const;

export type ValueBoundDisarmReason = (typeof VALUE_BOUND_DISARM_REASONS)[number];

/**
 * Whether this pass consulted a dust value bound it could not evaluate.
 *
 * The bounds standing down on a missing input is correct and stays: they only ever DELETE a position, so an absent input has to mean "do not act". What is wrong is that standing down is invisible — a disarmed pass tallies the same `no-op` as a healthy converged one, so "checked, the holding is real" and "could not check" are indistinguishable from outside, and a symbol can sit unprotected for weeks while its sweep reports success.
 *
 * Reported only when there was something a bound could have acted on. A symbol with no claim and an empty wallet reaches no bound at all, and counting it would emit one series per idle symbol per boot and bury the case this exists to surface.
 *
 * @param input - The same wallet, claim, and bound inputs {@link reconcileHeldQuantity} is about to judge.
 * @returns The first missing input, or null when the bounds were fully armed or never reached.
 */
export const valueBoundDisarmReason = (input: {
  readonly heldQuantity: string | null;
  readonly walletFree: string;
  readonly walletLocked: string;
  readonly minNotional: string | null;
  readonly referencePrice: string | null;
  readonly unreservedWalletTotal: string | null;
}): ValueBoundDisarmReason | null => {
  const wallet = walletTotal(input);
  // The claim is tested by VALUE, matching how `heldBefore` buckets it, because a body storing `heldQuantity: '0'` is a shape this repo really produces and a nullness test reads it as a live position. That would report a disarm and warn for every idle zero-claim symbol on any pass without a price, which is exactly the noise this function's "only when a bound could have acted" rule exists to prevent. An UNPARSEABLE claim stays reportable: a bound could not judge that either, and silence would hide it.
  const claim = input.heldQuantity === null ? null : safe(input.heldQuantity);
  const claimIsLive = input.heldQuantity !== null && (claim === null || claim.gt(0));
  if (!claimIsLive && (wallet === null || wallet.lte(0))) return null;
  // Each input is judged the way `reconcileHeldQuantity` judges it, not merely for nullness, because a present-but-unusable value disarms the bound just as completely as a missing one and is harder to notice. `safe` rejects a non-finite string, and `isBelowMinNotional` skips on a non-positive price or floor exactly as it skips on a null one — so a `minNotional` of `'Infinity'` or a `referencePrice` of `'0'` would otherwise stand every bound down while this function reported a clean pass, which is precisely the blind spot the counter exists to close. A zero `unreservedWalletTotal` is NOT such a case: an empty wallet is a real answer the bound acts on.
  const price = input.referencePrice === null ? null : safe(input.referencePrice);
  if (price === null || price.lte(0)) return 'no-reference-price';
  const floor = input.minNotional === null ? null : safe(input.minNotional);
  if (floor === null || floor.lte(0)) return 'no-min-notional';
  if (input.unreservedWalletTotal === null || safe(input.unreservedWalletTotal) === null) {
    return 'no-unreserved-total';
  }
  return null;
};

/**
 * Latest price per symbol for one profile's sweep: the live miniTicker cache first, then ONE batched REST call for whatever it did not hold.
 *
 * Redis first because it is free, fresher, and already the price every tick runs on. REST second because that cache is written only by the market stream and its keys expire in 60s, so at cold boot — the exact moment this sweep runs — it is empty for every symbol and every dust value bound stands down on the one pass that most needs them armed.
 *
 * One call for the whole miss list, not one per symbol: the per-IP weight budget is shared across every account on the host. But a single batch is also a single blast radius, and Binance's documentation does not state what the batch form does with a member it does not list — a symbol this repo can genuinely hold, because a delisted pair stays bound and the tick self-heals rather than unbinding it. If an unknown member rejects the whole request, one such pair would leave EVERY symbol on that profile unpriced on every pass, which is precisely the disarmed-bound strand this resolver exists to repair. So the batch is the happy path only: on any throw each missing symbol is retried on its own (weight 4 each — `getPriceTickers` always emits the batch `symbols=[…]` form, which Binance charges at the batch tier regardless of length; the weight-2 tier is the single `symbol=` form this client never sends), and only the genuinely unanswerable one stays unpriced. A throttle is excluded from that fallback: see below.
 *
 * A symbol no call could price is left absent, which restores the stand-down rather than substituting a guess.
 *
 * @param deps - Orchestrator deps, for the Redis handle and the logger a failed fallback warns through.
 * @param rest - This profile's Binance client, already resolved and mode-correct.
 * @param symbols - The symbols this pass will actually visit, so a narrowed sweep does not price the rest of the profile.
 * @returns Symbol to decimal price string, carrying an entry only for symbols a positive price was found for.
 */
export const resolveSweepPrices = async (
  deps: Pick<ReconcileOrchestratorDeps, 'redis' | 'logger'>,
  rest: BinanceAccountClient,
  symbols: readonly string[],
): Promise<ReadonlyMap<string, string>> => {
  const prices = new Map<string, string>();
  const missing: string[] = [];
  for (const symbol of symbols) {
    const cached = await readTickerPrice(deps.redis, symbol);
    if (cached === null) missing.push(symbol);
    else prices.set(symbol, cached);
  }
  if (missing.length === 0) return prices;
  // The same positivity bar the cache read applies. A zero or unparseable price would not disarm a bound, it would ARM one with a number that reads every holding as worthless.
  const accept = (row: { symbol: string; price: string }): void => {
    const price = safe(row.price);
    if (price !== null && price.gt(0)) prices.set(row.symbol, row.price);
  };
  try {
    for (const row of await rest.getPriceTickers(missing)) accept(row);
    return prices;
  } catch (err) {
    // The fallback repairs ONE failure shape — an unlisted member poisoning the batch — but `catch` cannot tell that from a 429/418, and those are exactly the errors a fan-out makes worse: a 60-symbol profile that tripped the IP weight budget on one batch would answer it with 60 more calls at weight 4 apiece, deepening the throttle while the governor is trying to drain. Bailing costs one pass of disarmed bounds; the ban costs every pass.
    if (isRateLimitError(err)) {
      deps.logger.warn(
        { err, symbols: missing },
        'reconcileHeldQuantity: rate limited on the batched price fetch; skipping the per-symbol retry so the dust value bounds stand down for one pass rather than deepening the throttle',
      );
      return prices;
    }
    deps.logger.warn(
      { err, symbols: missing },
      'reconcileHeldQuantity: batched price fetch failed; retrying each symbol alone so one bad pair cannot disarm the rest',
    );
  }
  for (const symbol of missing) {
    try {
      for (const row of await rest.getPriceTickers([symbol])) accept(row);
    } catch (err) {
      deps.logger.warn(
        { err, symbol },
        'reconcileHeldQuantity: could not price this symbol; its dust value bounds stand down',
      );
    }
  }
  return prices;
};

/**
 * The three wallet figures a {@link ReconcileSymbolTarget} carries, derived in one place so the boot sweep and the mid-run reconfigure door cannot answer the same question differently.
 *
 * Two balances, not one, because they serve opposite purposes. `walletFree`/`walletLocked` are reserve-ADJUSTED: sizing and adoption may see only the tradeable surplus, so a fully-reserved holding reconciles flat and the strategy trades on top of it. `unreservedWalletTotal` is RAW, and this is the last point at which the operator's real balance still exists — a reserve is operator policy about what the STRATEGY may trade, while `minNotional` is a fact about what the EXCHANGE will accept, so the dust VALUE bounds have to ask "is this residue?" of the coins the operator actually owns. Handing them the adjusted total instead reads a deeply-reserved holding as worthless and deletes a real position.
 *
 * Both legs are parsed through `safe`, never `new Decimal` directly. This runs in the per-symbol loop of {@link runHeldQuantityReconciliation}, where the only `try` covers `getAccount` itself, so a throw here would abort the sweep for every remaining symbol AND every remaining profile over one malformed balance string. A bad leg therefore disarms rather than throws, which is the rule the rest of this module already follows.
 *
 * An unparseable leg is passed through UNCHANGED rather than defaulted to `'0'`, because zero is a real answer: it reads as an empty wallet, and an empty wallet is what arms the phantom prune. Handing the raw value on lets `reconcileHeldQuantity`'s own parse guard return `no-op` and write nothing. `unreservedWalletTotal` goes null on the same input, which disarms the dust value bounds and is reported by {@link valueBoundDisarmReason}.
 *
 * @param balance - The account balance row for this symbol's base asset, absent when Binance reports no holding at all, which counts as zero rather than as unknown.
 * @param reserve - The per-symbol floor the operator wants held back, or null when the symbol carries no reserve row.
 * @returns The reserve-adjusted free and locked legs plus the pre-reserve total; on an unparseable or non-finite leg, the legs are returned verbatim and the total is null.
 */
export const resolveWalletFields = (
  balance: { free: string; locked: string } | undefined,
  reserve: string | null,
): Pick<ReconcileSymbolTarget, 'walletFree' | 'walletLocked' | 'unreservedWalletTotal'> => {
  const rawFree = balance?.free ?? '0';
  const rawLocked = balance?.locked ?? '0';
  const free = safe(rawFree);
  const locked = safe(rawLocked);
  if (free === null || locked === null) {
    return { walletFree: rawFree, walletLocked: rawLocked, unreservedWalletTotal: null };
  }
  const adjusted = reserveAdjustedBalance(free, locked, reserve);
  return {
    walletFree: adjusted.free.toFixed(),
    walletLocked: adjusted.locked.toFixed(),
    unreservedWalletTotal: free.plus(locked).toFixed(),
  };
};

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
  readonly minNotional: string | null;
  /** Latest cached quote-asset price, used only to value a wallet crumb against `minNotional`. Null when no ticker is cached, which skips the value bound rather than guessing. Required-but-nullable, not optional: an omitted field silently disarms the value bound, and dropping it in one forwarding hop is exactly how the first attempt at this fix stayed a no-op. */
  readonly referencePrice: string | null;
  readonly walletFree: string;
  readonly walletLocked: string;
  /** `free + locked` for the base asset BEFORE the operator's base-asset RESERVE was drained out of it, or null, which DISARMS the dust value bounds rather than substituting the reserve-adjusted total — the one number guaranteed to read a fully-reserved holding as worthless. Only the dust VALUE bounds read it, and only they should: a reserve is an operator policy about what the STRATEGY may trade, while `minNotional` is a fact about what the EXCHANGE will accept, so "is this holding real or is it residue?" has to be asked of the coins the operator actually owns. Sizing and adoption keep reading the reserve-adjusted `walletFree`/`walletLocked`, unchanged. Required-but-nullable, not optional: an omitted field is one a forwarding hop can drop silently, and a silently-dropped bound input is exactly how an earlier fix here shipped as a no-op. */
  readonly unreservedWalletTotal: string | null;
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

  const referencePrice = target.referencePrice == null ? null : safe(target.referencePrice);
  const minNotional = target.minNotional == null ? null : safe(target.minNotional);
  const unreserved = unreservedTotal(target);
  const valueLogCtx = {
    userId: unwrapId(target.userId),
    profileId: unwrapId(target.profileId),
    symbol: target.symbol,
    walletFree: target.walletFree,
    walletLocked: target.walletLocked,
    unreservedWalletTotal: target.unreservedWalletTotal,
    minNotional: target.minNotional,
    referencePrice: target.referencePrice,
  };

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
    // Gated at the RESIDUE bar, not at the full floor, and the difference is a disposal that cannot recover. Seeding from a ledger row is not creating a position out of nothing: the row is a durable statement that the position EXISTS, so refusing to seed it abandons a known position, which is delete-grade harm and earns the delete-grade bar. A handoff target holding USD 4 against a USD 5 floor is a real position; refuse it at the full floor and `assertTargetSeeded` throws, the disposal retries, refuses again, and dead-letters with the source already disabled and its orders cancelled.
    //
    // The row is DELETED here rather than left for the phantom prune, because the prune provably cannot reach it. This branch runs only when there is no state body at all, and that is the normal shape of a handoff target, not an edge: a disposal moves `profile_symbols` and `avg_entry_prices` and never `symbol_states`. The reviver returns early on a non-object state before it ever consults its value bound, so a row declined here would survive every later pass and block the next disposal's seeding check forever. A symbol with NO ledger row is explicitly a legal, non-blocking state for that check, so deleting is what makes this branch's own claim true rather than an appeal to a pass that will not run.
    if (unreserved !== null && isValuelessResidue(unreserved, referencePrice, minNotional)) {
      await scope.avgEntryPrices.remove(target.symbol);
      deps.logger.info(
        valueLogCtx,
        'ensureCostBasis: cost-basis row is backed only by sub-notional residue; deleted it instead of seeding a position from it',
      );
      return 'no-op';
    }
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

  // Nothing durable says this position exists, so the walk below would CREATE one out of a wallet balance alone — and the increment is only half of what makes a balance tradeable. A balance can be several LOT_SIZE steps wide and still be worth a fraction of one minimum order, in which case no strategy can ever place a sell for it and adopting it manufactures a position nothing can close: the symbol keeps its slot on the dashboard, the entry gate believes it is already in a trade, and every later reconcile pass finds a held quantity matching the wallet and no reason to touch it. Refusing costs an untracked balance the bot could not have traded anyway.
  //
  // The full `minNotional` here, against the residue bar on the ledger branch above, because the two branches carry opposite risks: declining to create a position out of nothing costs a blind spot, while declining to seed a row that already exists abandons a position someone recorded.
  if (unreserved !== null && isBelowMinNotional(unreserved, referencePrice, minNotional)) {
    deps.logger.info(
      valueLogCtx,
      'ensureCostBasis: wallet balance is worth less than one minimum order; refusing to adopt it as a position',
    );
    return 'no-op';
  }

  let reconstructed: ReturnType<typeof openPositionFromFills>;
  try {
    // limit 1000 (Binance max) widens the window so the average-cost walk
    // accounts for as much of the position's lifetime as one call allows.
    const fills = await client.getMyTrades({ symbol: target.symbol, limit: 1000 });
    // Cap at the wallet: the walk can only ever over-state what is open (a truncated 1000-fill window drops the sells that closed the earliest lots), and a ledger row is allowed to price the position but never to claim coins the account does not hold.
    reconstructed = openPositionFromFills(fills, target.baseAsset, wallet);
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

/**
 * The balance the dust VALUE bounds are entitled to judge: the operator's own holding, before their base-asset reserve was drained out of the bot's view.
 *
 * @param target - Any reconcile target carrying the pre-reserve total, when the caller could separate it from the reserve.
 * @returns The pre-reserve `free + locked` as a Decimal, or null when the target carries no usable figure — on which every bound reading it stands down rather than substituting the reserve-adjusted balance, the one number guaranteed to mis-classify a reserved holding.
 */
const unreservedTotal = (target: { unreservedWalletTotal: string | null }): Decimal | null =>
  target.unreservedWalletTotal == null ? null : safe(target.unreservedWalletTotal);

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
  deps: Pick<ReconcileOrchestratorDeps, 'logger' | 'symbolStateDeps' | 'metrics'>,
  scope: Awaited<ReturnType<typeof profileRepo>>,
  position: PositionStateAdapter,
  target: ReconcileSymbolTarget,
): Promise<ReconcileSymbolResult> => {
  const row = await scope.symbolStates.findBySymbol(target.symbol);
  let currentState: unknown = row?.state ?? null;
  // The claim as it stood BEFORE the reconciler pinned it to the wallet. The prune's value half needs it and the post-reconcile `heldQuantity` cannot serve: by then it has been overwritten with the stale wallet's own verdict, so testing it would just ask the same number twice.
  const preReconcileHeldQuantity =
    row?.state && typeof row.state === 'object'
      ? (position.readPosition(row.state)?.heldQuantity ?? null)
      : null;
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

  // One sink for both deletes. The reconciler's sub-notional flatten and the reviver's phantom prune are the same assertion — nothing backs this position — reached from two directions, so they must not be able to drift onto different rows.
  const removeLedgerRow = async (_u: string, _p: string, sym: string): Promise<void> => {
    await scope.avgEntryPrices.remove(sym);
  };

  const action = await reconcileHeldQuantityForTarget(
    { logger: deps.logger, mutate, position, removeLedgerRow },
    {
      userId: unwrapId(target.userId),
      profileId: unwrapId(target.profileId),
      symbol: target.symbol,
      baseAsset: target.baseAsset,
      stepSize: target.stepSize,
      minNotional: target.minNotional,
      referencePrice: target.referencePrice,
      walletFree: target.walletFree,
      walletLocked: target.walletLocked,
      unreservedWalletTotal: target.unreservedWalletTotal,
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
      removeLedgerRow,
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
      minNotional: target.minNotional,
      referencePrice: target.referencePrice,
      unreservedWalletTotal: target.unreservedWalletTotal,
      preReconcileHeldQuantity,
    },
  );

  const labels = { profileId: unwrapId(target.profileId), symbol: target.symbol };
  // Bucketed, never the raw quantity: the operational question is whether the bot deleted a position it BELIEVED it held or merely converged a row that was already empty. The first is a page and the second is routine, and a quantity label would put an unbounded value space on a counter for a two-state distinction.
  //
  // An UNPARSEABLE claim buckets as `nonzero`, matching `valueBoundDisarmReason`. Both read the same field and must read it the same way: `reconcileHeldQuantity` flattens over a corrupt body rather than letting it protect the row, so a garbage claim really is a position being deleted. Reading it as `zero` would label that delete routine convergence and drop it from the alert's `heldBefore="nonzero"` gate, which is the one filter standing between a real delete and silence.
  const preClaim = preReconcileHeldQuantity === null ? null : safe(preReconcileHeldQuantity);
  const heldBefore =
    preReconcileHeldQuantity !== null && (preClaim === null || preClaim.gt(0)) ? 'nonzero' : 'zero';
  // Zero-seed BEFORE any increment below, and unconditionally. A prom-client child does not exist until its first write and is born holding that write's value, so an unseeded labelled counter's first incident appears as a series that has always read 1 — which `increase()` reads as no change, and every rule over it stays silent forever. That is not theoretical here: after a flatten the residue is sub-notional and `heldQuantity` is null, so the next pass takes the `no-op` arm and no second increment ever arrives to make the rise visible. Seeding in the same pass is enough because the child only has to exist at 0 immediately before the increment lands on it.
  //
  // Both `action` values are seeded because the two deletes are reached from opposite directions and either may be the first this symbol ever sees. `heldBefore` is the value this pass computed rather than both buckets: the increment below carries that same value, so the child the counter is about to touch is the one seeded.
  for (const removal of ['flatten-sub-notional-dust', 'prune-phantom-ledger'] as const) {
    deps.metrics.record('reconcile_position_removed_total', 0, {
      ...labels,
      action: removal,
      heldBefore,
    });
  }
  for (const reason of VALUE_BOUND_DISARM_REASONS) {
    deps.metrics.record('reconcile_value_bound_disarmed_total', 0, { ...labels, reason });
  }
  // Both deletes, counted at one site. The flatten and the phantom prune are the same assertion — nothing backs this position — reached from two directions, and each drops a cost basis. Until now their only trace was a warn inside a boot's worth of them, which no alert rule can watch.
  if (action === 'flatten-sub-notional-dust') {
    deps.metrics.record('reconcile_position_removed_total', 1, { ...labels, action, heldBefore });
  }
  if (reviveAction === 'prune-phantom-ledger') {
    deps.metrics.record('reconcile_position_removed_total', 1, {
      ...labels,
      action: reviveAction,
      heldBefore,
    });
  }
  const disarmed = valueBoundDisarmReason({
    heldQuantity: preReconcileHeldQuantity,
    walletFree: target.walletFree,
    walletLocked: target.walletLocked,
    minNotional: target.minNotional,
    referencePrice: target.referencePrice,
    unreservedWalletTotal: target.unreservedWalletTotal,
  });
  if (disarmed !== null) {
    deps.metrics.record('reconcile_value_bound_disarmed_total', 1, {
      ...labels,
      reason: disarmed,
    });
    deps.logger.warn(
      { ...labels, reason: disarmed, action, reviveAction },
      'reconcileHeldQuantity: dust value bounds stood down for this symbol; a no-op here is not evidence the position is sound',
    );
  }
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
    'flatten-sub-notional-dust': 0,
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

    const sweptSymbols = active.symbols.filter(
      (symbol) => !only?.symbols || only.symbols.includes(symbol),
    );
    // One resolution for the whole profile, ahead of the loop, so the REST fallback is a single batched call rather than one per symbol.
    const priceBySymbol = await resolveSweepPrices(deps, rest, sweptSymbols);

    for (const symbol of sweptSymbols) {
      const infoRaw = await deps.redis.get(buildSymbolInfoKey(symbol, mode));
      if (infoRaw === null) {
        deps.logger.info(
          { userId: active.userId, profileId: active.profileId, symbol },
          'reconcileHeldQuantity: no cached symbolInfo; deferring to first cold-load',
        );
        continue;
      }
      let info: { baseAsset: string; filters: { stepSize: string; minNotional?: string } };
      try {
        info = JSON.parse(infoRaw) as typeof info;
      } catch {
        continue;
      }
      const { walletFree, walletLocked, unreservedWalletTotal } = resolveWalletFields(
        account.balances.find((b) => b.asset === info.baseAsset),
        reserveBySymbol.get(symbol) ?? null,
      );
      // Values a wallet crumb against `minNotional`. Best-effort: a symbol neither the live cache nor the REST fallback could price leaves this null, which skips the value bound rather than letting a bad price flatten a real position.
      const referencePrice = priceBySymbol.get(symbol) ?? null;

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
            minNotional: info.filters.minNotional ?? null,
            referencePrice,
            walletFree,
            walletLocked,
            unreservedWalletTotal,
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
