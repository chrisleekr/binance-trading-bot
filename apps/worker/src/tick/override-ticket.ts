// The paired release for the override the bundle-builder destructively consumes.
//
// The builder DELs the operator's Redis key early and on purpose: at-most-once
// has to hold structurally, not by convention, so the key is gone before the
// strategy can act on it. From that moment the operator's intent exists only in
// this process's memory, and every throw between there and `settleOverride` used
// to lose it outright: the key gone, the `override_actions` row still pending, no
// later tick able to retry. The operator pressed the button and nothing happened.
//
// This ticket is the acquire/release counterpart to that DEL. The assembler arms
// it the instant the builder hands over a consumed override; the handler marks it
// settled when the normal path takes ownership; a `finally` compensates whatever
// is left. One object, one compensating point, so a new throw site between them
// cannot reopen the hole.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { ManualOverridePayload } from '@app/contracts';
import type { ProfileScope } from '@app/db';
import { raceDeadline } from 'lib/race-deadline.js';
import { DEFAULT_PERSIST_TIMEOUT, settleOverride } from './override-settlement.js';
import type { TickHandlerDeps } from './tick-types.js';

/**
 * Verdict on whether the row this tick is holding is still the operator's live
 * intent. `gone` covers both "cancelled outright" and "cancelled, then replaced
 * by a newer override" — restoring the stale payload is wrong either way.
 */
type LivenessCheck = 'live' | 'gone' | 'unresolved';

/**
 * Outcome of claiming the row. `lost` and `unresolved` both bar the dispatch, but
 * they must not be collapsed: `lost` means the operator's cancel demonstrably won,
 * so their intent is settled and a retry is pointless, while `unresolved` means the
 * claim could not be confirmed either way. Re-arming an `unresolved` override is the
 * dangerous one — a Postgres that is alive but consistently slower than the persist
 * budget would consume, fail to confirm, stand down, re-arm, and repeat for the whole
 * 300 s window, and the symbol commits no state and places no orders meanwhile: no
 * trailing sell and no protective stop on a live position. So it settles instead,
 * exactly as a deterministic abort does.
 */
type ClaimVerdict = 'won' | 'lost' | 'unresolved';

/** What {@link createOverrideTicket} needs to run the compensating settle. */
export interface OverrideTicketDeps {
  readonly redis: Pick<Redis, 'set'>;
  readonly logger: Logger;
  readonly settleOverrideAction?: TickHandlerDeps['settleOverrideAction'];
  readonly notifyOverrideOutcome?: TickHandlerDeps['notifyOverrideOutcome'];
  /**
   * The still-live `override_actions` row for this symbol, or null once there is
   * none. An operator can revoke an override in the window between this tick's
   * consuming DEL and its compensation: the cancel route's `processing_at is null`
   * guard stops it deleting a row this tick is dispatching under, but a tick that
   * lost or released its claim is fair game, and a compensation that re-armed then
   * would resurrect a cancelled action and place a real order the operator revoked.
   *
   * One Postgres read, and ONLY on an abort that consumed an override: off the
   * warm path entirely, so it costs the ordinary tick nothing.
   */
  readonly findActiveOverride?: (
    scope: ProfileScope,
    symbol: string,
  ) => Promise<{ readonly id: string } | null>;
  /**
   * Records on the row that this tick took the override out of Redis and is about to
   * act on it. Fired from {@link OverrideTicket.markOrderAttempted} and awaited
   * before the executor dispatches, so a row that outlives its worker still proves a
   * tick owned it — which is the only thing that lets the stranded-row sweep tell
   * "no tick ran" (nothing was placed) from "a tick ran and never came back" (an
   * order may be live).
   *
   * Optional, same pattern as {@link OverrideTicketDeps.settleOverrideAction};
   * unwired, the tick behaves exactly as before and every stranded row falls back to
   * the undifferentiated `expired`.
   */
  readonly markOverridePickedUp?: TickHandlerDeps['markOverridePickedUp'];
  /**
   * Claims the row this tick is holding, so the operator's cancel can no longer
   * delete it out from under the dispatch. Fired from {@link OverrideTicket.arm} and
   * read at {@link OverrideTicket.whenClaimed}: arming is the earliest moment the
   * override is known to be consumed, and starting there overlaps the claim with
   * `strategy.tick()` instead of adding its round-trip to the tick's critical path.
   *
   * Optional, same pattern as {@link OverrideTicketDeps.settleOverrideAction};
   * unwired, every override reads as claimed and the tick behaves as before.
   */
  readonly claimOverrideAction?: TickHandlerDeps['claimOverrideAction'];
  /** Hands a claimed row back to the next tick. Forwarded to the re-arm. */
  readonly releaseOverrideClaim?: TickHandlerDeps['releaseOverrideClaim'];
  readonly symbol: string;
  /**
   * Wall clock, injected. Stamps the claim, and the stamp is the fence both the
   * claim and its release are matched on, so it has to come from the same source the
   * rest of the tick reads time from.
   */
  readonly nowMs: () => number;
  /** Deadline for the compensating settle's Postgres write. */
  readonly persistTimeoutMs?: number;
  /**
   * Milliseconds this tick has burned so far. Read at compensation time and
   * charged against the override's remaining window, so a re-arm restores the
   * operator's original deadline rather than restarting it.
   */
  readonly elapsedMs: () => number;
}

