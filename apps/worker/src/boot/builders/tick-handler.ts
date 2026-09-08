// The tick handler and its private collaborators.
//
// `bundleProvider` is PRIVATE (only the resolveProfile closure reads it) and
// `profileContextCache` is returned so the composer can expose its `evictProfile`
// as `evictProfileContext`. The cache is built before the handler because the
// handler's resolveProfile closure reads through it.

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import { humanizeDuration } from '@app/contracts';
import { GLOBAL_KEYS, profileRepoFromScope, type Database } from '@app/db';
import { asPercent, explainProtectiveStopBandRefusal } from '@app/strategy-core';

import { strategies as strategiesRegistry } from 'strategies.js';
import {
  createRedisWindowThrottle,
  SYMBOL_DELISTED_KEY_PREFIX,
  SYMBOL_NOT_PERMITTED_RETIRE_KEY_PREFIX,
} from 'executor/notifier-gap-throttle.js';
import { reapUnpinnedBinding } from 'crons/discovery-reap.js';
import { buildProfileTickContext } from 'profile-bindings/tick-context.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import { createReconfigureEnqueue } from 'queues/reconfigure-enqueue.js';
import { createTickHandler } from 'tick/tick-handler.js';
import { createFrameRecorderFromEnv } from 'tick/frame-recorder.js';
import { createTickBundleProvider } from 'tick/bundle-builder.js';
import { createProfileContextCache } from 'tick/profile-context-cache.js';
import type { ChainByKey } from 'lib/chain-by-key.js';
import type { StatePort } from 'state/state-port.js';
import type { LiveExecutor } from 'executor/live-executor.js';
import type { NotifyEvent } from 'notifiers/notify-event.js';
import type { QueueSet } from 'queues/queue-set.js';

import type { BootEnv } from '../boot-env.js';
import type { MarketData } from './market-data.js';
import type { StatePersistence } from './state-persistence.js';
import type { MetricsSink } from 'metrics/catalog.js';
import type { Notifiers } from './notifiers.js';
import type { Audit } from './audit.js';

/** Operator-facing name of the order decision an `order-failed` alert is about. */
const ORDER_ACTION_LABEL: Record<'place-order' | 'cancel-order' | 'replace-order', string> = {
  'place-order': 'Place order',
  'cancel-order': 'Cancel order',
  'replace-order': 'Replace order',
};

export interface TickHandlerDeps {
  readonly env: BootEnv;
  readonly db: Database;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly chain: ChainByKey;
  readonly queueSet: QueueSet;
  readonly liveExecutor: LiveExecutor;
  readonly coldLoad: StatePersistence['coldLoad'];
  readonly symbolInfoCache: StatePersistence['symbolInfoCache'];
  readonly statePort: StatePort;
  readonly metrics: MetricsSink;
  readonly klineFetcher: MarketData['klineFetcher'];
  readonly notifyEvent: NotifyEvent;
  readonly orderFailedThrottle: Notifiers['orderFailedThrottle'];
  readonly orderRefusalLoopThrottle: Notifiers['orderRefusalLoopThrottle'];
  readonly protectiveStopBlockedThrottle: Notifiers['protectiveStopBlockedThrottle'];
  readonly protectiveStopUnplacedThrottle: Notifiers['protectiveStopUnplacedThrottle'];
  readonly auditShipper: Audit['auditShipper'];
}

export interface TickHandlerSlice {
  readonly profileContextCache: ReturnType<typeof createProfileContextCache>;
  readonly tickHandler: ReturnType<typeof createTickHandler>;
}

