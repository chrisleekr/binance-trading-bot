// Shared tick-handler types.
//
// TickHandlerDeps and TickResult live apart from the handler so the leaf modules
// (override-settlement, tick-skip) can reference them via `Pick<>` and as return
// types without importing back into tick-handler.ts and forming a cycle.
// DecisionFailure and ReapOutcome sit here too because TickHandlerDeps names
// them: keeping the definitions upstream of every consumer keeps the graph
// one-way.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { MarketDataPort } from '@app/binance';
import type { DecisionResult, StrategyRegistry } from '@app/strategy-core';
import type { AccountId, OverrideOutcomeInput, ProfileId, UserId } from '@app/contracts';
import type { ActionLogInsert, ProfileScope } from '@app/db';
import type { ChainByKey } from 'lib/chain-by-key.js';
import type { LiveExecutor } from 'executor/live-executor.js';
import type { SnapshotColdLoad } from './snapshot-loader.js';
import type { AuditShipper } from 'audit-shipper/audit-shipper.js';
import type { MetricsSink, StatePort } from 'state/state-port.js';
import type { SymbolInfoCache } from './symbol-info-cache.js';
import type { ProfileTickContext } from './build-tick-input.js';
import type { FrameRecorder } from './frame-recorder.js';
import type { OrderRejectionIdentity, OrderRequestIdentity } from './order-refusal-circuit.js';

/** The failure arm of a {@link DecisionResult} — the one that carries `phase`. */
export type DecisionFailure = Extract<DecisionResult, { ok: false }>;

/**
 * Why a delisted (profile, symbol) binding was or wasn't reaped. Structurally the
 * db repo's `DiscoveryRemoveOutcome`; kept as a local alias so the handler stays
 * decoupled from the repo module.
 */
export type ReapOutcome = 'removed' | 'not-found' | 'not-auto' | 'held';

