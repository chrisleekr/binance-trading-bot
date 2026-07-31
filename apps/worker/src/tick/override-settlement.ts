// Operator-override settlement.
//
// After the executor runs, an override the bundle-builder pulled out of Redis is
// either settled (its `override_actions` row stamped with the outcome the operator
// actually got) or re-armed (the Redis key restored so the next tick retries).
// The classifiers here decide which, by id-equality attribution and by whether a
// failed order provably never executed — the retry seam that keeps a stale-priced
// order from being replayed.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Decision } from '@app/strategy-core';
import {
  DAILY_ENTRY_HALT_REASON,
  type ManualOverridePayload,
  type OverrideOutcomeInput,
} from '@app/contracts';
import { profileKey, type ProfileScope } from '@app/db';
import { callAsync } from 'lib/call-async.js';
import { raceDeadline } from 'lib/race-deadline.js';
import type { AppliedDecision } from 'executor/live-executor.js';
import type { DecisionFailure, TickHandlerDeps } from './tick-types.js';

// Fallback budget when boot does not pass `persistTimeoutMs`. Boot maps the
// TICK_PERSIST_TIMEOUT_MS env var here so network-replicated storage can raise it.
export const DEFAULT_PERSIST_TIMEOUT = 100;

/**
 * Deadline for the override re-arm SET. Fixed 100ms Redis-write budget; the
 * re-arm runs inside the per-(profile, symbol) chain lock, so an
 * unbounded `ioredis` command (no client-side command timeout, and
 * `maxRetriesPerRequest: null` keeps it queued) would stall the NEXT tick for
 * this symbol behind it.
 */
export const REARM_TIMEOUT_MS = 100;

/**
 * Bound a write whose REPLY is load-bearing, by REJECTING at the deadline.
 *
 * The counterpart to {@link raceDeadline}, which resolves-and-discards because
 * its callers only ever wanted the write attempted. That is exactly wrong for the
 * re-arm SET: its `NX` reply is what decides whether the override row settles
 * (`superseded`) or stays pending (re-armed), so a silent resolve would be read
 * as "armed" when nothing was written. Rejecting hands the caller's existing
 * error path the verdict it can actually act on: leave the row pending and let
 * the stranded-row reaper resolve it.
 */
const rejectOnDeadline = <T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer?.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => timer && clearTimeout(timer));
};

/**
 * True iff a bundled override's action is one the strategy declares it honors.
 * A missing `kind` is a malformed/legacy bundle, not a capability mismatch, so
 * it is treated as supported and left to the strategy's own Zod narrowing. The
 * tick handler uses this to warn — not silently drop — a stale override for an
 * action the strategy does not support. Exported so the regression-prone
 * condition is unit-tested without the full tick-handler harness.
 */
export const isOverrideKindSupported = (
  operatorActions: readonly string[],
  kind: string | undefined,
): boolean => kind === undefined || operatorActions.includes(kind);

/**
 * What became of the orders this tick emitted to carry out the override.
 *
 * Attribution is by `intent.overrideActionId` equality and nothing else. A
 * heuristic ("the BUY the breaker dropped was probably the override's") settles
 * the wrong row the first time a tick emits an unrelated order, which is every
 * grid tick.
 */
export type OverrideOrderFate =
  /** The tick emitted no order carrying this override's id. */
  | { readonly kind: 'none' }
  /**
   * Binance accepted at least one of them. `reason` carries a sibling's failure
   * when the tick emitted more than one order under the same id and only some
   * landed — the operator's action DID partly execute, so this can never re-arm.
   */
  | { readonly kind: 'placed'; readonly reason?: string }
  /** Every one of them failed; the first verdict is carried whole. */
  | { readonly kind: 'failed'; readonly result: DecisionFailure }
  /** A breaker dropped the order before the executor ever saw it. */
  | { readonly kind: 'suppressed'; readonly reason: string }
  /**
   * The tick died before it could report a fate at all. The builder had already
   * removed the operator's Redis key, so nothing else will ever restore it.
   *
   * `dispatched` is whether the tick had reached the executor carrying an order. An
   * order that may have hit Binance must never be handed to another tick, while one
   * that provably never left is as safe to retry as a deferred override.
   *
   * `deterministic` is whether the override is what killed the tick — a throw at the
   * strategy boundary, which is pure and would therefore fail identically next tick.
   * It is this fate's futility test, the counterpart of `supported` for a defer and
   * `retryable` for a failed order: without it a poison override re-arms in a loop
   * and the symbol commits no state at all until the TTL drains.
   */
  | {
      readonly kind: 'aborted';
      readonly dispatched: boolean;
      readonly deterministic: boolean;
      /**
       * The tick could not confirm whether it owned the override's row. The second
       * futility test alongside `deterministic`, and it bars a re-arm for the same
       * reason: a Postgres that cannot answer the claim inside the persist budget will
       * not answer the retry's either, so the override would consume, stand down and
       * re-arm every tick until its window drained, with the symbol committing no state
       * and placing no orders the whole time.
       */
      readonly claimUnresolved?: boolean;
    };