/** The override this tick took out of Redis, plus the ownership it was read under. */
export interface OverrideTicketArm {
  readonly scope: ProfileScope;
  readonly override: ManualOverridePayload;
  /** Remaining lifetime of the key at read time. Absent means no window to restore. */
  readonly ttlMs?: number;
}

export interface OverrideTicket {
  /**
   * Record that this tick now holds an override no longer present in Redis.
   * Synchronous and non-throwing: it runs inside the bundle assembler, which must not
   * fail on the ticket's account. Does NOT stamp the breadcrumb — at arm time it is
   * not yet known whether this tick will dispatch anything.
   */
  arm(armed: OverrideTicketArm): void;
  /**
   * Resolves to whether this tick owns the override's row: `true` once the claim
   * landed, or when there was nothing to claim (no override, or the dep is unwired).
   * `false` means the row was already claimed, already settled, or gone (the
   * operator's cancel won), and also covers a claim that could not be confirmed at
   * all, because an unproven claim leaves the cancel route's delete guard open and
   * dispatching under it is the harm this exists to prevent.
   *
   * The claim's DEADLINE is applied here, not where the claim was started: the wait
   * has to be budgeted from the moment the dispatch actually blocks on it. Bounded at
   * `arm` instead, the budget would be spent on the tick body that runs in between —
   * candle windows, which can fall back to a weight-governed REST call, plus
   * `tick()` itself — and any tick longer than the budget would throw away a claim
   * already in hand. Total tick time stays bounded (tick body + one persist budget),
   * so this still cannot hold the per-(profile, symbol) chain lock open indefinitely.
   *
   * Awaited before anything can reach the executor. Never rejects: the verdict is
   * the boolean, so a caller cannot mistake a fault for permission.
   */
  whenClaimed(): Promise<boolean>;
  /**
   * The `processing_at` stamp this tick claimed with, or null when it never claimed
   * (no override, or the dep is unwired). The fence for a release, so the caller that
   * owns the happy-path settle can hand it the same value the compensation would.
   */
  claimAt(): Date | null;
  /**
   * Resolves once the pick-up breadcrumb has landed, failed, or run out of time —
   * immediately, when there was nothing to stamp. The caller awaits it after
   * {@link OverrideTicket.markOrderAttempted} and before dispatching, so the row
   * can never say "no tick took this" about a tick that placed an order. Never
   * rejects: a lost breadcrumb costs the sweep its precision, and nothing else.
   */
  whenPickedUpStamped(): Promise<void>;
  /**
   * Record that the tick reached the executor carrying an order. After this the
   * override can never be re-armed: the order may have hit Binance, and handing
   * the same override to the next tick would risk a second live order.
   *
   * Also the trigger for the pick-up breadcrumb, because this is the exact moment
   * the breadcrumb's meaning becomes true. Stamping any earlier marks ticks that
   * provably dispatch nothing — a strategy that declined to act, an operator cancel
   * caught by the liveness check, a re-arm whose window later lapsed — and the sweep
   * would then raise a "an order may be live, check the exchange" alarm for an
   * override that never reached the exchange, while destroying the correct "nothing
   * ran, just press it again" reading of those rows.
   */
  markOrderAttempted(): void;
  /**
   * Record that the tick died at the strategy boundary. The cause may be this
   * override's payload or an assembler-drift bundle; the worker cannot tell which,
   * and does not need to — `tick()` is pure, so the next tick fails identically
   * either way. Re-arming would wedge the symbol, committing no state at all, until
   * the operator's window drains.
   */
  markDeterministicAbort(): void;
  /** Record that the normal path has taken ownership, so compensation must not run. */
  markSettled(): void;
  /** Settle or re-arm whatever the tick still holds. Idempotent; never throws. */
  compensate(): Promise<void>;
}

