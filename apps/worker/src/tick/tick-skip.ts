// Self-healing tick skips.
//
// The graceful-skip result, the two throw-classifiers that turn a governor
// backpressure signal or a confirmed-delisted symbol into a re-drivable skip
// instead of a dead-letter, and the data-driven tradability pre-check that
// retires a binding no order can ever reach. Exported so the regression-prone
// name/instanceof matches and the skip behaviour are unit-tested without the
// full tick harness.

import type { BinanceMode } from '@app/binance';
import type { ProfileId } from '@app/contracts';
import { isSymbolPermittedForAccount, projectPermissionSets } from '@app/contracts';
import type { ActionLogInsert, ProfileScope } from '@app/db';
import { readAccountPermissions } from 'lib/account-permissions.js';
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
 * How many tags of an unsatisfied set are worth recording. Enough to name what
 * the account is missing, few enough that one exchange-controlled set cannot
 * grow an `action_logs` row without bound.
 */
const MAX_SAMPLED_TAGS = 8;

/** What the caller is retiring a binding for, and the words the operator reads. */
interface ReapCopy {
  /** Stamped into `action_logs.ctx.source` so the two self-heals stay distinguishable. */
  readonly source: string;
  /** Extra `ctx` fields for the action_log and the pino lines (the delist mode, …). */
  readonly logFields: Record<string, unknown>;
  readonly removedMsg: string;
  readonly heldMsg: string;
  readonly notAutoMsg: string;
  /** Per-cause suppression window. Two causes must never share one key namespace. */
  readonly throttle: { allow(key: string): Promise<boolean> } | undefined;
}

/**
 * The shared trunk of every "this binding will never work again" self-heal: reap
 * it when it is discovery-owned and flat, tell the operator what happened (once
 * per window when they must act), and NEVER let any of that turn into a throw.
 *
 * Every step is swallowed on purpose. The contract this exists to hold is the
 * graceful skip: a transient Postgres or Redis fault here must not dead-letter
 * the very tick the self-heal is rescuing, because the next tick re-attempts and
 * the operator record is visibility, not correctness.
 *
 * The reap is called DIRECTLY, never through the per-(profile, symbol) chain the
 * tick already holds — a reentrant `chain.run` on the same key self-deadlocks.
 */
const reapAndRecord = async (
  deps: Pick<
    TickHandlerDeps,
    'reapAutoIfFlat' | 'appendActionLog' | 'enqueueReconfigure' | 'logger'
  >,
  ctx: { scope: ProfileScope; profileId: ProfileId; symbol: string; nowMs: number },
  copy: ReapCopy,
): Promise<ReapOutcome | undefined> => {
  const { scope, profileId, symbol } = ctx;
  const time = new Date(ctx.nowMs);

  const appendBestEffort = async (input: Omit<ActionLogInsert, 'profileId'>): Promise<void> => {
    try {
      await deps.appendActionLog?.(scope, input);
    } catch (logErr) {
      deps.logger.warn(
        { profileId, symbol, err: logErr, source: copy.source },
        'tick-handler: could not write the self-heal action_log (self-heal still applied)',
      );
    }
  };

  // `undefined` reads the same as the unwired dep — say nothing, still skip.
  let outcome: ReapOutcome | undefined;
  try {
    outcome = deps.reapAutoIfFlat ? await deps.reapAutoIfFlat(scope, symbol) : undefined;
  } catch (reapErr) {
    deps.logger.warn(
      { profileId, symbol, err: reapErr, source: copy.source },
      'tick-handler: binding reap failed transiently — skipping this tick, will re-attempt next',
    );
    outcome = undefined;
  }

  if (outcome === 'removed') {
    deps.logger.info(
      { profileId, symbol, source: copy.source, ...copy.logFields },
      'tick-handler: reaped the flat auto-added binding',
    );
    await appendBestEffort({
      time,
      symbol,
      level: 'info',
      msg: copy.removedMsg,
      ctx: { source: copy.source, ...copy.logFields, outcome },
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
        { profileId, symbol, err: enqueueErr, source: copy.source },
        'tick-handler: failed to enqueue reconfigure after the reap (self-heal still applied)',
      );
    }
  } else if (outcome === 'held' || outcome === 'not-auto') {
    // Can't reap a held position or an operator-pinned symbol. The operator must
    // act (flatten or unpin), so tell them — but the cause repeats identically
    // every tick, so gate the record to one per window. Fail-open twice over: an
    // absent throttle emits every time, and a throttle that throws (Redis down)
    // must not cost the skip either.
    let allowed = true;
    try {
      allowed = copy.throttle ? await copy.throttle.allow(`${profileId}:${symbol}`) : true;
    } catch (throttleErr) {
      deps.logger.warn(
        { profileId, symbol, err: throttleErr, source: copy.source },
        'tick-handler: self-heal throttle unavailable — emitting the operator record unsuppressed',
      );
    }
    if (allowed) {
      deps.logger.warn(
        { profileId, symbol, outcome, source: copy.source, ...copy.logFields },
        'tick-handler: binding cannot be reaped (held or pinned) — left in place',
      );
      await appendBestEffort({
        time,
        symbol,
        level: 'warn',
        msg: outcome === 'held' ? copy.heldMsg : copy.notAutoMsg,
        ctx: { source: copy.source, ...copy.logFields, outcome },
      });
    }
  }
  // 'not-found' (already gone) and the unwired case say nothing.
  return outcome;
};

