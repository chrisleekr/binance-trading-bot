// LiveExecutor: applies a list of Decisions against live infrastructure.
//
// Implements `Executor` from @app/strategy-core. Exhaustive `never`-switch
// enforces that every Decision variant is handled by a per-decision
// module under `decisions/`. The dispatcher composes per-decision deps
// once and forwards them to each handler — handler bodies remain pure
// w.r.t. closure capture so they can be unit-tested with stub deps.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type {
  Decision,
  DecisionResult,
  ExecutorContext,
  TickExecutorContext,
  StrategyRegistry,
} from '@app/strategy-core';
import type { NotifyProviderRegistry } from '@app/notify';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { ProfileScope } from '@app/db';
import { type BinanceMode, type BinanceRestClient } from '@app/binance';

import { createCancelLedger } from 'executor/cancel-ledger.js';
import { createPlacementDedup, type PlacementDedup } from 'executor/placement-dedup.js';
import { DEFAULT_WEIGHT_TTL } from 'executor/weight-limiter.js';
import {
  createNotifierGapThrottle,
  createUnfundableThrottle,
  type NotifierGapThrottle,
} from 'executor/notifier-gap-throttle.js';
import { cancelOrderHandler } from 'executor/decisions/cancel-order.js';
import { deleteKvHandler } from 'executor/decisions/delete-kv.js';
import { emitEventHandler } from 'executor/decisions/emit-event.js';
import { placeOrderHandler } from 'executor/decisions/place-order.js';
import { setKvHandler } from 'executor/decisions/set-kv.js';
import type { DecisionDeps } from 'executor/decisions/_types.js';
import type { ProfilePersistence } from 'profile-bindings/persistence.js';
import type { ProfileResolved } from 'profile-bindings/resolved-config.js';

/**
 * `quoteAsset` + `weightLimit1m` are the {@link ProfileResolved} config scalars
 * the tick already resolved; `mode` / `binance` / `persistence` are the
 * fresh-read parts a bindings build always reconstructs.
 */
export interface ProfileExecutorBindings extends ProfileResolved {
  readonly mode: BinanceMode;
  readonly binance: BinanceRestClient;
  readonly persistence: ProfilePersistence;
}

export interface LiveExecutorDeps {
  readonly redis: Redis;
  readonly notifyRegistry: NotifyProviderRegistry;
  readonly strategies: StrategyRegistry;
  readonly logger: Logger;
  /** Public "Live demo" mode: suppresses all emergency notifier dispatch. */
  readonly liveDemo?: boolean;
  readonly clock?: { nowMs(): number };
  /**
   * `scope` is the caller's already-proven ownership token. The tick path
   * proves it once when building its context and passes it through, so the
   * bindings build skips a redundant `scopeProfile` query per tick. Callers
   * without one (the standalone `apply`) omit it and the resolver proves
   * ownership itself.
   *
   * `resolved` carries the profile-config scalars the same tick already read;
   * when present the bindings build skips a redundant `profile.findById`.
   * `mode` is NOT in it — it stays a fresh read (binance_mode is mutable).
   */
  readonly resolveProfile: (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
    scope?: ProfileScope,
    resolved?: ProfileResolved,
  ) => Promise<ProfileExecutorBindings | null>;
  readonly weightTtlSeconds?: number;
  /**
   * Throttle for the notifier-gap action_log trace. Its per-(profile, topic)
   * suppression window lives in Redis, so the verdict is fleet-wide (one trace
   * per window across every pod); defaults to an hourly window when omitted.
   */
  readonly notifierGapThrottle?: NotifierGapThrottle;
  /** Fleet-wide suppression window for the `order-unfundable` alert; defaults to hourly per (profile, symbol). */
  readonly unfundableThrottle?: NotifierGapThrottle;
  /**
   * In-process duplicate-MARKET-placement guard. Injected mainly so integration
   * tests can hold a reference and clear it between cases (via `forgetSymbol`);
   * defaults to a fresh one per executor.
   */
  readonly placementDedup?: PlacementDedup;
  /**
   * Defers a converge-to-exchange-truth pass onto the `symbol-reconcile` queue.
   * Handlers that discover a fill the user stream never delivered call it; they
   * cannot adopt inline because they run under the tick's per-(profile, symbol)
   * chain lock, which the adopter also takes. Optional so tests compose an
   * executor without a queue.
   */
  readonly enqueueSymbolReconcile?: DecisionDeps['enqueueSymbolReconcile'];
}

export interface AppliedDecision {
  readonly decision: Decision;
  readonly result: DecisionResult;
}

/**
 * A single tick emitted more than one place-order. The retry model cannot
 * express partial-placement progress: a failed apply leaves the (profile,
 * symbol) slice un-advanced, so the next tick re-emits the WHOLE decision array
 * and re-places any order that already landed — a real-money double order.
 * `applyAll` throws this BEFORE transmitting anything. The throw is
 * deterministic (the same decision array recomputes every tick), so the queue
 * dead-letters it for a human rather than doubling an order on retry. Name and
 * shape mirror `SymbolDelistedError`.
 */
