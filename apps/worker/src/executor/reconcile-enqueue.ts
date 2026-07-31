// Throttled seam for the FAILURE-DRIVEN symbol reconciles.
//
// The discovering paths (a -2011 cancel probe that came back FILLED, a -2010 SELL
// Binance refused for want of balance) do not fire once. They fire EVERY TICK, for
// as long as the underlying condition holds — and some conditions hold for days: a
// protective stop whose base asset is locked in a resting manual order is refused
// -2010 once or twice a second, indefinitely.
//
// The queue's `jobId` coalescing does not bound that. It dedupes a duplicate
// enqueue only while the job is waiting or active; once the job reaches a
// terminal state the slot reopens, and the next -2010 a second later mints a
// fresh one. Each pass costs a `getAccount` (weight
// 20) and sometimes a `getMyTrades` (weight 20) against the same per-IP 6000/min
// request-weight budget the tick path draws on. A stuck symbol would become a
// permanent reconcile treadmill and could get the account rate-limited or banned.
//
// So the enqueue is gated on a self-expiring `SET NX PX` window per (profile,
// symbol, cause). Dropping a reconcile inside that window is safe: the pass is an
// idempotent converge-to-truth, so a second run in the same 60s would observe the
// same state and do the same nothing, and the 15-minute backstop cron catches
// anything skipped. This is a TTL'd idempotency key, not a lock — no owner, no
// release — which is the coordination primitive the no-locks gate permits.
//
// The CRON path is deliberately NOT throttled: it is already rate-limited by its
// own 15-minute cadence, and it is the backstop this throttle relies on.

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { ProfileId } from '@app/contracts';

import { createRedisWindowThrottle } from 'executor/notifier-gap-throttle.js';
import { raceDeadline } from 'lib/race-deadline.js';
import type { DecisionDeps } from 'executor/decisions/_types.js';
import type { SymbolReconcileCause } from 'queues/job-payloads.js';

/**
 * One reconcile per (profile, symbol, cause) per minute. Long enough to collapse a
 * per-tick failure storm into a trickle; short enough that a genuine fill
 * discovered moments after an unrelated skipped one is still repaired promptly
 * rather than waiting for the backstop.
 */
export const RECONCILE_THROTTLE_MS = 60_000;

export const RECONCILE_THROTTLE_KEY_PREFIX = 'reconcile-throttle:';

/**
 * Deadline for the `queue.add` Redis round-trip. The enqueue is awaited inside
 * the tick's `chainByKey` critical section, and the executor's ioredis runs with
 * `maxRetriesPerRequest: null` and no command timeout — so a reachable-but-
 * stalled Redis would hang this (profile, symbol) chain indefinitely. Same
 * budget as the throttle's own SET.
 */
export const RECONCILE_ENQUEUE_TIMEOUT_MS = 500;

/**
 * What we know about the enqueue once the deadline has been raced.
 *
 * `unknown` is the load-bearing one: the deadline was breached, and because the
 * write is ABANDONED rather than cancelled, the job may still land. It is not
 * evidence that nothing happened, so it must not release the window.
 */
type EnqueueVerdict = 'landed' | 'declined' | 'failed' | 'unknown';

export interface ThrottledReconcileEnqueueDeps {
  readonly redis: Redis;
  readonly logger: Logger;
  /**
   * The unthrottled enqueue. Called only when the window is open. Returns whether
   * a job actually LANDED: `false` when it declined to enqueue (the profile is no
   * longer active, so there is nothing to converge). The window is released on
   * `false`, so a decline cannot burn 60s of suppression on a job that never
   * existed.
   */
  readonly enqueue: (input: {
    profileId: ProfileId;
    symbol: string;
    cause: SymbolReconcileCause;
  }) => Promise<boolean>;
}

/**
 * Wraps the raw enqueue in the suppression window. Fails OPEN on a Redis fault
 * (inherited from the throttle primitive): an extra reconcile costs weight, a
 * dropped one leaves a position mis-stated, and the second is the worse outcome.
 *
 * The window opens BEFORE the enqueue, because the enqueue is what it exists to
 * suppress. It is released again only when the enqueue DEFINITIVELY did not land:
 *
 *   - `declined` — the profile is no longer active, so no job was added;
 *   - `failed`   — the add threw.
 *
 * A deadline breach is `unknown`, NOT a release. `raceDeadline` abandons the
 * write, it does not cancel it, so the `queue.add` may well still land. Releasing
 * there would let a Redis that is merely SLOWER than the deadline re-enqueue on
 * every tick — restoring the exact request-weight treadmill this module exists to
 * prevent, precisely under the fault it was written to survive. So `unknown` keeps
 * the window closed and defers to the 15-minute backstop cron, which is the
 * documented fail-open path.
 */
export const createThrottledReconcileEnqueue = (
  deps: ThrottledReconcileEnqueueDeps,
): NonNullable<DecisionDeps['enqueueSymbolReconcile']> => {
  const throttle = createRedisWindowThrottle({
    redis: deps.redis,
    logger: deps.logger,
    prefix: RECONCILE_THROTTLE_KEY_PREFIX,
    windowMs: RECONCILE_THROTTLE_MS,
  });
  return async ({ profileId, symbol, cause }) => {
    const key = `${profileId}:${symbol}:${cause}`;
    if (!(await throttle.allow(key))) {
      deps.logger.debug(
        { profileId, symbol, cause },
        'symbol-reconcile: a converge pass for this symbol is already in flight this window; skipped',
      );
      return;
    }

    // Bounded: a stalled enqueue must not hold the tick's chain lock.
    // Boxed so the verdict survives TypeScript's control-flow narrowing: it is
    // assigned from callbacks the compiler cannot see run.
    const outcome: { verdict: EnqueueVerdict } = { verdict: 'unknown' };
    await raceDeadline(
      () =>
        deps.enqueue({ profileId, symbol, cause }).then((ok) => {
          outcome.verdict = ok ? 'landed' : 'declined';
        }),
      RECONCILE_ENQUEUE_TIMEOUT_MS,
      () => {
        deps.logger.warn(
          { profileId, symbol, cause },
          `symbol-reconcile: enqueue exceeded ${RECONCILE_ENQUEUE_TIMEOUT_MS}ms; the job may still land, so the window STAYS closed and the backstop cron will converge this symbol`,
        );
      },
      (err: unknown) => {
        outcome.verdict = 'failed';
        deps.logger.warn(
          { profileId, symbol, cause, err: err },
          'symbol-reconcile: enqueue failed; the backstop cron will converge this symbol',
        );
      },
    );

    // ONLY a definitive non-landing releases the window. `unknown` (deadline
    // breached) keeps it closed: the add may still land, and re-opening under a
    // slow Redis would restore the per-tick enqueue treadmill.
    if (outcome.verdict === 'declined' || outcome.verdict === 'failed') {
      await throttle.release(key);
    }
  };
};
