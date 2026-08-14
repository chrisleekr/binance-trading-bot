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

import { strategies as strategiesRegistry } from 'strategies.js';
import {
  createRedisWindowThrottle,
  SYMBOL_DELISTED_KEY_PREFIX,
  SYMBOL_NOT_PERMITTED_RETIRE_KEY_PREFIX,
} from 'executor/notifier-gap-throttle.js';
import { reapAutoBinding } from 'crons/discovery-reap.js';
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
  readonly protectiveStopBlockedThrottle: Notifiers['protectiveStopBlockedThrottle'];
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
  protectiveStopBlockedThrottle,
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
      await notifyEvent({
        category: 'order-failed',
        operatorId: input.operatorId,
        accountId: input.accountId,
        profileId: input.profileId,
        symbol: input.symbol,
        // `willRetry` is "will a retry ever succeed", NOT "will the bot try again".
        // The bot leaves the strategy state un-advanced whenever an order provably
        // never reached the exchange, so it DOES keep re-attempting — it just cannot
        // make progress on a cause that does not clear by itself (a -1013 filter
        // failure, a -2010 insufficient balance). Telling the operator "it will NOT
        // retry" would be a lie, and the dangerous kind: it reads as "the bot has
        // given up, so nothing more will happen", when in fact the position is stuck
        // and only they can unstick it.
        body: input.willRetry
          ? 'The bot could not get an order onto Binance. It will try again on the next cycle; if this keeps repeating, check the symbol and your balance.'
          : 'The bot could not get an order onto Binance, and the reason will NOT clear on its own. It keeps re-attempting every cycle but cannot make progress until you act. If this was a protective stop, the position is currently unguarded — check it on Binance.',
        fields: [
          {
            label: 'Action',
            value: input.decisionType === 'place-order' ? 'Place order' : 'Cancel order',
          },
          { label: 'Reason', value: input.result.reason },
        ],
      });
    },
    // Nothing was sent here, so there is no refusal to report: the exchange's
    // price band would reject the stop, and the strategy defers it rather than
    // burning every tick on an order it knows will be refused. The position can
    // therefore sit with nothing under it while every screen looks normal.
    notifyProtectiveStopBlocked: async (input) => {
      // The escalation level is part of the key, same split as the order-failed
      // retry/final levels: "wait for the price to come back" and "no price ever
      // arms this stop, widen the offset" are different instructions, and the
      // recoverable one fires first.
      const allowed = await protectiveStopBlockedThrottle.allow(
        `${input.profileId}:${input.symbol}:${input.terminal ? 'terminal' : 'persistent'}`,
      );
      if (!allowed) return;
      // Which side of the band was breached decides the whole message. A stop
      // priced ABOVE the ceiling is fixed by waiting, never by widening the
      // offset — that pushes it further out — and quoting a floor at that
      // operator would send them the wrong way. `terminal` is only ever derived
      // from a floor breach, so the ceiling case is always the recoverable one.
      const ceiling = input.detail['bound'] === 'ceiling';
      await notifyEvent({
        category: 'order-failed',
        operatorId: input.operatorId,
        accountId: input.accountId,
        profileId: input.profileId,
        symbol: input.symbol,
        body: ceiling
          ? 'The bot has been unable to place a protective stop on this position: the stop it wants is priced too HIGH for the range Binance accepts right now. It keeps trying every cycle and will place it once the price catches up — do NOT widen the stop offset, that moves it further out of range. The position is unguarded until then.'
          : input.terminal
            ? 'The bot cannot place a protective stop on this position: Binance will not accept a stop this far from the current price, and no price it could pick would be accepted. The position is unguarded until you widen the stop offset or close it by hand.'
            : 'The bot has been unable to place a protective stop on this position: Binance will not accept a stop this far from the current price. It keeps trying every cycle, but the position is unguarded until the price moves back or you widen the stop offset.',
        fields: [
          { label: 'Reason', value: input.reason },
          ...(typeof input.detail['stopPrice'] === 'string'
            ? [{ label: 'Wanted stop', value: input.detail['stopPrice'] }]
            : []),
          ...(ceiling
            ? typeof input.detail['ceiling'] === 'string'
              ? [{ label: 'Highest Binance allows', value: input.detail['ceiling'] }]
              : []
            : typeof input.detail['floor'] === 'string'
              ? [{ label: 'Lowest Binance allows', value: input.detail['floor'] }]
              : []),
          // How long this has held is the operator's first question. The span
          // measures the REFUSAL's age, not the position's exposure, so it reads
          // "Blocked for".
          ...(input.sinceMs === null
            ? []
            : [{ label: 'Blocked for', value: humanizeDuration(Date.now() - input.sinceMs) }]),
        ],
      });
    },
    // Self-heal a symbol Binance no longer lists on this profile's mode: reap the
    // auto-added binding when it is flat and clear its discovery bookkeeping.
    // Delegates to the SAME `reapAutoBinding` the discovery cron uses so the two
    // reap paths cannot drift (stale added-at / enter-on-add hashes). The flat
    // guard + cleanup order are the helper's; the scope is the one the tick proved.
    reapAutoIfFlat: (scope, symbol) =>
      reapAutoBinding(
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