/**
 * The tick's response to a confirmed-delisted symbol: self-heal instead of
 * dead-lettering. Reaps the auto-added binding when it is flat and returns the
 * same graceful-skip result the RedisUnavailable path returns, so the job never
 * retries a symbol that will not come back. Returns `null` when `err` is NOT a
 * delisted error — telling the caller to fall through (RedisUnavailable check,
 * then rethrow → DLQ). Every dep is optional: unwired, this still degrades the
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
  const { profileId, symbol } = ctx;
  await reapAndRecord(deps, ctx, {
    source: 'symbol-delisted',
    logFields: { mode: err.mode },
    removedMsg: `${symbol}: delisted on Binance — auto-added symbol removed`,
    heldMsg: `${symbol}: delisted on Binance but still held — left in place, flatten it manually`,
    notAutoMsg: `${symbol}: delisted on Binance but pinned — left in place, unpin it to remove`,
    throttle: deps.delistThrottle,
  });
  return throttledSkip({ profileId, symbol, latencyMs: ctx.latencyMs });
};

/**
 * The tick's response to a symbol this account has no Binance permission to
 * trade. Data-driven, not error-driven: nothing throws, so this runs BEFORE the
 * assembler rather than in its catch. A symbol whose `permissionSets` the
 * account cannot satisfy is refused `-2010` on every order it will ever emit, so
 * the binding is retired on the same terms as a delisting — reaped when it is
 * discovery-owned and flat, left in place with a throttled operator record when
 * the operator must act first.
 *
 * Returns `null` for "carry on and tick", and it says that in every ambiguity:
 * the symbol publishes no sets, its published shape drifted, or the account's
 * cached tags are absent, empty or unparseable. Retirement destroys a binding,
 * so the asymmetry is deliberate — a wrong "not permitted" silently retires a
 * symbol the account can trade, while a wrong "permitted" costs one Binance
 * rejection, which is what already happens today.
 *
 * It also returns `null` when the binding SURVIVES (held or operator-pinned).
 * Only a retired symbol has nothing left to tick; one still bound must keep
 * ticking, or its blocker rows never close and its resting orders can never be
 * cancelled. The order-placement pre-flight already refuses its orders at zero
 * request weight, which is exactly the case it was built for.
 *
 * Spends no request weight of its own: the symbol row comes from the same
 * symbol-info cache the assembler reads on the very next line, and the account's
 * tags from the Redis key every signed `/account` response already writes.
 *
 * A `SymbolDelistedError` from the symbol-info read is deliberately NOT caught:
 * it belongs to {@link symbolDelistedReap}, whose copy is the accurate one for a
 * symbol Binance no longer lists at all.
 */
export const symbolNotPermittedRetire = async (
  deps: Pick<
    TickHandlerDeps,
    | 'redis'
    | 'symbolInfoCache'
    | 'reapAutoIfFlat'
    | 'appendActionLog'
    | 'notPermittedThrottle'
    | 'enqueueReconfigure'
    | 'logger'
  >,
  ctx: {
    scope: ProfileScope;
    profileId: ProfileId;
    symbol: string;
    mode: BinanceMode;
    latencyMs: number;
    nowMs: number;
  },
): Promise<TickResult | null> => {
  const { scope, profileId, symbol } = ctx;
  const info = await deps.symbolInfoCache.get(symbol, ctx.mode);
  // Re-validated, not trusted: the cache is read back through an unchecked cast,
  // and a drifted shape reaching the AND-of-ORs predicate would throw a
  // TypeError out of a tick that has no classifier for it — a permanent
  // dead-letter, the one outcome worse than a missed retirement.
  const permissionSets = projectPermissionSets(info.permissionSets);
  if (permissionSets === null) return null;

  const accountPermissions = await readAccountPermissions(
    deps.redis,
    deps.logger,
    scope.accountId,
    'tick-handler',
  );
  if (isSymbolPermittedForAccount({ permissionSets, accountPermissions })) return null;

  // Record the gap, not the corpus. `permissionSets` is exchange-controlled and
  // uncapped — a tokenised-equity symbol publishes hundreds of tags — and only
  // the sets the account satisfies nothing from are actionable. Counts carry the
  // rest, and the account's own tag list stays out of a row the log viewer
  // serves.
  const heldTags = new Set(accountPermissions);
  const unsatisfied = permissionSets.filter((set) => !set.some((tag) => heldTags.has(tag)));
  const outcome = await reapAndRecord(deps, ctx, {
    source: 'symbol-not-permitted',
    logFields: {
      mode: ctx.mode,
      needsOneOf: unsatisfied[0]?.slice(0, MAX_SAMPLED_TAGS) ?? [],
      unsatisfiedSetCount: unsatisfied.length,
      publishedSetCount: permissionSets.length,
      heldTagCount: accountPermissions.length,
    },
    removedMsg: `${symbol}: this account has no Binance permission to trade it — auto-added symbol removed`,
    heldMsg: `${symbol}: this account has no Binance permission to trade it and you still hold a position — left in place. Sell the position down to zero on Binance and it is removed automatically.`,
    notAutoMsg: `${symbol}: this account has no Binance permission to trade it but you pinned the symbol — left in place, unpin it to remove`,
    throttle: deps.notPermittedThrottle,
  });
  if (outcome !== 'removed') return null;
  return throttledSkip({ profileId, symbol, latencyMs: ctx.latencyMs });
};