/**
 * Is re-issuing this failed order safe AND worthwhile?
 *
 * The two questions are independent and both must be yes:
 *  - SAFE (`phase`): the order provably did not execute. `pre-call` never
 *    reached Binance; `rejected` means Binance parsed it and refused, which is
 *    equally conclusive. `ambiguous` may have filled — re-issuing risks a second
 *    live order — and `accepted` definitely did.
 *  - WORTH IT (`retryable`): the cause clears on its own. A weight throttle or a
 *    -1003 drains; a -2010 insufficient-balance does not, and looping on it to
 *    the TTL only buries the real reason the operator needs to read.
 *
 * The same question for EVERY order the tick emits, not just an override's: a
 * strategy's own protective stop that the weight throttle refused is exactly as
 * worth re-issuing as an operator's, and exactly as unsafe to re-issue after an
 * ambiguous failure.
 */
export const isOrderRetriable = (result: DecisionFailure): boolean =>
  (result.phase === 'pre-call' || result.phase === 'rejected') && result.retryable;

/** {@link isOrderRetriable} in the shape the override fate carries. */
const isOverrideRetriable = (fate: { readonly result: DecisionFailure }): boolean =>
  isOrderRetriable(fate.result);

/**
 * The outcome to record for a failed override order that will NOT be re-armed.
 * `ambiguous` is the only status the bot cannot resolve by itself, so it is the
 * only one that escalates to the operator.
 */
const outcomeOfFailure = (result: DecisionFailure): OverrideOutcomeInput => {
  if (result.phase === 'ambiguous') return { status: 'unknown', reason: result.reason };
  // The order is live on Binance; only the local write failed. "applied" is the
  // truth, and the bookkeeping error rides along so triage can find the orphan.
  if (result.phase === 'accepted') return { status: 'applied', reason: result.reason };
  return { status: 'rejected', reason: result.reason };
};

/**
 * Correlate an override with the orders this tick emitted for it, by id equality
 * and nothing else.
 *
 * The suppressed set is checked first: a breaker drops the order before the
 * executor runs, so a suppressed override order appears nowhere in `applied` and
 * would otherwise look like a strategy that simply chose not to act.
 *
 * ONE SUCCESS OUTWEIGHS ANY NUMBER OF FAILURES. A plugin that emits two orders
 * under one override id, the first accepted by Binance and the second refused by
 * the weight throttle, has already executed the operator's action; a "failed +
 * retryable" verdict would re-arm it and the next tick would re-place an order
 * that may already have filled. No plugin is trusted not to do that, so the
 * settle direction is the safe one by construction, not by convention.
 */
export const resolveOverrideOrderFate = (
  overrideActionId: string,
  applied: readonly AppliedDecision[],
  suppressed: readonly Decision[],
): OverrideOrderFate => {
  const isOurs = (d: Decision): boolean =>
    d.type === 'place-order' && d.intent.overrideActionId === overrideActionId;

  if (suppressed.some(isOurs)) return { kind: 'suppressed', reason: DAILY_ENTRY_HALT_REASON };

  const ours = applied.filter((a) => isOurs(a.decision));
  if (ours.length === 0) return { kind: 'none' };

  let failure: DecisionFailure | undefined;
  let anySucceeded = false;
  for (const a of ours) {
    if (a.result.ok) anySucceeded = true;
    else failure ??= a.result;
  }

  if (!failure) return { kind: 'placed' };
  // The failure's reason rides along so a partial fan-out is still triageable,
  // but the row settles `applied` — because something did.
  if (anySucceeded)
    return {
      kind: 'placed',
      reason: `a sibling order for this override failed: ${failure.reason}`,
    };
  return { kind: 'failed', result: failure };
};

