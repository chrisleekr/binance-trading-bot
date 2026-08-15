// Fleet-wide rate-limiter for the notifier-gap action_log trace.
//
// A real-money emergency on a profile with no enabled notifier writes a
// durable warn-level action_log so the operator can see they were not
// alerted. Without a throttle a recurring emergency (a misconfigured order
// that fails the same way every tick) would flood that log.
//
// The suppression window lives in Redis via `SET key val PX window NX`, so a
// multi-replica worker fleet emits ONE trace per (profile, topic) per window
// rather than one per pod. This is a self-expiring `SET NX` flag (a TTL'd
// idempotency key), not a distributed lock: no owner, no release, the key
// self-expires. Like the request-weight bucket, it is coordination
// infrastructure the no-locks gate permits (WS6 ADR, epic #561).

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { raceDeadline } from 'lib/race-deadline.js';

/** Default suppression window: one hour between gap traces for the same key. */
export const DEFAULT_NOTIFIER_GAP_WINDOW_MS = 3_600_000;

// Deadline for the Redis SET. The executor's ioredis runs with
// `maxRetriesPerRequest: null` and no command timeout, so a reachable-but-
// stalled Redis (an RDB fork pause, a slow EVAL from another client) would
// hang this call — and it is awaited on the place-order error path, so the
// hang would stretch the whole tick. The race rejects instead and the catch
// below fails open. Mirrors `stampTickMeta` and the weight governor.
export const DEFAULT_NOTIFIER_GAP_SET_TIMEOUT_MS = 500;

// The caller-supplied key already carries a globally-unique profileId (UUID),
// so this fixed prefix is enough for isolation; no per-user namespacing needed.
const KEY_PREFIX = 'notifier-gap-throttle:';

export interface NotifierGapThrottle {
  /**
   * Returns true (and opens a suppression window for `key`) when no window is
   * currently active for it, false while one is. Timing is owned by the Redis
   * key TTL, so the verdict is consistent across every pod in the fleet.
   */
  allow(key: string): Promise<boolean>;
  /**
   * Reopens the window a preceding `allow` opened, for the caller that opened it
   * and then found it had nothing to suppress. Without this the window is burned
   * on work that never happened and the next caller is denied for nothing.
   *
   * Still not a lock: the key has no owner and no waiter, and dropping the `del`
   * costs at most one suppressed window, never a stuck one. Best-effort — a
   * failure just leaves the TTL to expire on its own.
   */
  release(key: string): Promise<void>;
}

export interface RedisWindowThrottleDeps {
  readonly redis: Redis;
  readonly logger: Logger;
  /** Namespace for this throttle's keys; two throttles must never share one. */
  readonly prefix: string;
  readonly windowMs: number;
  readonly setTimeoutMs?: number;
}

export type NotifierGapThrottleDeps = Omit<RedisWindowThrottleDeps, 'prefix' | 'windowMs'> & {
  readonly windowMs?: number;
};

/**
 * The primitive both throttles are: a fleet-wide, self-expiring suppression
 * window. Generic because the notifier-gap trace is not the only signal that
 * repeats every tick for the same reason — a failing order does too, and it wants
 * the same semantics (one alert per window across every pod, FAIL OPEN on a Redis
 * fault so a duplicate alert is preferred over a dropped one).
 */