export class MultiPlacementError extends Error {
  readonly profileId: string;
  readonly placements: number;
  constructor(profileId: string, placements: number) {
    super(
      `applyAll: profile ${profileId} emitted ${placements} place-order decisions in one tick; refusing to apply (retry model cannot express partial-placement progress)`,
    );
    this.name = 'MultiPlacementError';
    this.profileId = profileId;
    this.placements = placements;
  }
}

export interface LiveExecutor {
  /**
   * Apply one decision. `accountId` is passed alongside `ctx` (rather than on
   * it) because the strategy-core `ExecutorContext` is provider-agnostic and
   * carries only `userId`/`profileId`; the per-account Redis namespace and
   * credential resolution key on this `accountId`.
   *
   * `emit-event` is excluded: this path has no emitting strategy on `ctx`
   * (pipeline handlers pass only `cancel-order`), and `emit-event` needs one to
   * resolve its topic/schema. Only `applyAll` (the tick path, which carries a
   * `TickExecutorContext`) may dispatch `emit-event`.
   */
  apply(
    ctx: ExecutorContext,
    accountId: AccountId,
    decision: Exclude<Decision, { type: 'emit-event' }>,
  ): Promise<DecisionResult>;
  applyAll(
    ctx: TickExecutorContext,
    accountId: AccountId,
    decisions: readonly Decision[],
    scope?: ProfileScope,
    resolved?: ProfileResolved,
  ): Promise<readonly AppliedDecision[]>;
}

/**
 * Result stamped on every decision the chain refused to attempt after an earlier
 * order failed.
 *
 * `pre-call` + `retryable` because NOTHING WAS TRANSMITTED: re-issuing this
 * decision is provably safe, and the condition that skipped it (a sibling order
 * that failed) is exactly the kind that clears. That pair is what the retry
 * predicate reads, so a skipped decision keeps both the strategy's own retry (the
 * tick leaves its state un-advanced) and an operator override alive. Stamping it
 * non-retryable instead would silently EAT an override: momentum's force-sell
 * emits [cancel(stop), SELL], and a transiently-failed cancel would consume the
 * override on a SELL that was never even attempted.
 */
const SKIPPED: DecisionResult = {
  ok: false,
  retryable: true,
  phase: 'pre-call',
  reason: 'skipped: an earlier order in this tick failed',
};