/** Inputs to {@link settleOverride}. */
export interface SettleOverrideArgs {
  readonly redis: Pick<Redis, 'set'>;
  readonly logger: Logger;
  readonly settleOverrideAction?: TickHandlerDeps['settleOverrideAction'];
  readonly notifyOverrideOutcome?: TickHandlerDeps['notifyOverrideOutcome'];
  /**
   * Returns the row to pending, fired only on the re-arm branch: the claim exists to
   * protect a dispatch in flight, and a re-armed override has none. Left on, the row
   * would be uncancellable by the operator and unclaimable by the tick that picks the
   * restored key up, so the retry this branch exists to arrange could never happen.
   *
   * Requires {@link SettleOverrideArgs.claimAt}: the release is fenced on the stamp,
   * so a caller with no stamp has nothing it is entitled to clear.
   */
  readonly releaseOverrideClaim?: TickHandlerDeps['releaseOverrideClaim'];
  /**
   * The `processing_at` value this tick claimed with. Passed through as the release's
   * fence so it can only ever clear THIS tick's claim.
   */
  readonly claimAt?: Date;
  /** Ownership the tick already proved. Passed on so the settle re-resolves nothing. */
  readonly scope: ProfileScope;
  readonly symbol: string;
  /** Deadline for the settle's Postgres write. Defaults to the tick's persist budget. */
  readonly persistTimeoutMs?: number;
  readonly override: ManualOverridePayload;
  /** Remaining lifetime of the key at read time, captured before the bundle-builder's DEL. */
  readonly ttlMs?: number;
  /**
   * Time spent between that TTL read and this call (the tick's own latency).
   * Subtracted from `ttlMs` so a re-arm restores the operator's ORIGINAL deadline
   * instead of restarting the countdown — otherwise each defer would push the
   * deadline out by one tick.
   */
  readonly elapsedMs?: number;
  /** The strategy declined to act on the override for a transient reason. */
  readonly deferred: boolean;
  /**
   * The strategy declares this override's action in `capabilities.operatorActions`.
   * Optional because not every caller can see `strategy.capabilities`; absent reads
   * as "not established", never as "supported" — a caller that cannot check must
   * not be able to assert.
   */
  readonly supported?: boolean;
  /** The strategy's own words for why it emitted no order, when it said so. */
  readonly declineReason?: string;
  /** What happened to the order(s) the strategy emitted for this override. */
  readonly orderFate: OverrideOrderFate;
}

/**
 * Decide the fate of the override the bundle-builder already removed from Redis:
 * settle its row with the outcome the operator actually got, or re-arm the Redis
 * key so the next tick tries again.
 *
 * Re-arm in exactly three situations, and only while the operator's window still
 * has time left after this tick's own latency:
 *  - the strategy signalled a transient defer and could have acted (an
 *    unsupported action would loop to the TTL for nothing),
 *  - the override's order failed in a phase that proves it never executed AND
 *    for a cause that clears (see {@link isOverrideRetriable}), or
 *  - the tick itself aborted before dispatching anything AND the override is not
 *    what killed it, so the operator's intent is intact but the key it lived in is
 *    already gone.
 *
 * Everything else settles. Notably an AMBIGUOUS failure never re-arms: the order
 * may already be live on Binance and a retry would double it.
 *
 * `NX` is mandatory on the re-arm: the operator may have pushed a NEWER override
 * in the gap between the DEL and here, and restoring the stale one over it would
 * execute yesterday's intent. Losing that NX race is not a failure — the fresher
 * intent wins and the stale row settles as `superseded`.
 *
 * A re-armed override is deliberately NOT settled: the row stays pending, which
 * is the truth (nothing executed) and is what the SPA shows.
 *
 * Never throws. Orders are already placed and the audit shipped by the time this
 * runs; failing the tick here would re-run the strategy and double-emit, so a
 * Redis fault degrades to a warn.
 */
