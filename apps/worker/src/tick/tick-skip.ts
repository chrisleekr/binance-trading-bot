// Self-healing tick skips.
//
// The graceful-skip result plus the two throw-classifiers that turn a governor
// backpressure signal or a confirmed-delisted symbol into a re-drivable skip
// instead of a dead-letter. Exported so the regression-prone name/instanceof
// matches and the skip behaviour are unit-tested without the full tick harness.

import type { ProfileId } from '@app/contracts';
import type { ActionLogInsert, ProfileScope } from '@app/db';
import { SymbolDelistedError } from './symbol-info-cache.js';
import type { ReapOutcome, TickHandlerDeps, TickResult } from './tick-types.js';

/**
 * The graceful-skip result shape shared by every self-healing exit: the tick did
 * no work (`decisionCount: 0`) and asks to be re-driven by the next event
 * (`throttled: true`) rather than dead-lettering. One builder so no skip path can
 * drift from the others. `throttled` is the worker's own "did nothing, re-drive me"
 * flag and is read nowhere outside it; it does not claim rate limiting.
 */
export const throttledSkip = (ctx: {
  profileId: ProfileId;
  symbol: string;
  latencyMs: number;
}): TickResult => ({
  profileId: ctx.profileId,
  symbol: ctx.symbol,
  latencyMs: ctx.latencyMs,
  decisionCount: 0,
  throttled: true,
});

/**
 * True for the weight-governor's BULK-read backpressure signal. Matched by
 * NAME, not `instanceof`: `RedisUnavailableError` is thrown from `@app/binance`
 * and crosses a package boundary where dual module identities can make
 * `instanceof` silently false (the same hazard the error-envelope pattern
 * avoids). The tick treats this as a self-healing skip, never a dead-letter —
 * order calls are priority and fail OPEN, so no trade is blocked, and the next
 * market event re-ticks. A genuine Redis outage still dead-letters via the
 * tick's other Redis ops, which throw raw connection errors (different name).
 * Exported so the name-match — the regression-prone part — is unit-tested.
 */
export const isRedisUnavailableError = (err: unknown): err is Error =>
  err instanceof Error && err.name === 'RedisUnavailableError';

/**
 * The tick's response to a governor bulk-read backpressure signal: record the
 * throttle metric + a warn carrying the underlying cause, and return a throttled
 * skip result. Returns `null` when `err` is NOT the backpressure signal —
 * telling the caller to rethrow so a genuine failure still dead-letters. Extracted
 * so the skip BEHAVIOR (metric recorded, throttled result, rethrow-on-mismatch),
 * not just the guard, is unit-tested without the full tick harness.
 */
export const redisUnavailableSkip = (
  err: unknown,
  deps: Pick<TickHandlerDeps, 'metrics' | 'logger'>,
  ctx: { profileId: ProfileId; symbol: string; latencyMs: number },
): TickResult | null => {
  if (!isRedisUnavailableError(err)) return null;
  deps.metrics?.record('tick_throttled_redis_unavailable', 1, { profileId: ctx.profileId });
  deps.logger.warn(
    {
      profileId: ctx.profileId,
      symbol: ctx.symbol,
      err: err,
      cause: (err.cause as Error | undefined)?.message,
    },
    'tick skipped: weight-governor Redis unavailable on a bulk read; retrying next event',
  );
  return throttledSkip(ctx);
};

/**
 * True for a symbol Binance no longer lists on this profile's mode. `instanceof`
 * is safe here (unlike {@link isRedisUnavailableError}): `SymbolDelistedError` is
 * thrown from this same worker package, so there is no cross-package dual-identity
 * hazard. A transient exchangeInfo read failure stays a bare `Error` and is NOT
 * matched, so it still dead-letters.
 */
const isSymbolDelistedError = (err: unknown): err is SymbolDelistedError =>
  err instanceof SymbolDelistedError;

/**
 * The tick's response to a confirmed-delisted symbol: self-heal instead of
 * dead-lettering. Reaps the auto-added binding when it is flat and returns the
 * same graceful-skip result the RedisUnavailable path returns, so the job never
 * retries a symbol that will not come back. Returns `null` when `err` is NOT a
 * delisted error — telling the caller to fall through (RedisUnavailable check,
 * then rethrow → DLQ). The reap is called DIRECTLY, never through the per-(profile,
 * symbol) chain the tick already holds — a reentrant `chain.run` on the same key
 * would self-deadlock. Every dep is optional: unwired, this still degrades the
 * throw to a skip (the primary win) and simply records nothing.
 */
