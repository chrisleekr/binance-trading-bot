import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { NotifyProviderRegistry } from '@app/notify';
import type { StrategyRegistry } from '@app/strategy-core';
import type { CancelLedger } from 'executor/cancel-ledger.js';
import type { ProfileExecutorBindings } from 'executor/live-executor.js';
import type { NotifierGapThrottle } from 'executor/notifier-gap-throttle.js';
import type { PlacementDedup } from 'executor/placement-dedup.js';
import type { SymbolReconcileCause } from 'queues/job-payloads.js';

/**
 * Shared dependency bundle every per-decision handler accepts. Bundling
 * avoids each handler signature growing as new shared deps land; tests
 * compose this bag from doubles. `resolveProfile` is the same DI seam
 * the executor exposes — handlers that need account-scoped resources
 * (place-order, cancel-order) call it; `applyAll` injects a per-tick
 * memoised resolver so repeated calls within one tick share one
 * resolution.
 */
export interface DecisionDeps {
  readonly redis: Redis;
  /**
   * The account whose Redis namespace every per-decision side effect keys on
   * (open-orders / weight / events streams). Injected per call by
   * `LiveExecutor.apply(All)` because the strategy-core `ExecutorContext`
   * carries only `userId`/`profileId`, not the account.
   */
  readonly accountId: AccountId;
  readonly logger: Logger;
  readonly clock: { nowMs(): number };
  /**
   * Wall-clock wait. Injected (rather than a captured `setTimeout`) so the
   * one path that waits — place-order holding out Binance's recv-window before
   * it believes a "no such order" probe — is drivable by fake timers. Omitted
   * ⇒ a real `setTimeout`.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly weightTtlSeconds: number;
  readonly notifyRegistry: NotifyProviderRegistry;
  /** Public "Live demo" mode: suppresses all emergency notifier dispatch. */
  readonly liveDemo?: boolean;
  /**
   * Strategy registry, used by the emit-event handler to look up the
   * emitting strategy's {@link Strategy.events} schema and runtime-validate
   * the decision's payload before publish. The map is the only authority
   * for which event payloads are legal — tsc enforces it at the strategy
   * call site; this handler enforces it at the executor boundary so an
   * uncovered code path can't smuggle a wrong-shape payload onto the wire.
   */
  readonly strategies: StrategyRegistry;
  readonly resolveProfile: (
    userId: UserId,
    profileId: ProfileId,
  ) => Promise<ProfileExecutorBindings | null>;
  /**
   * Cancels attempted in this call that did not provably clear the exchange.
   * `cancel-order` writes it; `place-order` reads it to decide whether the
   * previous order on the slot may be stamped CANCELED, since a still-resting
   * order stamped closed is an orphan.
   */
  readonly cancelLedger: CancelLedger;
  /**
   * Rate-limit for the notifier-gap action_log trace, keyed per
   * (profile, topic). Optional so unit tests can omit it (omission ⇒
   * always-allow, every gap recorded); production wires a Redis-backed
   * throttle so a recurring real-money emergency on a notifier-less profile
   * emits one trace per window across the whole fleet, not one per pod.
   */
  readonly notifierGapThrottle?: NotifierGapThrottle;
  /**
   * Rate-limit for the `order-unfundable` ALERT ITSELF (not just its gap trace),
   * keyed per (profile, symbol). A pre-flight refusal re-emits every tick until the
   * operator frees the coins, so an un-throttled dispatch would swap the rejected-
   * order storm for a Slack storm. Optional ⇒ tests omit it ⇒ always-allow.
   */
  readonly unfundableThrottle?: NotifierGapThrottle;

  /**
   * Defer a converge-to-exchange-truth pass for one (profile, symbol) onto the
   * `symbol-reconcile` queue.
   *
   * A handler that learns a fill happened (a -2011 cancel probe that returns
   * FILLED) MUST NOT adopt it inline: it is running inside the tick's
   * `chainByKey(`${profileId}:${symbol}`)` lock, which the fill-adopter takes
   * too, and that chain is strictly non-reentrant — an inline adopt would
   * self-await and hang the tick forever. Enqueueing is a Redis push, which is
   * safe under the lock.
   *
   * Optional so every existing test double and the standalone `apply` path
   * compose without it; omission ⇒ the discovery is logged and the periodic
   * backstop cron picks the drift up on its next pass.
   */
  readonly enqueueSymbolReconcile?: (input: {
    profileId: ProfileId;
    symbol: string;
    cause: SymbolReconcileCause;
  }) => Promise<void>;

  /**
   * In-process duplicate-MARKET-placement guard. A MARKET fill frees its
   * clientOrderId (Binance dedups only OPEN orders), so a re-emitted identical
   * MARKET order fills again. Backstops the read-your-writes state fix. Optional
   * ⇒ tests and the standalone `apply` path omit it (no dedup); production wires
   * one long-lived instance on the executor. See {@link PlacementDedup}.
   */
  readonly placementDedup?: PlacementDedup;
}

/**
 * Resolve the per-profile bindings or throw. Handlers that touch
 * Binance, notifiers, or order persistence call this once at the top of
 * their body. Throwing on missing bindings preserves the pre-split
 * behaviour: a tick against an unconfigured profile fails the decision
 * rather than silently succeeding.
 */
export const resolveBindings = async (
  deps: DecisionDeps,
  userId: UserId,
  profileId: ProfileId,
): Promise<ProfileExecutorBindings> => {
  const bindings = await deps.resolveProfile(userId, profileId);
  if (!bindings) throw new Error(`LiveExecutor: profile bindings not found for ${profileId}`);
  return bindings;
};

/**
 * Enqueue a reconcile without letting it change the decision's outcome. The
 * reconcile is a REPAIR of state the exchange has already changed; the decision
 * it rides on (a cancel whose order had in fact filled) is settled either way.
 * Failing the decision because the repair could not be scheduled would wedge the
 * cancel on a Redis blip and re-run the whole cancel-replace chase, so this
 * logs at `error` (the drift is real and the periodic backstop is now the only
 * thing that will heal it) and swallows.
 */
export const enqueueReconcile = async (
  deps: DecisionDeps,
  profileId: ProfileId,
  symbol: string,
  cause: SymbolReconcileCause,
  logCtx: Record<string, unknown> = {},
): Promise<void> => {
  try {
    await deps.enqueueSymbolReconcile?.({ profileId, symbol, cause });
  } catch (err) {
    deps.logger?.error(
      { ...logCtx, profileId, symbol, cause, err: err },
      'executor: could not enqueue the symbol reconcile; the position may stay drifted until the backstop sweep',
    );
  }
};