export const createRedisWindowThrottle = (deps: RedisWindowThrottleDeps): NotifierGapThrottle => {
  const { windowMs, prefix } = deps;
  const setTimeoutMs = deps.setTimeoutMs ?? DEFAULT_NOTIFIER_GAP_SET_TIMEOUT_MS;
  return {
    async allow(key) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // NX: set only if absent, so the first caller in the window wins and
        // records the trace while every other pod (and later tick) is
        // suppressed. PX: the key self-expires after the window, opening the
        // next one with no explicit reset.
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${prefix} throttle: redis set timed out`)),
            setTimeoutMs,
          );
        });
        const res = await Promise.race([
          deps.redis.set(`${prefix}${key}`, '1', 'PX', windowMs, 'NX'),
          deadline,
        ]);
        return res === 'OK';
      } catch (err: unknown) {
        // Fail open: the throttle only rate-limits a VISIBILITY record. On a
        // Redis loss or stall, prefer a recoverable (pruned) action_log flood
        // over silently dropping the one signal that says the operator was not
        // alerted (CLAUDE.md: no silent failures).
        deps.logger.warn(
          { key, prefix, err: err },
          'redis window throttle: redis unavailable, allowing the signal through',
        );
        return true;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async release(key) {
      await raceDeadline(
        () => deps.redis.del(`${prefix}${key}`),
        setTimeoutMs,
        () => {
          deps.logger.warn(
            { key, prefix },
            'redis window throttle: release timed out; the window will expire on its own TTL',
          );
        },
        (err: unknown) => {
          deps.logger.warn(
            { key, prefix, err: err },
            'redis window throttle: release failed; the window will expire on its own TTL',
          );
        },
      );
    },
  };
};

/** The notifier-gap preset: hourly window, its own key namespace. */
export const createNotifierGapThrottle = (deps: NotifierGapThrottleDeps): NotifierGapThrottle =>
  createRedisWindowThrottle({
    redis: deps.redis,
    logger: deps.logger,
    prefix: KEY_PREFIX,
    windowMs: deps.windowMs ?? DEFAULT_NOTIFIER_GAP_WINDOW_MS,
    ...(deps.setTimeoutMs === undefined ? {} : { setTimeoutMs: deps.setTimeoutMs }),
  });

/**
 * Suppression window for the `order-failed` alert. The spam vector is ONE SYMBOL
 * FAILING THE SAME WAY TICK AFTER TICK (a stop the exchange keeps refusing), not
 * a burst within one tick — so the window is keyed per (profile, symbol) and is
 * several tick periods long.
 */
export const DEFAULT_ORDER_FAILED_WINDOW_MS = 900_000;

export const ORDER_FAILED_KEY_PREFIX = 'order-failed-throttle:';

export const createOrderFailedThrottle = (deps: NotifierGapThrottleDeps): NotifierGapThrottle =>
  createRedisWindowThrottle({
    redis: deps.redis,
    logger: deps.logger,
    prefix: ORDER_FAILED_KEY_PREFIX,
    windowMs: deps.windowMs ?? DEFAULT_ORDER_FAILED_WINDOW_MS,
    ...(deps.setTimeoutMs === undefined ? {} : { setTimeoutMs: deps.setTimeoutMs }),
  });

export const DEFAULT_ORDER_REFUSAL_LOOP_WINDOW_MS = 3_600_000;

/** Separate from ordinary failures so the preceding alert cannot mute the loop escalation. */
export const ORDER_REFUSAL_LOOP_KEY_PREFIX = 'order-refusal-loop-throttle:';

export const createOrderRefusalLoopThrottle = (
  deps: NotifierGapThrottleDeps,
): NotifierGapThrottle =>
  createRedisWindowThrottle({
    redis: deps.redis,
    logger: deps.logger,
    prefix: ORDER_REFUSAL_LOOP_KEY_PREFIX,
    windowMs: deps.windowMs ?? DEFAULT_ORDER_REFUSAL_LOOP_WINDOW_MS,
    ...(deps.setTimeoutMs === undefined ? {} : { setTimeoutMs: deps.setTimeoutMs }),
  });

/**
 * Suppression window for the `order-unfundable` alert. A pre-flight refusal leaves
 * the strategy's state un-advanced ON PURPOSE (the order is not lost, it is
 * re-derived), so an unfundable order is RE-EMITTED every tick for as long as the
 * wallet stays locked — hours, until the operator cancels the blocking order. One
 * alert per (profile, symbol) per window is the whole point: without it the order
 * storm is simply traded for a notification storm.
 */
export const DEFAULT_ORDER_UNFUNDABLE_WINDOW_MS = 3_600_000;

export const ORDER_UNFUNDABLE_KEY_PREFIX = 'order-unfundable-throttle:';

export const createUnfundableThrottle = (deps: NotifierGapThrottleDeps): NotifierGapThrottle =>
  createRedisWindowThrottle({
    redis: deps.redis,
    logger: deps.logger,
    prefix: ORDER_UNFUNDABLE_KEY_PREFIX,
    windowMs: deps.windowMs ?? DEFAULT_ORDER_UNFUNDABLE_WINDOW_MS,
    ...(deps.setTimeoutMs === undefined ? {} : { setTimeoutMs: deps.setTimeoutMs }),
  });

/**
 * Suppression window for the `order-symbol-not-permitted` alert. Same re-emission
 * shape as the unfundable case, but strictly worse: the wallet can be freed in a
 * minute, whereas a missing Binance permission is permanent until the operator
 * unbinds the symbol or changes the account's permissions. One alert per
 * (profile, symbol) per window.
 */
export const DEFAULT_SYMBOL_NOT_PERMITTED_WINDOW_MS = 3_600_000;

export const SYMBOL_NOT_PERMITTED_KEY_PREFIX = 'symbol-not-permitted-throttle:';

export const createSymbolNotPermittedThrottle = (
  deps: NotifierGapThrottleDeps,
): NotifierGapThrottle =>
  createRedisWindowThrottle({
    redis: deps.redis,
    logger: deps.logger,
    prefix: SYMBOL_NOT_PERMITTED_KEY_PREFIX,
    windowMs: deps.windowMs ?? DEFAULT_SYMBOL_NOT_PERMITTED_WINDOW_MS,
    ...(deps.setTimeoutMs === undefined ? {} : { setTimeoutMs: deps.setTimeoutMs }),
  });

/**
 * Suppression window for the `protective-stop-blocked` alert. Nothing is placed
 * and nothing is refused here, so none of the prefixes above are ever touched:
 * the stop is DEFERRED because the exchange band cannot admit its price. The
 * band is re-evaluated every tick and refuses identically, which is the same
 * repeat shape the windows above exist for. Keyed
 * `(profile, symbol, escalation)`, so the "no price ever arms this" alert is
 * never muted by the "the price has to come back" one.
 */
export const DEFAULT_PROTECTIVE_STOP_BLOCKED_WINDOW_MS = 3_600_000;

export const PROTECTIVE_STOP_BLOCKED_KEY_PREFIX = 'protective-stop-blocked-throttle:';

export const createProtectiveStopBlockedThrottle = (
  deps: NotifierGapThrottleDeps,
): NotifierGapThrottle =>
  createRedisWindowThrottle({
    redis: deps.redis,
    logger: deps.logger,
    prefix: PROTECTIVE_STOP_BLOCKED_KEY_PREFIX,
    windowMs: deps.windowMs ?? DEFAULT_PROTECTIVE_STOP_BLOCKED_WINDOW_MS,
    ...(deps.setTimeoutMs === undefined ? {} : { setTimeoutMs: deps.setTimeoutMs }),
  });

/**
 * The two tick-boundary self-heal records. Named here, beside the executor's
 * prefixes, because that adjacency is what makes a collision visible: these
 * windows are all keyed `(profile, symbol)`, so two sharing a prefix would share
 * one Redis key and whichever fired first would mute the other for an hour.
 *
 * `SYMBOL_NOT_PERMITTED_RETIRE_KEY_PREFIX` is deliberately NOT
 * {@link SYMBOL_NOT_PERMITTED_KEY_PREFIX}: that one covers "an order was just
 * refused", this one "the binding cannot be retired, act". Same cause, different
 * moments, different operator fixes — and the refusal fires first, so sharing
 * would swallow the one that asks for action.
 */
export const SYMBOL_DELISTED_KEY_PREFIX = 'symbol-delisted-throttle:';
export const SYMBOL_NOT_PERMITTED_RETIRE_KEY_PREFIX = 'symbol-not-permitted-retire-throttle:';