export const symbolDelistedReap = async (
  err: unknown,
  deps: Pick<
    TickHandlerDeps,
    'reapAutoIfFlat' | 'appendActionLog' | 'delistThrottle' | 'enqueueReconfigure' | 'logger'
  >,
  ctx: {
    scope: ProfileScope;
    profileId: ProfileId;
    symbol: string;
    latencyMs: number;
    nowMs: number;
  },
): Promise<TickResult | null> => {
  if (!isSymbolDelistedError(err)) return null;
  const { scope, profileId, symbol } = ctx;
  const time = new Date(ctx.nowMs);

  // Best-effort action_log append. A transient DB fault here must NOT re-throw out
  // of the catch — that would DLQ the very tick this self-heal exists to rescue.
  // The graceful skip (no DLQ) is the contract; the operator record is visibility.
  const appendBestEffort = async (input: Omit<ActionLogInsert, 'profileId'>): Promise<void> => {
    try {
      await deps.appendActionLog?.(scope, input);
    } catch (logErr) {
      deps.logger.warn(
        { profileId, symbol, err: logErr },
        'tick-handler: could not write the delisted-symbol action_log (self-heal still applied)',
      );
    }
  };

  // The reap DB delete is guarded too: any transient fault degrades to a graceful
  // skip (the next tick re-attempts) rather than a DLQ. `undefined` reads the same
  // as the unwired dep — say nothing, still skip.
  let outcome: ReapOutcome | undefined;
  try {
    outcome = deps.reapAutoIfFlat ? await deps.reapAutoIfFlat(scope, symbol) : undefined;
  } catch (reapErr) {
    deps.logger.warn(
      { profileId, symbol, err: reapErr },
      'tick-handler: delisted-symbol reap failed transiently — skipping this tick, will re-attempt next',
    );
    outcome = undefined;
  }

  if (outcome === 'removed') {
    deps.logger.info(
      { profileId, symbol, mode: err.mode },
      'tick-handler: symbol delisted on its Binance mode — reaped the flat auto-added binding',
    );
    await appendBestEffort({
      time,
      symbol,
      level: 'info',
      msg: `${symbol}: delisted on Binance — auto-added symbol removed`,
      ctx: { source: 'symbol-delisted', mode: err.mode, outcome },
    });
    // The binding is gone from the DB, but the WS is still feeding this symbol.
    // Enqueue a reconfigure so the subscriber drops it promptly. Best-effort: a
    // throw must NOT fail the tick — the graceful skip below is the contract.
    try {
      await deps.enqueueReconfigure?.({
        userId: scope.operatorId,
        accountId: scope.accountId,
        profileId,
      });
    } catch (enqueueErr) {
      deps.logger.warn(
        { profileId, symbol, err: enqueueErr },
        'tick-handler: failed to enqueue reconfigure after delist reap (self-heal still applied)',
      );
    }
  } else if (outcome === 'held' || outcome === 'not-auto') {
    // Can't reap a held position or an operator-pinned symbol. The operator must
    // act (flatten or unpin), so tell them — but the same symbol delists the same
    // way every tick, so gate the record to one per window. Fail-open: an absent
    // throttle just emits every time.
    const allowed = deps.delistThrottle
      ? await deps.delistThrottle.allow(`${profileId}:${symbol}`)
      : true;
    if (allowed) {
      deps.logger.warn(
        { profileId, symbol, mode: err.mode, outcome },
        'tick-handler: symbol delisted but its binding cannot be reaped (held or pinned) — left in place',
      );
      await appendBestEffort({
        time,
        symbol,
        level: 'warn',
        msg:
          outcome === 'held'
            ? `${symbol}: delisted on Binance but still held — left in place, flatten it manually`
            : `${symbol}: delisted on Binance but pinned — left in place, unpin it to remove`,
        ctx: { source: 'symbol-delisted', mode: err.mode, outcome },
      });
    }
  }
  // 'not-found' (already gone) and the unwired case say nothing.

  return throttledSkip({ profileId, symbol, latencyMs: ctx.latencyMs });
};