export const createLiveExecutor = (deps: LiveExecutorDeps): LiveExecutor => {
  const baseDeps = {
    redis: deps.redis,
    logger: deps.logger,
    clock: deps.clock ?? { nowMs: () => Date.now() },
    weightTtlSeconds: deps.weightTtlSeconds ?? DEFAULT_WEIGHT_TTL,
    notifyRegistry: deps.notifyRegistry,
    ...(deps.liveDemo ? { liveDemo: true } : {}),
    strategies: deps.strategies,
    notifierGapThrottle:
      deps.notifierGapThrottle ??
      createNotifierGapThrottle({ redis: deps.redis, logger: deps.logger }),
    unfundableThrottle:
      deps.unfundableThrottle ??
      createUnfundableThrottle({ redis: deps.redis, logger: deps.logger }),
    // One long-lived instance per executor (process), so a MARKET clientOrderId
    // recorded on one tick is visible to the next — the whole point is
    // cross-tick dedup. The Redis dep mirrors each record durably so a BullMQ
    // retry on a FRESH process (after a SIGTERM drain outran its deadline and the
    // pod was killed mid-tick) still sees the prior placement. Injectable so tests
    // can hold a reference and clear it.
    placementDedup:
      deps.placementDedup ??
      createPlacementDedup(undefined, { redis: deps.redis, logger: deps.logger }),
    // Spread only when supplied: `exactOptionalPropertyTypes` rejects an explicit
    // `undefined` on the optional dep.
    ...(deps.enqueueSymbolReconcile ? { enqueueSymbolReconcile: deps.enqueueSymbolReconcile } : {}),
  } satisfies Omit<DecisionDeps, 'resolveProfile' | 'accountId' | 'cancelLedger'>;

  // Dispatch for every decision that needs no emitting strategy on `ctx`. Takes
  // the base `ExecutorContext`, so both the no-strategy `apply` path and the
  // tick path can reach it. `emit-event` is excluded here — it rides `applyTick`
  // where the context is proven to carry a `strategyName`.
  const applyBase = async (
    deps: DecisionDeps,
    ctx: ExecutorContext,
    decision: Exclude<Decision, { type: 'emit-event' }>,
  ): Promise<DecisionResult> => {
    switch (decision.type) {
      case 'noop':
        return { ok: true };
      case 'place-order':
        return placeOrderHandler(deps, ctx, decision);
      case 'cancel-order':
        return cancelOrderHandler(deps, ctx, decision);
      case 'set-kv':
        return setKvHandler(deps, ctx, decision);
      case 'delete-kv':
        return deleteKvHandler(deps, ctx, decision);
      default: {
        const _exhaustive: never = decision;
        void _exhaustive;
        return { ok: false, retryable: false, phase: 'pre-call', reason: 'unknown decision type' };
      }
    }
  };

  // Tick-path dispatch: handles `emit-event` (which needs the strategy-guaranteed
  // `TickExecutorContext`) and delegates every other decision to `applyBase`.
  const applyTick = async (
    deps: DecisionDeps,
    ctx: TickExecutorContext,
    decision: Decision,
  ): Promise<DecisionResult> => {
    if (decision.type === 'emit-event') return emitEventHandler(deps, ctx, decision);
    return applyBase(deps, ctx, decision);
  };

  // Memoise profile-bindings resolution for the lifetime of one call.
  // `resolveProfile` does ~2 DB selects + builds a Binance REST client, and
  // a single tick can emit several account-scoped decisions (grid buy plus
  // sells); without memoisation each one re-resolves the same profile. The
  // cache key includes both ids so a future multi-(profile) batch stays
  // correct, though today every call resolves a single (userId, profileId).
  // Bind the per-call `accountId` (and, on the tick path, the already-proven
  // `ProfileScope`) into the resolver seam so a handler holding only the
  // strategy-core `ctx` (operatorId + profileId) still resolves per-account
  // bindings and can skip re-proving ownership. The cache key includes both ids
  // so a future multi-(profile) batch stays correct.
  const memoisedResolveProfile = (
    accountId: AccountId,
    scope?: ProfileScope,
    resolved?: ProfileResolved,
  ): DecisionDeps['resolveProfile'] => {
    const cache = new Map<string, Promise<ProfileExecutorBindings | null>>();
    return (operatorId, profileId) => {
      const key = `${operatorId}:${profileId}`;
      let pending = cache.get(key);
      if (!pending) {
        // A scope proves ownership of exactly one (accountId, profileId), and
        // the `resolved` scalars belong to that same pair. Forward both only for
        // that pair; anything else re-proves and re-reads. Today a tick emits
        // decisions for a single profile, so the guard never fires — it is what
        // keeps the fast path safe if that ever changes.
        const samePair =
          scope !== undefined && scope.accountId === accountId && scope.profileId === profileId;
        pending = deps.resolveProfile(
          operatorId,
          accountId,
          profileId,
          samePair ? scope : undefined,
          samePair ? resolved : undefined,
        );
        cache.set(key, pending);
      }
      return pending;
    };
  };

  // Standalone `apply` (single decision) resolves directly — there is
  // nothing to dedupe across one decision.
  const apply: LiveExecutor['apply'] = (ctx, accountId, decision) =>
    applyBase(
      {
        ...baseDeps,
        accountId,
        resolveProfile: memoisedResolveProfile(accountId),
        // A single decision has no sibling cancel to have failed, so the ledger is
        // trivially empty; a fresh one keeps the deps shape uniform.
        cancelLedger: createCancelLedger(),
      },
      ctx,
      decision,
    );

  return {
    apply,
    async applyAll(ctx, accountId, decisions, scope, resolved) {
      const decisionDeps: DecisionDeps = {
        ...baseDeps,
        accountId,
        resolveProfile: memoisedResolveProfile(accountId, scope, resolved),
        cancelLedger: createCancelLedger(),
      };
      // The retry story rests on ONE assumption: a tick emits at most one
      // place-order. The retry IS the un-advanced state, so the next tick re-emits
      // the WHOLE decision array — and if that array had two placements and only the
      // second failed, the re-emit would place the first one AGAIN, a real-money
      // double order. Every strategy satisfies this today (trailing-trade, momentum,
      // rebalance). Fail CLOSED before applying anything: refuse the whole tick so
      // nothing reaches the exchange. The throw is deterministic (the array
      // recomputes every tick), so the queue dead-letters it for a human instead of
      // retrying into a double placement.
      const placements = decisions.filter((d) => d.type === 'place-order').length;
      if (placements > 1) {
        // Log with profile attribution before the throw: the DLQ triage line reads
        // this, and pino's default `err` serializer would not surface the error's
        // own `profileId` field. The throw right after keeps the path deterministic.
        deps.logger.error(
          { profileId: ctx.profileId, placements },
          'executor: multi-placement tick — refusing to apply, dead-lettering',
        );
        throw new MultiPlacementError(ctx.profileId, placements);
      }

      const out: AppliedDecision[] = [];
      let broken = false;
      for (const d of decisions) {
        if (broken) {
          // Record the un-attempted decisions instead of dropping them. The audit
          // payload and the override attribution both read this array, and a
          // truncated one reads as "the strategy never emitted that order" — the
          // exact wrong conclusion. `pre-call` because nothing was sent anywhere.
          out.push({ decision: d, result: SKIPPED });
          continue;
        }
        const result = await applyTick(decisionDeps, ctx, d);
        out.push({ decision: d, result });
        // Any failed ORDER decision stops the chain. For place-order it stops
        // downstream KV/notify decisions running against a state that assumed the
        // order landed. For cancel-order it stops the place that was meant to
        // REPLACE the order we just failed to cancel: the old order is still
        // resting on Binance, so placing the new one leaves two live orders while
        // the local slot records only one.
        if (result.ok === false && (d.type === 'place-order' || d.type === 'cancel-order')) {
          broken = true;
        }
      }
      return out;
    },
  };
};