export const buildTickHandler = ({
  env,
  db,
  redis,
  logger,
  chain,
  queueSet,
  liveExecutor,
  coldLoad,
  symbolInfoCache,
  statePort,
  metrics,
  klineFetcher,
  notifyEvent,
  orderFailedThrottle,
  orderRefusalLoopThrottle,
  protectiveStopBlockedThrottle,
  protectiveStopUnplacedThrottle,
  auditShipper,
}: TickHandlerDeps): TickHandlerSlice => {
  const bundleProvider = createTickBundleProvider({ redis, logger });

  // Cross-tick cache of the resolved profile context (config/candleInterval/
  // technicals/symbol row + proven scope). Evicted by the reconfigure-profile
  // pipeline job (wired in index.ts); TTL is the backstop. Skips ~3 PG reads per
  // tick for the steady-state (unchanged) profile.
  const profileContextCache = createProfileContextCache({ nowMs: () => Date.now() });

  // Record->replay frame tracer. Undefined unless WORKER_FRAME_TRACE=1, so the
  // tick handler's hot path stays a no-op in normal operation. A trace write
  // failure logs at warn and is swallowed — tracing must never break a tick.
  const frameRecorder = createFrameRecorderFromEnv(process.env, (err) =>
    logger.warn({ err: err }, 'frame-recorder: trace append failed'),
  );

  const tickHandler = createTickHandler({
    redis,
    registry: strategiesRegistry,
    executor: liveExecutor,
    chain,
    logger,
    coldLoad,
    symbolInfoCache,
    statePort,
    metrics,
    ...(env.persistTimeoutMs !== undefined ? { persistTimeoutMs: env.persistTimeoutMs } : {}),
    marketDataPort: klineFetcher,
    resolveProfile: (operatorId, accountId, profileId, symbol) =>
      profileContextCache.resolve(accountId, profileId, symbol, () =>
        buildProfileTickContext({ db, bundleProvider }, operatorId, accountId, profileId, symbol),
      ),
    auditShipper,
    // Takes the scope the tick already proved: re-resolving it here would add a
    // `scopeProfile` SELECT to the hot path for ownership that is already known.
    settleOverrideAction: async (scope, overrideActionId, outcome) => {
      await profileRepoFromScope(scope).overrideActions.settle(overrideActionId, outcome);
    },
    // Same proven scope, for the same reason. The repo's "did I stamp it" boolean is
    // discarded on purpose: `false` means an earlier attempt already breadcrumbed
    // this row, which is exactly the state the stamp is trying to reach.
    markOverridePickedUp: async (scope, overrideActionId) => {
      await profileRepoFromScope(scope).overrideActions.markPickedUp(overrideActionId);
    },
    // What makes the cancel route's `processing_at is null` delete guard real. The
    // boolean is the whole point and the handler acts on it: `false` means the
    // operator's cancel won the CAS, and dispatching then would place an order they
    // were already told was cancelled.
    claimOverrideAction: (scope, overrideActionId, at) =>
      profileRepoFromScope(scope).overrideActions.claimAction(overrideActionId, at),
    // The paired release, fired only when the override is being handed back to a later
    // tick, and FENCED on the same stamp: the repo matches `processing_at = at`, so a
    // release abandoned at its deadline cannot come back and strip a later tick's claim.
    releaseOverrideClaim: async (scope, overrideActionId, at) => {
      await profileRepoFromScope(scope).overrideActions.releaseClaim(overrideActionId, at);
    },
    // Read ONLY when an aborted tick is about to put an override it consumed back
    // into Redis, so it never touches the warm path. The operator can cancel in
    // the gap between the consuming DEL and that re-arm, and the cancel route
    // deletes the row outright — without this the revoked action would be restored
    // and executed by the next tick.
    findActiveOverride: (scope, symbol) =>
      profileRepoFromScope(scope).overrideActions.findActiveForSymbol(symbol),
    recordOrderRefusalCondition: async (scope, input) => {
      await profileRepoFromScope(scope).conditionStates.recordCondition({
        condition: 'order-refusal-loop',
        ...input,
      });
    },
    notifyOverrideOutcome: (input) =>
      notifyEvent({
        category: 'override-unresolved',
        operatorId: input.operatorId,
        accountId: input.accountId,
        profileId: input.profileId,
        symbol: input.symbol,
        body: 'A manual action you triggered hit a fault before the bot could confirm it. It may or may not have executed — check the exchange before re-issuing it.',
        ...(input.outcome.reason === undefined
          ? {}
          : { fields: [{ label: 'Fault', value: input.outcome.reason }] }),
      }),
    // An order the bot could not place is usually the protective stop, so the
    // position may be sitting unguarded. Loud — but the same stop fails the same
    // way every tick, so the window collapses the repeat into one alert. The
    // throttle FAILS OPEN: on a Redis fault a duplicate alert beats a dropped one.
    notifyOrderFailed: async (input) => {
      // The escalation level is part of the key. The two messages differ in
      // urgency — "it will try again" vs "the position is UNGUARDED, check
      // Binance" — so a benign weight throttle at 12:00 must not be allowed to
      // silence the genuinely dangerous non-retryable failure at 12:03.
      const allowed = await orderFailedThrottle.allow(
        `${input.profileId}:${input.symbol}:${input.willRetry ? 'retry' : 'final'}`,
      );
      if (!allowed) return;
      let body =
        'The bot could not cancel an order on Binance, and the reason will NOT clear on its own. It cannot make progress until you act. Check the order on Binance.';
      if (input.willRetry) {
        body =
          'The bot could not get an order onto Binance. It will try again on the next cycle; if this keeps repeating, check the symbol and your balance.';
        // A replacement is a placement first: its successor is what did not reach the exchange, and on a non-retryable failure the stop it retired is already gone, so the unguarded-position warning is more warranted here than for a bare placement, not less.
      } else if (input.decisionType === 'place-order' || input.decisionType === 'replace-order') {
        body =
          'The bot could not get an order onto Binance, and the reason will NOT clear on its own. After three identical refusals, it slows that exact request to one probe per minute until you act. If this was a protective stop, the position is currently unguarded. Check it on Binance.';
      }
      await notifyEvent({
        category: 'order-failed',
        operatorId: input.operatorId,
        accountId: input.accountId,
        profileId: input.profileId,
        symbol: input.symbol,
        // `willRetry` means the cause can clear, not that the bot gives up otherwise.
        // A repeated structural refusal moves to the dedicated once-per-minute probe.
        body,
        fields: [
          { label: 'Action', value: ORDER_ACTION_LABEL[input.decisionType] },
          { label: 'Reason', value: input.result.reason },
        ],
      });
    },
    notifyOrderRefusalLoop: async (input) => {
      const allowed = await orderRefusalLoopThrottle.allow(
        `${input.profileId}:${input.symbol}:${input.identityKey}`,
      );
      if (!allowed) return;
      await notifyEvent({
        category: 'order-failed',
        operatorId: input.operatorId,
        accountId: input.accountId,
        profileId: input.profileId,
        symbol: input.symbol,
        body: input.probe
          ? 'Binance is still returning the same refusal. The bot will keep probing this exact request once per minute until the refusal or request changes.'
          : 'Binance refused the same order three times. The bot has slowed this exact request to one probe per minute until the refusal or request changes.',
        fields: [
          { label: 'Action', value: `${input.request.side} ${input.request.type}` },
          { label: 'Quantity', value: input.request.quantity },
          { label: 'Client order ID', value: input.request.clientOrderId },
          { label: 'Binance code', value: String(input.rejection.code) },
          { label: 'Binance message', value: input.rejection.msg },
        ],
      });
    },
    // Nothing was sent here, so there is no refusal to report: the exchange's
    // price band would reject the stop, and the strategy defers it rather than
    // burning every tick on an order it knows will be refused. The position can
    // therefore sit with nothing under it while every screen looks normal.
    notifyProtectiveStopBlocked: async (input) => {
      // The words come from the strategy package that owns the refusal, and the
      // symbol screen reads the same ones. An operator who checks the phone alert
      // and then the app must not find two explanations of one block, and copy
      // maintained in two files is how that happened.
      //
      // Built BEFORE the window is opened: a `detail` this builder cannot read would otherwise throw after the throttle key is already set, losing the alert AND suppressing every later one for the rest of the hour. Consume the window only once there is a message to consume it for.
      const copy = explainProtectiveStopBandRefusal(input.detail);
      // The escalation level is part of the key, same split as the order-failed
      // retry/final levels: "wait for the price to come back" and "no price ever
      // arms this stop" are different instructions, and the recoverable one
      // fires first.
      const allowed = await protectiveStopBlockedThrottle.allow(
        `${input.profileId}:${input.symbol}:${input.terminal ? 'terminal' : 'persistent'}`,
      );
      if (!allowed) return;
      await notifyEvent({
        category: 'order-failed',
        operatorId: input.operatorId,
        accountId: input.accountId,
        profileId: input.profileId,
        symbol: input.symbol,
        body: `${copy.situation} ${copy.exposure}${copy.remedy === '' ? '' : ` ${copy.remedy}`}`,
        fields: [
          { label: 'Reason', value: input.reason },
          ...(typeof input.detail['stopPrice'] === 'string'
            ? [{ label: 'Wanted stop', value: input.detail['stopPrice'] }]
            : []),
          ...(copy.ceiling
            ? typeof input.detail['ceiling'] === 'string'
              ? [{ label: 'Highest Binance allows', value: input.detail['ceiling'] }]
              : []
            : typeof input.detail['floor'] === 'string'
              ? [{ label: 'Lowest Binance allows', value: input.detail['floor'] }]
              : []),
          // The two numbers that decide what the operator changes, quoted rather
          // than re-derived: the stop this profile asks for against the deepest
          // one the symbol's band will take.
          ...(copy.requiredStopDistance === null
            ? []
            : [{ label: 'Stop distance asked for', value: copy.requiredStopDistance }]),
          ...(copy.ceiling || copy.maxStopDistance === null
            ? []
            : [{ label: 'Widest Binance allows', value: copy.maxStopDistance }]),
          // How long this has held is the operator's first question. The span
          // measures the REFUSAL's age, not the position's exposure, so it reads
          // "Blocked for".
          ...(input.sinceMs === null
            ? []
            : [{ label: 'Blocked for', value: humanizeDuration(Date.now() - input.sinceMs) }]),
        ],
      });
    },
    // The outcome rather than a cause: whatever has been stopping the stop from landing, this position has had nothing on the exchange under it for long enough that it cannot be the moment after an entry any more. `order-failed` already describes exactly this — a protective stop that never reached the exchange, leaving the position unguarded — is severity `error`, and is on by default, so the alert the operator most needs is not behind a switch they have to find first.
    notifyProtectiveStopUnplaced: async (input) => {
      // The bag crossed a JSON round-trip to get here, so its declared shape is a claim rather than a guarantee; substituting once keeps every read below total, including the ones inside the send.
      const detail = input.detail ?? {};
      // Whether the trail distance can be quoted is decided BEFORE the window opens, because parsing it is the one step in this alert that reads a value it did not compute. Nothing between the throttle and the send may throw: a throw under an already-consumed key loses this alert and mutes the next hour of them too.
      const refusedTrail =
        detail['nativeUnavailable'] === true ? asPercent(detail['distancePct']) : null;
      // No escalation dimension in the key, unlike the band alert: there is one thing to say here and one hour to say it in, per coin.
      const allowed = await protectiveStopUnplacedThrottle.allow(
        `${input.profileId}:${input.symbol}`,
      );
      if (!allowed) return;
      const unprotectedFor = humanizeDuration(Date.now() - input.sinceMs);
      await notifyEvent({
        category: 'order-failed',
        operatorId: input.operatorId,
        accountId: input.accountId,
        profileId: input.profileId,
        symbol: input.symbol,
        // Says what is true right now before it says what to do: an operator reading this on a phone has to know within one line whether money is exposed.
        body: `This position has had no protective stop on Binance for ${unprotectedFor}. Nothing on the exchange will sell it if the price falls. Check whether another order is holding the coins, and whether Binance will accept a stop at the price your settings ask for.`,
        fields: [
          { label: 'Unprotected for', value: unprotectedFor },
          // The stop the strategy wanted this tick, quoted from its own live record: it is the number the operator compares against the symbol's price band when working out why nothing lands.
          ...(typeof detail['stop'] === 'string'
            ? [{ label: 'Wanted stop', value: detail['stop'] }]
            : []),
          // The one cause the body cannot guess at. A profile trailing its stop on Binance itself is refused outright when the symbol's own filter has no step matching the distance asked for, and no price move ever clears that — so the generic "check whether Binance will accept a stop at your price" sends this operator hunting in the wrong place. Named here with both levers, because either one alone resolves it.
          ...(detail['nativeUnavailable'] === true
            ? [
                {
                  label: 'Why',
                  value: `Binance will not accept a trailing stop — one that follows the price up and sells when it drops back — ${refusedTrail === null ? 'at the distance your settings ask for' : `${refusedTrail} below the high`} on this coin. Switch this profile's protective stop mode to priced, or change the distance.`,
                },
              ]
            : []),
        ],
      });
    },
    // Self-heal a symbol Binance no longer lists on this profile's mode: reap the
    // binding when it is unpinned and flat, and clear its discovery bookkeeping.
    // Delegates to the SAME `reapUnpinnedBinding` the discovery cron uses so the two
    // reap paths cannot drift (stale added-at / enter-on-add hashes). The flat
    // guard + cleanup order are the helper's; the scope is the one the tick proved.
    reapUnpinnedIfFlat: (scope, symbol) =>
      reapUnpinnedBinding(
        profileRepoFromScope(scope).profileSymbols,
        redis,
        {
          addedKey: GLOBAL_KEYS.discoveryAdded(scope.profileId),
          flatKey: GLOBAL_KEYS.discoveryFlat(scope.profileId),
          enterOnAddKey: GLOBAL_KEYS.discoveryEnterOnAdd(scope.profileId),
        },
        symbol,
        Date.now(),
      ),
    // After either self-heal reaps a binding, tell the WS to drop the now-unbound
    // symbol promptly: the same `reconfigure-profile` resync the discovery cron
    // and the api symbol routes enqueue. The payload MUST carry accountId — the
    // pipeline worker fails a resync missing it as pipeline_invalid_payload.
    enqueueReconfigure: createReconfigureEnqueue(queueSet.queues[QUEUE_NAMES.pipeline]),
    appendActionLog: (scope, input) => profileRepoFromScope(scope).actionLogs.append(input),
    // A held or pinned delisted symbol throws the same way every tick; gate its
    // operator record to one per hour, cross-process (Redis key per profile+symbol,
    // not global). FAILS OPEN on a Redis fault.
    delistThrottle: createRedisWindowThrottle({
      redis,
      logger,
      prefix: SYMBOL_DELISTED_KEY_PREFIX,
      windowMs: 3_600_000,
    }),
    // Its OWN key namespace — not the delist throttle's, and not the placement
    // refusal's either. Every one of these windows is keyed (profile, symbol), so
    // a shared prefix is a shared Redis key: whichever cause fired first would
    // mute the other for an hour, and the placement refusal always fires first.
    notPermittedThrottle: createRedisWindowThrottle({
      redis,
      logger,
      prefix: SYMBOL_NOT_PERMITTED_RETIRE_KEY_PREFIX,
      windowMs: 3_600_000,
    }),
    // Spread only when defined: `exactOptionalPropertyTypes` rejects an explicit
    // `undefined` on the optional dep.
    ...(frameRecorder ? { frameRecorder } : {}),
  });

  return { profileContextCache, tickHandler };
};