export interface TickHandlerDeps {
  readonly redis: Redis;
  readonly registry: StrategyRegistry;
  readonly executor: LiveExecutor;
  readonly chain: ChainByKey;
  readonly logger: Logger;
  readonly clock?: { nowMs(): number };
  readonly rng?: { next(): number };
  readonly coldLoad: SnapshotColdLoad;
  /**
   * Symbol filters/status for the tick's market snapshot. Its own deep
   * module (in-process cache + Redis copy + herd collapse + first-tick
   * prime), separate from the per-(profile, symbol) cold-load fallbacks.
   */
  readonly symbolInfoCache: SymbolInfoCache;
  /**
   * Per-(profile, symbol) state boundary. The tick reads through
   * `loadForTick` and commits through the load handle it returns;
   * event-driven mutations (fill-adopter, future reset paths) share the
   * same port instance and the same reconcile + migrate spine, so no caller
   * hand-rolls state I/O.
   */
  readonly statePort: StatePort;
  /**
   * Source of truth for the per-interval kline window. The port's ring
   * (in-memory, populated by the WS subscriber) plus its weight-governed
   * REST fallback replace the previous candle ZSET. See indicator-computer
   * and `loadWindow` on the port.
   */
  readonly marketDataPort: MarketDataPort;
  readonly candleWindowSize?: number;
  readonly resolveProfile: (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
    symbol: string,
  ) => Promise<ProfileTickContext | null>;
  readonly auditShipper: AuditShipper;
  readonly metrics?: MetricsSink;
  /**
   * Closes out the `override_actions` row for an operator-pushed override:
   * stamps `consumed_at` AND the outcome the operator actually got. Marking it
   * merely "consumed" is what let a refused, rejected, or breaker-suppressed
   * override read as success on the symbol page. Optional so test stubs that
   * don't exercise the override path can omit it; a missing function is a no-op.
   */
  readonly settleOverrideAction?: (
    scope: ProfileScope,
    overrideActionId: string,
    outcome: OverrideOutcomeInput,
  ) => Promise<void>;
  /**
   * The still-live `override_actions` row for a symbol, or null. Read ONLY when an
   * aborted tick is about to re-arm an override it consumed: the cancel route
   * deletes a pending row unconditionally, so without this a revoked force-sell
   * could be restored to Redis and executed for real by the next tick. Optional,
   * same pattern as {@link settleOverrideAction}; unwired, the check is skipped.
   */
  readonly findActiveOverride?: (
    scope: ProfileScope,
    symbol: string,
  ) => Promise<{ readonly id: string } | null>;
  /**
   * Stamps the `override_actions` row with the moment a tick took the override out
   * of Redis. Written once per override, before the executor dispatches, and read
   * by exactly one consumer: the stranded-row sweep, deciding whether a row that
   * outlived its worker means "no tick ran inside the window" (nothing was placed)
   * or "a tick ran and never came back" (an order may be live on the exchange).
   * Optional / no-op when unwired, same pattern as {@link
   * TickHandlerDeps.settleOverrideAction}.
   */
  readonly markOverridePickedUp?: (scope: ProfileScope, overrideActionId: string) => Promise<void>;
  /**
   * CAS-claims the `override_actions` row this tick took out of Redis, resolving to
   * whether THIS tick won it.
   *
   * The row is the only arbiter of the race between a tick placing the operator's
   * order and the operator cancelling it, because the cancel deletes an UNCLAIMED row
   * only. Without the claim that guard never engages: the cancel deletes the row from
   * under a mid-flight tick, the operator is told the action was cancelled, and the
   * order still reaches Binance. `false` is the mirror case: the operator's cancel
   * won the CAS, so nothing may be dispatched or the bot executes an action it
   * truthfully reported as cancelled.
   *
   * `at` is the value to stamp into `processing_at`, supplied by the caller so it can
   * fence its own {@link TickHandlerDeps.releaseOverrideClaim} on it later, including
   * when this call's reply never arrives.
   *
   * Optional, same pattern as {@link TickHandlerDeps.settleOverrideAction}; unwired,
   * the tick treats every override as claimed and behaves exactly as before.
   */
  readonly claimOverrideAction?: (
    scope: ProfileScope,
    overrideActionId: string,
    at: Date,
  ) => Promise<boolean>;
  /**
   * Returns a claimed row to pending. Fired before an override is re-armed into
   * Redis: a re-armed row still holding its claim is invisible to the operator's
   * cancel AND unclaimable by the tick that picks the key back up, so the override
   * could neither be cancelled nor ever run again until the stale-claim reaper
   * cleared it.
   *
   * Not gated on believing the claim is held, since a lost acknowledgement is exactly
   * the case where that belief is wrong and a livelock follows. What makes that safe is
   * `at`: the release is FENCED on the stamp the claim was made with, so it clears this
   * caller's claim or nothing at all. An unfenced release is a live hazard rather than
   * a tidy-up, because a deadline abandons its write without cancelling it, and that
   * write can land while a later tick holds the row.
   */
  readonly releaseOverrideClaim?: (
    scope: ProfileScope,
    overrideActionId: string,
    at: Date,
  ) => Promise<void>;
  /**
   * Escalates an override whose order may or may not have executed. Only fired
   * for the `unknown` outcome: that is the one case the bot cannot resolve on
   * its own and a human must check the exchange.
   */
  readonly notifyOverrideOutcome?: (input: {
    readonly operatorId: UserId;
    readonly accountId: AccountId;
    readonly profileId: ProfileId;
    readonly symbol: string;
    readonly overrideActionId: string;
    readonly outcome: OverrideOutcomeInput;
  }) => Promise<void>;
  /**
   * Tells the operator the bot could not place (or could not cancel) an order.
   * Usually the protective stop, so the position may be sitting unguarded — the
   * one class of failure that is invisible on every screen until the loss lands.
   * Owns its own repeat-suppression; the tick fires it and does not wait.
   */
  readonly notifyOrderFailed?: (input: {
    readonly operatorId: UserId;
    readonly accountId: AccountId;
    readonly profileId: ProfileId;
    readonly symbol: string;
    readonly decisionType: 'place-order' | 'cancel-order';
    readonly result: DecisionFailure;
    readonly willRetry: boolean;
  }) => Promise<void>;
  /** Records the durable diagnosis surface after the Redis circuit state is known durable. */
  readonly recordOrderRefusalCondition?: (
    scope: ProfileScope,
    input: {
      readonly symbol: string;
      readonly code: string | null;
      readonly changeKey?: string;
      readonly detail?: unknown;
      readonly now: Date;
      readonly msg: string;
    },
  ) => Promise<void>;
  /** Sends the dedicated trip or probe alert. Repeat suppression belongs to the caller. */
  readonly notifyOrderRefusalLoop?: (input: {
    readonly operatorId: UserId;
    readonly accountId: AccountId;
    readonly profileId: ProfileId;
    readonly symbol: string;
    readonly identityKey: string;
    readonly request: OrderRequestIdentity;
    readonly rejection: OrderRejectionIdentity;
    readonly probe: boolean;
  }) => Promise<void>;
  /**
   * Tells the operator a protective stop could not be placed at all. Distinct
   * from {@link notifyOrderFailed}: nothing was sent, so there is no failure to
   * report. The exchange's price band cannot admit the stop, the strategy defers
   * the re-arm rather than burning retries on a refusal it cannot clear, and the
   * position may be sitting with nothing under it while every screen looks
   * normal. `terminal` says whether any price could ever arm it, which is what
   * splits "wait for the price to come back" from "widen the offset", and what
   * keeps the two on separate suppression windows. Owns its own repeat
   * suppression; the tick fires it and does not wait.
   */
  readonly notifyProtectiveStopBlocked?: (input: {
    readonly operatorId: UserId;
    readonly accountId: AccountId;
    readonly profileId: ProfileId;
    readonly symbol: string;
    readonly reason: string;
    /** The strategy's own live record: prices, band bounds, and which side was breached. */
    readonly detail: Readonly<Record<string, unknown>>;
    readonly terminal: boolean;
    /** When the block opened, or null when no condition row could date it. */
    readonly sinceMs: number | null;
  }) => Promise<void>;
  /**
   * Reap a (profile, symbol) binding that can never trade again — Binance no
   * longer lists the symbol, or the account holds no permission for it — but
   * ONLY when it is safe to abandon: discovery-owned (`source=auto`) AND flat.
   * Returns why it did or didn't: `removed` (reaped), `held` (still carries a
   * position/order), `not-auto` (operator-pinned), `not-found` (already gone).
   * Optional so a stub that never exercises either self-heal can omit it; a
   * missing function is a no-op (the tick still self-heals to a skip).
   */
  readonly reapAutoIfFlat?: (scope: ProfileScope, symbol: string) => Promise<ReapOutcome>;
  /**
   * Append one operator-visible action_log row. Used by both tick-boundary
   * self-heals to record the reap (or why it couldn't). Optional / no-op when
   * unwired, same pattern as {@link settleOverrideAction}.
   */
  readonly appendActionLog?: (
    scope: ProfileScope,
    input: Omit<ActionLogInsert, 'profileId'>,
  ) => Promise<void>;
  /**
   * Cross-process suppression window (Redis key per profile+symbol, not global)
   * for the delisted-but-unreapable alert. A held or pinned delisted symbol throws
   * the same way every tick, so the warn action_log is gated to one per window.
   * `allow(key)` true = emit. Fails OPEN. Optional / always-emit when unwired.
   */
  readonly delistThrottle?: { allow(key: string): Promise<boolean> };
  /**
   * The same suppression window for the symbol-the-account-cannot-trade alert,
   * on its OWN Redis key namespace — not {@link delistThrottle}'s, and not the
   * executor's placement-refusal one. Every such window is keyed (profile,
   * symbol), so a shared prefix is a shared key and whichever cause fired first
   * mutes the rest for the whole window. Fails OPEN — a Redis fault emits the
   * record rather than costing the self-heal. Optional / always-emit when
   * unwired.
   */
  readonly notPermittedThrottle?: { allow(key: string): Promise<boolean> };
  /**
   * Enqueue a `reconfigure-profile` job after a binding is reaped, so the
   * WS subscriber drops the now-unbound symbol promptly instead of waiting for the
   * next discovery pass. Fired ONLY on a `removed` reap. Best-effort: a throw is
   * swallowed (the tick still self-heals to a skip). Optional / no-op when unwired.
   */
  readonly enqueueReconfigure?: (args: {
    readonly userId: UserId;
    readonly accountId: AccountId;
    readonly profileId: ProfileId;
  }) => Promise<void> | void;
  readonly persistTimeoutMs?: number;
  /**
   * Optional record->replay frame tracer. When present (WORKER_FRAME_TRACE=1 at
   * boot) the handler appends one frame tuple per successful tick so the trace
   * can be replayed offline and asserted drift-free. Absent → a true no-op
   * (single `if` guard, no other cost) on the hot path.
   */
  readonly frameRecorder?: FrameRecorder;
}

export interface TickResult {
  readonly profileId: ProfileId;
  readonly symbol: string;
  readonly latencyMs: number;
  readonly decisionCount: number;
  readonly throttled: boolean;
}