export const settleOverride = async (args: SettleOverrideArgs): Promise<void> => {
  const { redis, logger, scope, symbol, override, orderFate } = args;
  const { operatorId, accountId, profileId } = scope;
  // The window the operator armed, minus what this tick already spent.
  const remainingMs = (args.ttlMs ?? 0) - (args.elapsedMs ?? 0);

  const strategyDeferred = orderFate.kind === 'none' && args.deferred && args.supported === true;
  const orderRetriable = orderFate.kind === 'failed' && isOverrideRetriable(orderFate);
  // An aborted tick that never got as far as dispatching is in the same position
  // as a deferred one: nothing executed, so the operator's intent is still whole
  // and the next tick can carry it out.
  const abortedUndispatched =
    orderFate.kind === 'aborted' &&
    !orderFate.dispatched &&
    !orderFate.deterministic &&
    orderFate.claimUnresolved !== true;

  let outcome: OverrideOutcomeInput;
  if (orderFate.kind === 'aborted') {
    if (orderFate.dispatched) {
      // The order was in the executor's hands when the tick died, so whether it
      // reached Binance is genuinely unresolved. `unknown` is the one status that
      // escalates to the operator, which is right: only a human can check the book.
      outcome = {
        status: 'unknown',
        reason: 'the tick failed while dispatching this override; check the exchange',
      };
    } else if (orderFate.claimUnresolved === true) {
      // Nothing was dispatched, so this override provably did not execute. The row
      // gets a verdict instead of another re-arm: the operator can re-press once the
      // database is answering, and the symbol resumes ticking immediately, which
      // matters more than the retry, because a wedged symbol carries a live position
      // with no trailing sell and no protective stop.
      outcome = {
        status: 'rejected',
        reason: 'the bot could not confirm it owned this override; nothing was run, re-issue it',
      };
    } else if (orderFate.deterministic) {
      // The tick died at the strategy boundary, and would die there again on the
      // next one. Re-arming would wedge the symbol until the TTL: no state
      // committed, no trailing sell, no protective stop, on a live position.
      //
      // The reason states only what is observable. The same boundary covers the
      // bundle-schema gate, which fails on assembler drift in ANY slot, so blaming
      // the operator's payload would send them hunting a fault that is ours.
      outcome = {
        status: 'rejected',
        reason: 'the strategy failed on the tick carrying this override; nothing was run',
      };
    } else {
      // Either the window has already closed (an open one re-arms below and returns)
      // or the builder surfaced no TTL to restore, so there is no window to put the
      // override back into and the row is dead rather than pending.
      outcome = {
        status: 'expired',
        reason: 'a tick consumed this override and failed before it could be dispatched',
      };
    }
  } else if (orderFate.kind === 'suppressed') {
    // A breaker outlives the override's window by construction (the daily halt
    // runs to the next UTC day, the override lives 5 minutes), so re-arming is
    // provably futile. Settle it with the breaker's own words.
    outcome = { status: 'rejected', reason: orderFate.reason };
  } else if (orderFate.kind === 'placed') {
    outcome =
      orderFate.reason === undefined
        ? { status: 'applied' }
        : { status: 'applied', reason: orderFate.reason };
  } else if (orderFate.kind === 'failed') {
    outcome = outcomeOfFailure(orderFate.result);
  } else {
    // Three states, not two: a caller that could not establish `supported` must not
    // have the NEGATIVE assertion put in its mouth. Only an explicit `false` may say
    // the strategy does not support the action; absent falls back to the neutral
    // wording, which is true whatever the capability turns out to be.
    let reason: string;
    if (args.declineReason !== undefined) reason = args.declineReason;
    else if (args.supported === false) reason = 'this strategy does not support this action';
    else reason = 'the strategy did not act on this override';
    outcome = { status: 'rejected', reason };
  }

  if ((strategyDeferred || orderRetriable || abortedUndispatched) && remainingMs > 0) {
    const key = profileKey({ accountId, profileId }, 'override', symbol);
    // Drop the claim BEFORE the key goes back, and OUTSIDE the try below. Before,
    // because the moment the key exists again a tick can pick it up and it must be
    // able to claim it; outside, because a release fault must not skip the SET. That
    // would lose the operator's intent entirely, which is far worse than a row whose
    // claim the stale-claim reaper clears five minutes later.
    //
    // Not gated on believing the claim is HELD, only on having attempted one: a claim
    // whose acknowledgement was lost is precisely the case where that belief is wrong,
    // and precisely the case that would livelock the retry. Safe to fire regardless
    // because it is FENCED on the stamp this tick claimed with, so if the claim never
    // landed, or a different holder has the row now, the UPDATE matches nothing. An
    // unfenced release could not say that: `processing_at is not null` matches whoever
    // holds the row, so a release abandoned at its deadline under an earlier tick could
    // land later and strip a live claim off a dispatch already in flight.
    const release = args.releaseOverrideClaim;
    const claimAt = args.claimAt;
    if (release && claimAt) {
      await raceDeadline(
        () => release(scope, override.overrideActionId, claimAt),
        args.persistTimeoutMs ?? DEFAULT_PERSIST_TIMEOUT,
        () => {
          logger.warn(
            { profileId, symbol, overrideActionId: override.overrideActionId },
            'tick-handler: releasing the override claim exceeded its deadline; the re-armed override may be uncancellable until the stale-claim reaper clears it',
          );
        },
        (err: unknown) => {
          logger.warn(
            { profileId, symbol, overrideActionId: override.overrideActionId, err: err },
            'tick-handler: could not release the override claim; the re-armed override may be uncancellable until the stale-claim reaper clears it',
          );
        },
      );
    }
    try {
      const armed = await rejectOnDeadline(
        redis.set(key, JSON.stringify(override), 'PX', remainingMs, 'NX'),
        REARM_TIMEOUT_MS,
        `override re-arm exceeded ${REARM_TIMEOUT_MS}ms`,
      );
      if (armed !== null) {
        logger.warn(
          {
            profileId,
            symbol,
            overrideActionId: override.overrideActionId,
            kind: override.kind,
            ...(orderFate.kind === 'failed' ? { phase: orderFate.result.phase } : {}),
          },
          strategyDeferred
            ? 'tick-handler: strategy deferred the override — re-armed for the next tick'
            : abortedUndispatched
              ? 'tick-handler: the tick failed before this override was dispatched — re-armed for the next tick'
              : 'tick-handler: the override order never reached the book — re-armed for the next tick',
        );
        // Not settled: the row is still pending because nothing executed.
        return;
      }
      // NX refused: a NEWER override occupies the key. The fresher intent wins, so
      // the stale row can never execute — settle it instead of leaving it pending
      // forever.
      logger.warn(
        { profileId, symbol, overrideActionId: override.overrideActionId, kind: override.kind },
        'tick-handler: a newer override superseded this one; settling the stale row',
      );
      outcome = { status: 'superseded' };
    } catch (err) {
      logger.warn(
        {
          profileId,
          symbol,
          overrideActionId: override.overrideActionId,
          err: err,
        },
        'tick-handler: override re-arm failed — operator action lost, re-issue it',
      );
      // Not settled: a failed re-arm has still not executed anything, so marking
      // the row done would tell the operator a lie. The stranded-row reaper
      // resolves it once the Redis key's window has passed.
      return;
    }
  }

  // Fire-and-forget. The notify fans out to Postgres reads and N outbound webhook
  // calls, and it fires precisely when the network is already misbehaving — which
  // is the worst possible moment to hold the per-symbol chain lock open waiting
  // for it. The settled DB row below is the durable record; the notification is a
  // convenience on top of it, and it swallows its own errors.
  const notify = args.notifyOverrideOutcome;
  if (outcome.status === 'unknown' && notify) {
    void callAsync(() =>
      notify({
        operatorId,
        accountId,
        profileId,
        symbol,
        overrideActionId: override.overrideActionId,
        outcome,
      }),
    ).catch((err: unknown) => {
      logger.warn(
        { profileId, symbol, err: err },
        'tick-handler: could not notify the operator of an ambiguous override outcome',
      );
    });
  }

  const settleAction = args.settleOverrideAction;
  if (!settleAction) return;
  // Deadline-bounded, like every other write on the tick path: a stalled Postgres
  // must not stretch the tick (and with it the next tick for this symbol) without
  // limit. Missing the deadline only means the SPA shows the override as pending
  // for a moment longer; failing the tick instead would re-run the strategy and
  // double-emit, which is far worse than a stale badge.
  await raceDeadline(
    () => settleAction(scope, override.overrideActionId, outcome),
    args.persistTimeoutMs ?? DEFAULT_PERSIST_TIMEOUT,
    () => {
      logger.warn(
        { profileId, symbol, overrideActionId: override.overrideActionId },
        'tick-handler: settleOverrideAction exceeded its deadline; UI may show stale pending override',
      );
    },
    (err: unknown) => {
      logger.warn(
        {
          profileId,
          symbol,
          overrideActionId: override.overrideActionId,
          err: err,
        },
        'tick-handler: settleOverrideAction failed; UI may show stale pending override',
      );
    },
  );
};
