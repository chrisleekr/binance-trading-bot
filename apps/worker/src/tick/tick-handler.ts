// TickHandler: the body of every `tick` job.
//
// 1. chainByKey serialises calls per (profileId, symbol)
// 2. Read snapshot via single Redis pipeline (snapshot-loader)
// 3. Cold-load on miss (PG via repository) + write-through
// 4. Migration check: if registry.version != profile.strategy_version
//      → pg_advisory_xact_lock(hashtext('migrate:'||userId||':'||profileId))
//      → CAS re-read
//      → migrateState({ fromVersion, state })
//      → persist nextState + new version atomically
// 5. strategy.tick(input): pure
// 6. LiveExecutor.applyAll(decisions); see 06.08
// 7. Persist nextState: Redis SET (in MULTI with KV decisions) +
//    Postgres UPDATE (fire-and-await with 100ms timeout)
// 8. PUBLISH events:<u>:<p>  +  XADD events:<u>:<p>:stream MAXLEN ~ 1000
// 9. Audit XADD (audit-shipping hook)
// 10. Metrics

import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import type { Decision, TickOutput, TriggerEvent } from '@app/strategy-core';
import { asAccountId, asProfileId, asUserId, type ManualOverridePayload } from '@app/contracts';
import { profileKey } from '@app/db';
import type { TickJobData } from 'queues/job-payloads.js';
import { callAsync } from 'lib/call-async.js';
import { raceDeadline } from 'lib/race-deadline.js';
import type { AppliedDecision } from 'executor/live-executor.js';
import { readRawSnapshot } from './snapshot-loader.js';
import { buildOrderRearmKey, buildProfileTickMetaKey } from 'executor/redis-namespace.js';
import type { AuditEntry } from 'audit-shipper/audit-shipper.js';
import { mergeStrategyAudit } from './merge-strategy-audit.js';
import { tickInputDigest } from './tick-input-digest.js';
import { buildTickInput, type BuiltTick } from './build-tick-input.js';
import { errorMessage } from '@app/core/error';
import type { DecisionFailure, TickHandlerDeps, TickResult } from './tick-types.js';
import { applyDailyHalt } from './halt-filter.js';
import { extractLivePrice, mapEventToTrigger, tickIntervals } from './tick-event.js';
import { redisUnavailableSkip, symbolDelistedReap, throttledSkip } from './tick-skip.js';
import {
  DEFAULT_PERSIST_TIMEOUT,
  isOrderRetriable,
  isOverrideKindSupported,
  REARM_TIMEOUT_MS,
  resolveOverrideOrderFate,
  settleOverride,
} from './override-settlement.js';
import { createOverrideTicket } from './override-ticket.js';

export type { TickHandlerDeps, TickResult };

// Deadline for the per-tick UI tick-meta Redis SET. Fixed at 100ms: this is a
// Redis (not Postgres) write, so it is unaffected by the storage-latency reasons
// the persist budget is tunable for.
const STAMP_TIMEOUT_MS = 100;

/**
 * How long the re-arm flag survives with no further tick. Several tick periods:
 * long enough that a genuine retry sequence keeps it alive, short enough that a
 * paused profile does not resume weeks later still claiming to be retrying.
 */
const REARM_WINDOW_MS = 900_000;