/**
 * Build the per-tick override ticket.
 *
 * Compensation is a no-op unless the tick both consumed an override AND failed to
 * settle it, which is every path that is not the happy one: the three rethrowing
 * catches, the two graceful skip-returns, and anything added later. Whether the
 * leftover override is re-armed or settled is NOT decided here — it goes through
 * {@link settleOverride} with an `aborted` fate so the re-arm shape (NX, remaining
 * PX window, supersede handling) has exactly one implementation.
 *
 * Never throws, deliberately: it runs from a `finally` while a real error is in
 * flight, and a throw from there would REPLACE that error with a bookkeeping one,
 * hiding the failure the operator actually needs to see.
 */
export const createOverrideTicket = (deps: OverrideTicketDeps): OverrideTicket => {
  let armed: OverrideTicketArm | null = null;
  // Resolved by default: a tick that never armed has nothing to stamp, and the
  // dispatch site must not have to know whether it did.
  let pickedUpStamp: Promise<void> = Promise.resolve();
  // The claim's round-trip, started at `arm` and left UNBOUNDED here on purpose: the
  // deadline belongs to whoever waits on it (see `verdict`). Null when there was
  // nothing to claim, which reads as `won`.
  let claimInFlight: Promise<ClaimVerdict> | null = null;
  // The stamp written into `processing_at`, kept so the release can be fenced on it.
  // Held even when the claim's reply never arrives: that is the case the fence exists
  // for, since the row may carry this stamp while the tick believes nothing.
  let claimAt: Date | null = null;
  // Memoised so the gate and the compensation observe ONE verdict. Re-deriving it
  // would give the second caller a fresh deadline and could answer differently.
  let claimVerdict: Promise<ClaimVerdict> | null = null;
  let settled = false;
  let orderAttempted = false;
  let deterministic = false;

  /**
   * Is the row still the operator's live intent? Deadline-bounded and never
   * throwing: this runs inside the per-(profile, symbol) chain lock, so a stalled
   * Postgres would hold up the NEXT tick for this symbol behind it.
   *
   * Unwired reads as `live`, preserving the behaviour of callers that cannot check.
   */
  const checkStillLive = async (held: OverrideTicketArm): Promise<LivenessCheck> => {
    const find = deps.findActiveOverride;
    if (!find) return 'live';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const row = await Promise.race([
        find(held.scope, deps.symbol),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('override liveness read exceeded its deadline')),
            deps.persistTimeoutMs ?? DEFAULT_PERSIST_TIMEOUT,
          );
          timer?.unref?.();
        }),
      ]);
      return row?.id === held.override.overrideActionId ? 'live' : 'gone';
    } catch {
      return 'unresolved';
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /**
   * Start the claim. Unbounded and non-throwing: the round-trip begins at `arm` so it
   * overlaps the tick body, and the deadline is applied by {@link verdict}, which is
   * where a caller actually waits on the answer.
   *
   * The CAS reply is preserved exactly. `false` from the repo means the operator's
   * cancel demonstrably won; a rejection means nobody can say. Collapsing those two
   * costs the operator either an outcome or a ticking symbol.
   */
  const startClaim = async (held: OverrideTicketArm): Promise<ClaimVerdict> => {
    const claim = deps.claimOverrideAction;
    if (!claim) return 'won';
    const at = new Date(deps.nowMs());
    claimAt = at;
    try {
      return (await claim(held.scope, held.override.overrideActionId, at)) ? 'won' : 'lost';
    } catch (err) {
      deps.logger.warn(
        {
          profileId: held.scope.profileId,
          symbol: deps.symbol,
          overrideActionId: held.override.overrideActionId,
          err: err,
        },
        'tick-handler: could not claim the override row; not dispatching, and not re-arming an override whose ownership is unknown',
      );
      return 'unresolved';
    }
  };

  /**
   * The one verdict this tick acts on, bounded and memoised.
   *
   * Fails CLOSED on a timeout, and to `unresolved` rather than `lost`: while the row is
   * unclaimed the cancel route will delete it, so dispatching under an unconfirmed
   * claim can put an order on the exchange for an action the operator was told was
   * cancelled — and re-arming it would loop that same unconfirmable claim until the
   * operator's window drains.
   */
  const verdict = (): Promise<ClaimVerdict> => {
    if (claimVerdict) return claimVerdict;
    const pending = claimInFlight;
    if (!pending) return Promise.resolve('won');
    claimVerdict = (async (): Promise<ClaimVerdict> => {
      let answer: ClaimVerdict = 'unresolved';
      await raceDeadline(
        () =>
          pending.then((result) => {
            answer = result;
          }),
        deps.persistTimeoutMs ?? DEFAULT_PERSIST_TIMEOUT,
        () => {
          deps.logger.warn(
            {
              profileId: armed?.scope.profileId,
              symbol: deps.symbol,
              overrideActionId: armed?.override.overrideActionId,
            },
            'tick-handler: claiming the override row exceeded its deadline; not dispatching, and not re-arming an override whose ownership is unknown',
          );
        },
        // `startClaim` already reports and absorbs its own rejection, so this arm is
        // only reachable if that contract breaks; report it rather than swallow it.
        (err: unknown) => {
          deps.logger.warn(
            { symbol: deps.symbol, err: err },
            'tick-handler: the override claim rejected outside its own handler',
          );
        },
      );
      return answer;
    })();
    return claimVerdict;
  };

  /**
   * Write the breadcrumb, bounded and swallowing both failure modes.
   *
   * Deadline-bounded like every other tick-path write: the stamp is awaited before
   * dispatch, so an unbounded Postgres stall here would stall the operator's
   * force-sell — and the tick holds the per-(profile, symbol) chain lock while it
   * waits.
   *
   * Both failure modes are swallowed, and the cost of that is real: `raceDeadline`
   * resolves rather than rejects, so a stamp that fails or misses its deadline still
   * lets the dispatch proceed, and a crash after it leaves an un-breadcrumbed row the
   * sweep calls `expired` — "no tick ran" — about an order that may be live. That is
   * the OPTIMISTIC direction, not a safe one. It is accepted because the alternative
   * is failing an operator's force-sell on a diagnostic write, and it is never
   * silent: each mode warns with the row's attribution.
   */
  const stampPickedUp = async (held: OverrideTicketArm): Promise<void> => {
    const mark = deps.markOverridePickedUp;
    if (!mark) return;
    const attribution = {
      profileId: held.scope.profileId,
      symbol: deps.symbol,
      overrideActionId: held.override.overrideActionId,
    };
    await raceDeadline(
      () => mark(held.scope, held.override.overrideActionId),
      deps.persistTimeoutMs ?? DEFAULT_PERSIST_TIMEOUT,
      () => {
        deps.logger.warn(
          attribution,
          'tick-handler: the override picked-up breadcrumb exceeded its deadline; a crash from here would look like a tick that never ran',
        );
      },
      (err: unknown) => {
        deps.logger.warn(
          { ...attribution, err: err },
          'tick-handler: could not write the override picked-up breadcrumb; a crash from here would look like a tick that never ran',
        );
      },
    );
  };

  return {
    arm(next) {
      // Deliberately does NOT stamp. The breadcrumb says "a tick was about to
      // dispatch", and at arm time that is not yet known — see
      // `markOrderAttempted`, which owns the stamp.
      armed = next;
      // It DOES claim, and here rather than at the dispatch gate: this is the moment
      // the operator's key is already gone, so it is the earliest the race can be
      // closed, and the round-trip then runs alongside `strategy.tick()` instead of
      // in front of the order. `startClaim` is async and absorbs its own faults, so a
      // dep that throws synchronously cannot escape this synchronous marker, and the
      // promise is safe to leave unawaited until the gate.
      claimInFlight = startClaim(next);
    },
    whenPickedUpStamped() {
      return pickedUpStamp;
    },
    async whenClaimed() {
      return (await verdict()) === 'won';
    },
    claimAt() {
      return claimAt;
    },
    markOrderAttempted() {
      // Once. A second call would re-enter a write the row guards anyway, and the
      // caller awaits whichever promise this leaves behind.
      if (orderAttempted) return;
      orderAttempted = true;
      // `stampPickedUp` is async, so a dependency that throws synchronously rejects
      // its promise rather than escaping into this synchronous marker.
      if (armed !== null) pickedUpStamp = stampPickedUp(armed);
    },
    markDeterministicAbort() {
      deterministic = true;
    },
    markSettled() {
      settled = true;
    },
    async compensate() {
      if (armed === null || settled) return;
      // Claim it before the await: at-most-once is the whole point, and a second
      // compensation (nested finallys, a future caller) must find nothing left.
      settled = true;
      const held = armed;
      try {
        // Settle the claim's fate FIRST. Bounded and non-throwing, and the gate may
        // never have run (an abort upstream of it), so this is the point where the
        // in-flight claim UPDATE is joined. Without it the release below can be issued
        // while the claim is still on the wire: the release matches nothing, the claim
        // then lands, and the tick leaves the key re-armed AND the row claimed — the
        // next tick cannot take it and an operator cancel is told the bot is acting on
        // an override nothing is acting on.
        const claim = await verdict();
        // Only a RE-ARM can resurrect a revoked action, and only an undispatched
        // abort can re-arm, so the check is scoped to that case. A dispatched abort
        // skips it and always settles: its `unknown` escalation is how the operator
        // learns an order may be live on the exchange, and deleting the row does
        // not un-place that order.
        if (!orderAttempted) {
          const liveness = await checkStillLive(held);
          if (liveness !== 'live') {
            // Fail CLOSED on `unresolved` too. Un-settled, the row is swept
            // `expired` and the operator can re-press; re-armed against a row we
            // could not verify, a cancelled force-sell executes for real.
            deps.logger.warn(
              {
                profileId: held.scope.profileId,
                symbol: deps.symbol,
                overrideActionId: held.override.overrideActionId,
                liveness,
              },
              liveness === 'gone'
                ? 'tick-handler: the operator cancelled this override while the tick held it; not re-arming a revoked action'
                : 'tick-handler: could not confirm this override is still live; not re-arming it, the stranded-row sweep will settle it',
            );
            return;
          }
        }
        await settleOverride({
          redis: deps.redis,
          logger: deps.logger,
          ...(deps.settleOverrideAction ? { settleOverrideAction: deps.settleOverrideAction } : {}),
          ...(deps.notifyOverrideOutcome
            ? { notifyOverrideOutcome: deps.notifyOverrideOutcome }
            : {}),
          // Only the settle knows whether it is about to re-arm, and the claim has to
          // come off exactly then, so the release travels with it rather than being
          // guessed at here.
          ...(deps.releaseOverrideClaim && claimAt !== null
            ? { releaseOverrideClaim: deps.releaseOverrideClaim, claimAt }
            : {}),
          scope: held.scope,
          symbol: deps.symbol,
          ...(deps.persistTimeoutMs === undefined
            ? {}
            : { persistTimeoutMs: deps.persistTimeoutMs }),
          override: held.override,
          ...(held.ttlMs === undefined ? {} : { ttlMs: held.ttlMs }),
          elapsedMs: deps.elapsedMs(),
          // The tick died before it could report a defer, and `supported` is left
          // unset because the ticket never sees `strategy.capabilities` and must not
          // assert what it cannot check.
          deferred: false,
          orderFate: {
            kind: 'aborted',
            dispatched: orderAttempted,
            deterministic,
            // Same futility test as `deterministic`, for the other cause that repeats
            // identically next tick: a Postgres that cannot answer the claim inside the
            // budget will not answer the retry's either.
            claimUnresolved: claim === 'unresolved',
          },
        });
      } catch (err) {
        deps.logger.warn(
          {
            profileId: held.scope.profileId,
            symbol: deps.symbol,
            overrideActionId: held.override.overrideActionId,
            err: err,
          },
          'tick-handler: could not compensate the override an aborted tick consumed; the stranded-row sweep will settle it',
        );
      }
    },
  };
};