export const createTickHandler = (
  deps: TickHandlerDeps,
): ((job: Job<TickJobData>) => Promise<TickResult>) => {
  const clock = deps.clock ?? { nowMs: () => Date.now() };
  const rng = deps.rng ?? { next: () => 0 };
  const persistTimeoutMs = deps.persistTimeoutMs ?? DEFAULT_PERSIST_TIMEOUT;

  return async (job) => {
    const data = job.data;
    const operatorId = asUserId(data.userId);
    const accountId = asAccountId(data.accountId);
    const profileId = asProfileId(data.profileId);
    const symbol = data.symbol;

    return deps.chain.run(`${profileId}:${symbol}`, async () => {
      const startMs = clock.nowMs();

      // The paired release for the bundle-builder's destructive override DEL.
      // Armed by the assembler the moment an override is consumed, disarmed at the
      // settle below, and compensated in the `finally` on every other way out:
      // three rethrowing catches and two graceful skip-returns today, plus
      // whatever gets added later. Compensating INSIDE the chain lock is
      // load-bearing: released first, the next tick for this symbol could consume a
      // newer override and this one's re-arm would then write the stale intent back
      // over an empty key, executing it.
      const overrideTicket = createOverrideTicket({
        redis: deps.redis,
        logger: deps.logger,
        ...(deps.settleOverrideAction ? { settleOverrideAction: deps.settleOverrideAction } : {}),
        ...(deps.notifyOverrideOutcome
          ? { notifyOverrideOutcome: deps.notifyOverrideOutcome }
          : {}),
        ...(deps.findActiveOverride ? { findActiveOverride: deps.findActiveOverride } : {}),
        ...(deps.markOverridePickedUp ? { markOverridePickedUp: deps.markOverridePickedUp } : {}),
        ...(deps.claimOverrideAction ? { claimOverrideAction: deps.claimOverrideAction } : {}),
        ...(deps.releaseOverrideClaim ? { releaseOverrideClaim: deps.releaseOverrideClaim } : {}),
        symbol,
        persistTimeoutMs,
        nowMs: () => clock.nowMs(),
        elapsedMs: () => clock.nowMs() - startMs,
      });

      try {
        // Best-effort stamp of operational tick metadata. Deadline-bounded (see
        // `raceDeadline`): a timeout, a rejection or a synchronous throw here only
        // delays the UI tick-health by one tick and never bubbles to the strategy.
        const stampTickMeta = (latencyMs: number, error: string | null): Promise<void> =>
          raceDeadline(
            // The key builder, the clock read, the ISO format and the serialise all sit
            // inside the thunk: each can throw, and outside it any of them would unwind a
            // tick that has already acted. `latencyMs` and `error` stay caller-supplied,
            // so the callers deriving them from `clock.nowMs()` or `errorMessage(err)`
            // still evaluate those outside the guard.
            () =>
              deps.redis.set(
                buildProfileTickMetaKey(accountId, profileId),
                JSON.stringify({
                  lastTickAt: new Date(clock.nowMs()).toISOString(),
                  lastTickLatencyMs: latencyMs,
                  lastTickError: error,
                }),
              ),
            STAMP_TIMEOUT_MS,
            () => {
              deps.logger.warn(
                { profileId, symbol },
                `tick: stampTickMeta exceeded ${STAMP_TIMEOUT_MS}ms (UI tick-health will lag one tick)`,
              );
            },
            (err: unknown) => {
              deps.logger.warn(
                { profileId, symbol, err: err },
                'tick: stampTickMeta failed (UI tick-health will lag one tick)',
              );
            },
          );

        const profile = await deps.resolveProfile(operatorId, accountId, profileId, symbol);
        if (!profile) {
          deps.logger.warn(
            { profileId, symbol },
            'tick: no profile context resolved (profile disabled?)',
          );
          return {
            profileId,
            symbol,
            latencyMs: clock.nowMs() - startMs,
            decisionCount: 0,
            throttled: false,
          };
        }

        const strategy = deps.registry.get(profile.strategyName);
        if (!strategy) {
          throw new Error(`tick: strategy "${profile.strategyName}" not registered`);
        }

        const intervals = tickIntervals(profile.candleInterval);
        const raw = await readRawSnapshot(deps.redis, {
          accountId,
          profileId,
          symbol,
          intervals,
          nowMs: startMs,
        });

        // Read + assemble the TickInput through the assembler: parse-or-
        // cold-load account + open-orders, reconcile + migrate the state
        // slice, source candles + revive indicators, build the market
        // snapshot. A migration failure throws (already logged by the
        // assembler); stamp tick-meta before the job DLQs so the operator
        // sees a diagnosable line, not a bare stack trace.
        const trigger: TriggerEvent = mapEventToTrigger(data);
        let built: BuiltTick;
        try {
          built = await buildTickInput(deps, {
            profile,
            strategy,
            raw,
            intervals,
            clock,
            rng,
            trigger,
            livePrice: extractLivePrice(data),
            overrideTicket,
          });
        } catch (err) {
          const latencyMs = clock.nowMs() - startMs;
          await stampTickMeta(latencyMs, errorMessage(err));
          // A symbol Binance no longer lists on this profile's mode is a
          // self-healing skip, not a dead-letter: reap the flat auto-added binding
          // and return a graceful skip so the job never retries a symbol that will
          // not come back. Checked before the governor case; a non-delisted error
          // returns null and falls through. `profile` was resolved above.
          const delistSkip = await symbolDelistedReap(err, deps, {
            scope: profile.scope,
            profileId,
            symbol,
            latencyMs,
            nowMs: clock.nowMs(),
          });
          if (delistSkip) return delistSkip;
          // Governor bulk-read backpressure is a self-healing skip, not a job
          // failure: tick-meta stamped above, metric + warn recorded in the helper,
          // the next market event re-ticks. A non-matching error rethrows so a
          // genuine failure still dead-letters.
          const skip = redisUnavailableSkip(err, deps, { profileId, symbol, latencyMs });
          if (skip) return skip;
          throw err;
        }

        // Kill-switch short-circuit. The strategy keeps the WS subscriptions
        // open so a fast resume is possible; we just emit a noop tick.
        if (built.kind === 'kill-switch') {
          deps.metrics?.record('tick_throttled_kill_switch', 1, {
            profileId,
            symbol,
          });
          const killLatencyMs = clock.nowMs() - startMs;
          await stampTickMeta(killLatencyMs, null);
          return throttledSkip({ profileId, symbol, latencyMs: killLatencyMs });
        }

        // Per-symbol pause short-circuit. A paused coin freezes new buy+sell
        // decisions: a silent throttled noop, no action-log, no cancel, no sell.
        // Resting orders stay live; the next event re-ticks once the pause clears.
        if (built.kind === 'symbol-paused') {
          deps.metrics?.record('tick_throttled_symbol_pause', 1, {
            profileId,
            symbol,
          });
          const pauseLatencyMs = clock.nowMs() - startMs;
          await stampTickMeta(pauseLatencyMs, null);
          return throttledSkip({ profileId, symbol, latencyMs: pauseLatencyMs });
        }

        const { input: tickInput, commit } = built;

        let output: TickOutput<unknown>;
        try {
          // Fail closed on a schema-invalid assembled bundle. The bundle-builder's
          // sub-parsers already degrade bad Redis sub-values to null (fail open);
          // this rejects an ASSEMBLED bundle the strategy cannot consume, i.e. an
          // assembler-drift bug, before it reaches tick(). A throw here is caught
          // below like any tick failure: the job DLQs and state stays uncommitted.
          strategy.bundleSchema.parse(tickInput.bundle);
          output = strategy.tick(tickInput) as TickOutput<unknown>;
        } catch (err) {
          // A failure at the strategy boundary is deterministic in this override:
          // `tick()` is pure, and an assembler-drift bundle re-assembles the same
          // way, so the next tick would die here too. Compensating with a re-arm
          // would loop a poison override to the TTL, and the symbol would commit no
          // state at all for that window — no trailing sell, no protective stop, on
          // a live position. Mark it before the rethrow so the ticket settles instead.
          overrideTicket.markDeterministicAbort();
          deps.logger.error({ profileId, symbol, err: err }, 'tick threw, DLQ + state untouched');
          await stampTickMeta(clock.nowMs() - startMs, errorMessage(err));
          throw err;
        }

        // Record->replay frame trace: capture the verbatim Redis blobs, the
        // live-price override, the trigger, the serialisable profile slice, and the
        // strategy's decisions so this exact tick can be replayed offline and
        // asserted drift-free. Only after tick() succeeds (a thrown tick has no
        // decisions to assert). A true no-op when tracing is off.
        if (deps.frameRecorder) {
          deps.frameRecorder.record({
            raw,
            livePrice: extractLivePrice(data),
            trigger,
            intervals,
            profile: {
              userId: operatorId,
              profileId,
              symbol,
              strategyName: profile.strategyName,
              strategyVersion: profile.strategyVersion,
              candleInterval: profile.candleInterval,
              binanceMode: profile.binanceMode,
              quoteAsset: profile.quoteAsset,
              weightLimit1m: profile.weightLimit1m,
              needsAccountDeployedQuote: profile.needsAccountDeployedQuote,
              reserveBaseQuantity: profile.reserveBaseQuantity,
              config: profile.config,
            },
            decisions: output.decisions,
          });
        }

        // Forward strategy-emitted log entries to the worker logger at the
        // matching level. Strategies are pure (no `console.log` allowed) so
        // they buffer their diagnostics into `output.logs`; without this
        // forwarding step every `tt-technicals-gate-veto`, `tt-manual-order-skipped`,
        // and friends get discarded before reaching Datadog or the operator.
        // Profile + symbol are pinned on every entry so the line is
        // greppable across multi-profile runs.
        for (const entry of output.logs) {
          // Strategy context first, pinned fields second, so an entry that
          // happens to carry its own profileId/symbol (e.g., a tt-cross-symbol
          // log when grid trades land) cannot overwrite the canonical
          // attribution and silently misroute the log in Datadog.
          const ctx = { ...(entry.context ?? {}), profileId, symbol };
          deps.logger[entry.level](ctx, entry.message);
        }

        // Daily-loss circuit breaker: when the portfolio-risk cron has flagged this
        // profile (today's realised loss hit its limit), suppress new BUY orders for
        // the rest of the UTC day. SELLs, cancels, and events still flow so exits and
        // protective stops keep running. Fail-open (see applyDailyHalt). The flag
        // self-clears at the next UTC day. This is the ONLY breaker that pauses buys —
        // config-proof and edge-decay are advisory (dashboard + heads-up), never a halt.
        const decisions: readonly Decision[] = output.decisions;
        const halt = await applyDailyHalt(
          deps.redis,
          profileKey({ accountId, profileId }, 'entryHaltDaily'),
          decisions,
          deps.logger,
          { profileId, symbol },
        );
        // Did an earlier tick for this (profile, symbol) leave an order un-placed and
        // its state un-advanced? Then this tick is that retry, and the audit says so.
        // Read as part of the tick's opening snapshot pipeline rather than as its own
        // round-trip here: this flag is audit attribution, never a decision input, and
        // the only writer is this same handler strictly further down, so the earlier
        // read observes the identical value.
        const wasRearmed = raw.orderRearm !== null;

        // Hand the executor the ownership proof this tick already resolved, plus
        // the config scalars it already read, so the bindings build reuses both
        // instead of re-running `scopeProfile` and re-reading `profile.findById`.
        //
        // `applyAll` fails CLOSED on a contract violation (a tick emitting more than
        // one place-order): it throws before transmitting anything. Stamp tick-meta
        // so the DLQ line is diagnosable — mirroring the strategy.tick() DLQ path —
        // then RE-THROW so the job fails and the state stays un-committed. applyAll
        // already logged the cause with profile attribution, so no second log here.
        let applied: readonly AppliedDecision[];
        // The override's row is the arbiter of the race with an operator cancel, and
        // this is where the verdict is enforced. `false` means the row is no longer
        // ours to act on: the operator cancelled it, or the claim could not be
        // confirmed and the cancel route's delete guard is therefore still open.
        //
        // The WHOLE tick stands down, not just the override's own decisions. The
        // simpler rule is also the safer one: the strategy's decisions were derived
        // from a bundle carrying an override that turned out not to be ours, so the
        // next tick should re-derive them from state rather than this one dispatching
        // a subset of them. Positioned before `markOrderAttempted()` so compensation
        // still sees `orderAttempted === false` and can hand the override back; state
        // is not committed and the audit is not published until further down, so
        // returning here leaves nothing half-applied.
        if (!(await overrideTicket.whenClaimed())) {
          deps.metrics?.record('tick_throttled_override_claim', 1, { profileId, symbol });
          const claimLatencyMs = clock.nowMs() - startMs;
          await stampTickMeta(claimLatencyMs, null);
          return throttledSkip({ profileId, symbol, latencyMs: claimLatencyMs });
        }
        // Past this line an order may be on the wire, so an abort can no longer
        // re-arm the override: the next tick would place a second one under a fresh
        // clientOrderId, which Binance's open-order dedup does not catch. Coarse on
        // purpose (any place-order, not just the override's) — the same fail-safe the
        // defer path applies, and for the same reason: no plugin is trusted to have
        // stamped the override id on the order it emitted. `cancel-order` alone does
        // not trip it, matching that same scoping: nothing can be left resting.
        if (halt.kept.some((d) => d.type === 'place-order')) overrideTicket.markOrderAttempted();
        // That marker also started the pick-up breadcrumb, and this is the last point
        // at which it is still worth having: past here an order may be on the wire,
        // and a crash then must not leave a row that reads "no tick ever ran inside
        // the window". Bounded and non-throwing, so the worst it can cost a dispatch
        // is the persist budget; a tick that emitted no order stamps nothing and this
        // resolves immediately.
        await overrideTicket.whenPickedUpStamped();
        try {
          applied = await deps.executor.applyAll(
            { userId: operatorId, profileId, clock, strategyName: strategy.name },
            accountId,
            halt.kept,
            profile.scope,
            { quoteAsset: profile.quoteAsset, weightLimit1m: profile.weightLimit1m },
          );
        } catch (err) {
          await stampTickMeta(clock.nowMs() - startMs, errorMessage(err));
          throw err;
        }

        // What happened to the ORDER decisions. `applyAll` stops the chain at the
        // first failed order and records every decision behind it as skipped, so the
        // first failure here is the real one and the rest are its bystanders.
        const orderFailure = applied.find(
          (a) =>
            (a.decision.type === 'place-order' || a.decision.type === 'cancel-order') &&
            a.result.ok === false,
        );
        const failure: DecisionFailure | undefined =
          orderFailure && orderFailure.result.ok === false ? orderFailure.result : undefined;
        const willRetry = failure !== undefined && isOrderRetriable(failure);
        const rearmKey = buildOrderRearmKey(profileId, symbol);

        // Whether it is SAFE to commit turns on THE PLACEMENT, and on its `phase`
        // ALONE. Two separate traps here:
        //
        //  - Not on the FIRST failed order. Momentum's exit emits [cancel(stop),
        //    MARKET SELL] with a FLAT nextState. A cancel that dies on a transport
        //    error returns `ambiguous`; the chain breaks and the SELL is stamped
        //    SKIPPED — never transmitted. Reading the CANCEL's phase would say
        //    "accepted/ambiguous ⇒ commit", and the bot would record itself flat while
        //    the coin is still in the wallet and its stop may still be resting. The
        //    question `nextState` hangs on is whether the ORDER IT ASSUMED WAS PLACED
        //    was placed. `applyAll` throws before applying anything if a tick emits
        //    more than one place-order, so there is at most one such decision to ask.
        //  - Not on `retryable`. That answers a different question — would a retry ever
        //    succeed — and the two are orthogonal. A SELL refused -1013 / -2010 (both
        //    non-retryable) never executed, so the flat state is a LIE either way.
        const placement = applied.find(
          (a) => a.decision.type === 'place-order' && a.result.ok === false,
        );
        const placementResult: DecisionFailure | undefined =
          placement && placement.result.ok === false ? placement.result : undefined;
        const orderDidNotExecute =
          placementResult !== undefined &&
          (placementResult.phase === 'pre-call' || placementResult.phase === 'rejected');

        // Commit the per-symbol slice through the load handle: PG-first
        // two-column write stamped at the version the read settled on (the
        // closure captured it, NOT a blind `strategy.version`), then a Redis
        // cache refresh. The PG write is raced against `persistTimeoutMs`; a
        // stalled persister degrades to a warn so the tick continues.
        //
        // UNLESS the order provably never executed. Then the state is deliberately
        // left UN-ADVANCED: a strategy that now believes its stop is armed would
        // never emit it again, so committing `nextState` would bury the failure
        // permanently. The un-advanced state makes the next tick recompute from fresh
        // market data and re-emit the order. THAT is the retry — there is no replay
        // queue and there must not be one, because a replayed order is a stale-priced
        // order. `willRetry` (which also weighs `retryable`) decides only whether we
        // ADVERTISE a retry: the audit flag and the alert wording.
        //
        // On `accepted` / `ambiguous` the order may be LIVE on the exchange, so the
        // state that assumed it landed is the truthful one and we COMMIT — re-issuing
        // from an un-advanced state would double the order.
        if (orderDidNotExecute) {
          deps.logger.warn(
            {
              profileId,
              symbol,
              phase: placementResult.phase,
              retryable: placementResult.retryable,
              reason: placementResult.reason,
              // The order the tick could not place is not always the one that FAILED:
              // a broken cancel skips the placement behind it.
              ...(failure !== undefined && failure !== placementResult
                ? { blockedBy: failure.reason }
                : {}),
            },
            'tick-handler: an order never reached the exchange — state left un-advanced so the next tick re-issues it',
          );
          await raceDeadline(
            () => deps.redis.set(rearmKey, '1', 'PX', REARM_WINDOW_MS, 'NX'),
            REARM_TIMEOUT_MS,
            () => {
              deps.logger.warn(
                { profileId, symbol },
                'tick-handler: could not flag the order re-arm (visibility only; the retry still happens)',
              );
            },
            (err: unknown) => {
              deps.logger.warn(
                { profileId, symbol, err: err },
                'tick-handler: could not flag the order re-arm (visibility only; the retry still happens)',
              );
            },
          );
        } else {
          await commit(output.nextState, persistTimeoutMs);
          // Every order decision this tick landed: the retry sequence, if there was
          // one, is over.
          if (failure === undefined) {
            await raceDeadline(
              () => deps.redis.del(rearmKey),
              REARM_TIMEOUT_MS,
              () => {
                deps.logger.warn(
                  { profileId, symbol },
                  'tick-handler: could not clear the order re-arm flag',
                );
              },
              (err: unknown) => {
                deps.logger.warn(
                  { profileId, symbol, err: err },
                  'tick-handler: could not clear the order re-arm flag',
                );
              },
            );
          }
        }

        // Loud, but not once per tick: a stop the exchange keeps refusing fails the
        // same way every tick, and the throttle behind this dep collapses the repeat.
        // Fire-and-forget — the notify fans out to Postgres and N outbound webhooks,
        // and it fires exactly when the network is already misbehaving, the worst
        // possible moment to hold the per-(profile, symbol) chain lock waiting on it.
        if (failure !== undefined && orderFailure !== undefined && deps.notifyOrderFailed) {
          const notify = deps.notifyOrderFailed;
          const decisionType = orderFailure.decision.type;
          if (decisionType === 'place-order' || decisionType === 'cancel-order') {
            void callAsync(() =>
              notify({
                operatorId,
                accountId,
                profileId,
                symbol,
                decisionType,
                result: failure,
                willRetry,
              }),
            ).catch((err: unknown) => {
              deps.logger.warn(
                { profileId, symbol, err: err },
                'tick-handler: could not notify the operator that an order failed',
              );
            });
          }
        }

        // Audit batch. The payload is what the raw tick trace serves verbatim,
        // and what lands in `action_logs.ctx` for every tick the drainer keeps —
        // so it is the operator's only record of what a tick actually saw. The
        // strategy narrows its own `output.events` union into the block it wants
        // audited; the worker never inspects the events. Most ticks emit
        // nothing, so `extractAudit` returns `undefined` and the payload stays
        // small.
        const latencyMs = clock.nowMs() - startMs;
        const auditPayload: Record<string, unknown> = {
          enqueuedAtMs: data.enqueuedAtMs,
          eventPayload: data.payload,
          // The inputs the decision was actually taken on. Without them a log
          // row says WHAT the bot did but never why it sized or priced it that
          // way, which is the question that sends an operator digging. Only the
          // two assets this symbol trades are carried, not the whole wallet:
          // every field here is paid for on every tick, in Redis memory.
          input: tickInputDigest(tickInput),
          // The strategy's own per-branch trace. It already goes to pino, where
          // it is unsearchable per-tick after the fact; carrying it here is what
          // lets a captured row explain the path the strategy took.
          ...(output.logs.length > 0
            ? {
                strategyLogs: output.logs.map((l) => ({
                  level: l.level,
                  message: l.message,
                  ...(l.context !== undefined ? { context: l.context } : {}),
                })),
              }
            : {}),
          // True when THIS tick is itself the retry of an order an earlier tick could
          // not place. Without it a re-issued order reads as a fresh decision and the
          // operator cannot tell a retry storm from normal churn.
          ...(wasRearmed ? { rearmed: true } : {}),
          results: applied.map((a) => ({
            type: a.decision.type,
            ok: a.result.ok,
            // Carry the failure reason (Binance code + message, or the pre-call
            // refusal) into the audit so triage sees WHY an order action failed,
            // not just that it did. `phase` and `retryable` ride along because they
            // are what decide whether the bot re-issues the order — reading the audit
            // without them cannot explain why it did or did not. Success results
            // carry none of it.
            ...(a.result.ok
              ? {}
              : {
                  reason: a.result.reason,
                  phase: a.result.phase,
                  retryable: a.result.retryable,
                }),
          })),
        };
        mergeStrategyAudit(auditPayload, strategy.extractAudit?.(output.events ?? []), (key) =>
          deps.logger.warn(
            { profileId, symbol, strategy: strategy.name, key },
            'tick: strategy extractAudit key collides with a worker audit field; dropped',
          ),
        );
        const auditEntry: AuditEntry = {
          accountId,
          profileId,
          // Correlates the durable `action_logs` row with the raw stream entry
          // it came from. (profile, symbol, time) does not: the drainer stamps
          // whole batches inside one microsecond, so a row cannot be matched
          // back to its trace on timestamp alone.
          tickId: randomUUID(),
          ts: clock.nowMs(),
          symbol,
          event: data.event,
          latencyMs,
          decisionTypes: applied.map((a) => a.decision.type),
          clientOrderIds: applied
            .map((a) =>
              a.decision.type === 'place-order' ? a.decision.intent.clientOrderId : null,
            )
            .filter((c): c is string => c !== null),
          payload: auditPayload,
        };
        await deps.auditShipper.publish(auditEntry);

        // Settle the operator-pushed override the bundle-builder pulled out of
        // Redis: either mark its `override_actions` row consumed (else the SPA's
        // `GET /override` shows the executed override as "pending" forever) or
        // re-arm the Redis key when the strategy signalled a transient defer. The
        // bundle re-narrows through Zod at the strategy boundary, so
        // `bundle.override` is the typed ManualOverridePayload here.
        const bundleOverride = (tickInput.bundle as { override?: ManualOverridePayload | null })
          .override;
        if (bundleOverride?.overrideActionId) {
          // Belt-and-suspenders against the api capability gate. The gate rejects
          // an override for an action the strategy does not support, but a stale
          // override already in Redis (written before the gate, or by direct
          // manipulation) can still reach the bundle. The strategy's tick() has no
          // branch for an action it does not declare, so it silently ignores it —
          // warn loudly so the drop is not silent. `settleOverride` still consumes
          // it (never re-arms it: an action the strategy cannot honour would loop
          // until the TTL), so it does not linger as perpetually pending. An
          // override carrying no `kind` is a malformed/legacy shape rather than a
          // capability mismatch — leave that to the strategy's own Zod narrowing.
          const supported = isOverrideKindSupported(
            strategy.capabilities.operatorActions,
            bundleOverride.kind,
          );
          if (!supported) {
            deps.logger.warn(
              {
                profileId,
                symbol,
                strategy: strategy.name,
                overrideActionId: bundleOverride.overrideActionId,
                kind: bundleOverride.kind,
              },
              'tick-handler: dropped override unsupported by strategy; action not applied',
            );
          }
          // A deliberate FAIL-SAFE, not a duplicate of the exact `overrideActionId`
          // attribution below. Exact attribution trusts the strategy to stamp the id
          // on the order it emitted for the override; this coarse check trusts
          // nothing. A plugin that places the override's order but forgets the stamp
          // would look, to exact attribution, like a tick that emitted no order at
          // all — and a defer would then re-arm it, handing the same override to the
          // next tick, which places a SECOND order (a later candle yields a different
          // clientOrderId, so Binance's open-order dedup does not catch it). A double
          // market SELL is not a bug worth trusting every present and future plugin
          // to avoid, so the worker refuses to re-arm any tick that placed anything.
          const placedAnOrder = applied.some((a) => a.decision.type === 'place-order');
          if (output.overrideDeferred === true && placedAnOrder) {
            deps.logger.error(
              {
                profileId,
                symbol,
                strategy: strategy.name,
                overrideActionId: bundleOverride.overrideActionId,
              },
              'tick-handler: strategy set overrideDeferred while placing an order — refusing to re-arm (would double-execute)',
            );
          }
          // Disarm BEFORE the settle, not after: from here the normal path owns this
          // override, and the compensating settle must not run even if this one
          // fails. Settling twice is the one thing at-most-once cannot survive.
          overrideTicket.markSettled();
          // This path re-arms too (a deferred override, a retriable order failure), and
          // a re-arm must hand the row back unclaimed. The stamp travels with the
          // release so it can only ever clear the claim THIS tick made.
          const claimAt = overrideTicket.claimAt();
          await settleOverride({
            redis: deps.redis,
            logger: deps.logger,
            ...(deps.settleOverrideAction
              ? { settleOverrideAction: deps.settleOverrideAction }
              : {}),
            ...(deps.notifyOverrideOutcome
              ? { notifyOverrideOutcome: deps.notifyOverrideOutcome }
              : {}),
            ...(deps.releaseOverrideClaim && claimAt
              ? { releaseOverrideClaim: deps.releaseOverrideClaim, claimAt }
              : {}),
            scope: profile.scope,
            symbol,
            persistTimeoutMs,
            override: bundleOverride,
            ...(built.overrideTtlMs === undefined ? {} : { ttlMs: built.overrideTtlMs }),
            // The TTL was read before the strategy ran; charge this tick's own
            // latency against it so a re-arm restores the operator's deadline
            // rather than pushing it out by a tick on every defer.
            elapsedMs: latencyMs,
            deferred: output.overrideDeferred === true && !placedAnOrder,
            supported,
            ...(output.overrideDeclineReason === undefined
              ? {}
              : { declineReason: output.overrideDeclineReason }),
            orderFate: resolveOverrideOrderFate(
              bundleOverride.overrideActionId,
              applied,
              halt.dropped,
            ),
          });
        }

        // Metrics
        deps.metrics?.record('tick_latency_ms', latencyMs, {
          profileId,
          symbol,
        });
        deps.metrics?.record('decision_count', decisions.length, {
          profileId,
          symbol,
        });
        deps.metrics?.record('binance_api_weight', raw.weightUsed1m, {
          profileId,
        });

        // Fire-and-forget on the success path so a stalled Redis cannot
        // extend tick latency. The throw paths await because the worker is
        // about to DLQ the job and rotate; we want the meta to land first.
        void stampTickMeta(latencyMs, null);

        return {
          profileId,
          symbol,
          latencyMs,
          decisionCount: decisions.length,
          throttled: false,
        };
      } finally {
        // Never throws, so it cannot replace the error already in flight.
        await overrideTicket.compensate();
      }
    });
  };
};
