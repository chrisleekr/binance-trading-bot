// Worker DI graph.
//
// `buildBootContext(env)` composes every long-lived worker subsystem from the
// per-subsystem builders under `./builders/` and returns them in a typed bag.
// The boot site (`apps/worker/src/index.ts`) uses the context to register crons,
// register the tick + pipeline workers, start lifecycles, and wire shutdown —
// there is no construction logic left in `index.ts` after this returns, and none
// in this file beyond composition wiring.
//
// Construction ORDER is load-bearing (each builder is called in the sequence the
// original single function used) because closures capture already-built
// collaborators and a few cycles are closed by typed back-edges inside the fleet
// builder. The builders take their explicit deps as params and return only their
// own slice; this file threads one builder's output into the next.

import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

import { repo, type Database } from '@app/db';
import type { ProfileId } from '@app/contracts';
import type { MetricsRegistry } from '@app/observability';
import type { MarketDataPort, WeightGovernor } from '@app/binance';
import type { SymbolInfo } from '@app/strategy-core';

import { strategies as strategiesRegistry } from 'strategies.js';
import { notifyProviders as notifyProvidersRegistry } from 'notifiers.js';
import type { NotifyEvent } from 'notifiers/notify-event.js';
import type { NotifierGapThrottle } from 'executor/notifier-gap-throttle.js';
import type { SubscriptionOwnership } from 'user-stream/subscription-ownership.js';
import type { ActiveProfile, ProfileManager } from 'profile-manager/profile-manager.js';
import type { EnabledSetReconciler } from 'profile-manager/enabled-set-reconciler.js';
import type { ChainByKey } from 'lib/chain-by-key.js';
import { createQueueSet, type QueueSet } from 'queues/queue-set.js';
import type { SymbolReconcileRequest } from 'queues/symbol-reconcile-enqueue.js';
import type { AccountSnapshotStore } from 'crons/account-snapshot.js';
import type { MutateSymbolStateDeps } from 'state/version-aware-mutate.js';
import type { StatePort } from 'state/state-port.js';
import type { LiveExecutor } from 'executor/live-executor.js';
import type { FillAdopter } from 'executor/fill-adopter.js';
import type { FillBackfiller } from 'executor/fill-backfiller.js';
import type { AuditDrainer } from 'audit-shipper/audit-shipper.js';
import { loadWorkerEnv, type WorkerEnv } from 'env.js';
import type { Component } from 'lib/component.js';

import type { ReconcileOrchestratorDeps } from './reconcile-held-quantity.js';
import type { BootEnv } from './boot-env.js';
import { buildPrimitives } from './builders/primitives.js';
import { buildNotifiers, type Notifiers } from './builders/notifiers.js';
import { buildChain } from './builders/chain.js';
import { buildMarketData } from './builders/market-data.js';
import { buildProfileManagerSlice } from './builders/profile-manager.js';
import {
  buildBinanceResolver,
  type ResolveBinanceClient,
  type ResolveBinanceFull,
} from './builders/binance-resolver.js';
import { buildStatePersistence, type PersistProfileState } from './builders/state-persistence.js';
import { buildEventStream } from './builders/event-stream.js';
import { buildAudit } from './builders/audit.js';
import { buildExecutor } from './builders/executor.js';
import { buildTickHandler, type TickHandlerSlice } from './builders/tick-handler.js';
import { buildFleet } from './builders/fleet.js';
import { buildReconcile } from './builders/reconcile.js';

export type { BootEnv } from './boot-env.js';
export { buildLogger } from './builders/primitives.js';

/**
 * Public DI surface returned by {@link buildBootContext}. Fields are
 * limited to what `apps/worker/src/index.ts` and `crons/*.cron.ts`
 * actually consume — long-lived subsystems with no external consumer
 * (marketSubscriptions, userStreamPool, eventRouter, indicatorComputer,
 * auditShipper, bundleProvider, coldLoad) stay private inside the
 * builders, wired into `lifecycles` and `tickHandler` only.
 */
export interface BootContext {
  readonly workerEnv: WorkerEnv;
  readonly logger: Logger;
  readonly pool: Pool;
  readonly redis: Redis;
  readonly db: Database;
  readonly queueSet: QueueSet;
  readonly chain: ChainByKey;
  readonly profileManager: ProfileManager;
  readonly liveExecutor: LiveExecutor;
  // The per-(profile, symbol) state boundary, shared by the tick handler and
  // the reset-grid pipeline job so both reconcile/commit the same store.
  readonly statePort: StatePort;
  readonly exchangeInfoRefresh: () => Promise<unknown>;
  readonly resolveBinanceClient: ResolveBinanceClient;
  /**
   * Same as `resolveBinanceClient` but also returns the resolved Binance
   * mode. Used by callers that need to gate on test-vs-live (e.g. the
   * dust-snapshot cron, whose SAPI endpoints are live-only). Credentials are
   * per-account, so this is keyed by accountId, not profileId.
   */
  readonly resolveBinanceWithMode: ResolveBinanceFull;
  readonly tickHandler: TickHandlerSlice['tickHandler'];
  /**
   * Fill adopter. The event-router owns the live path; the
   * `detached-orders-reconcile` cron drives `reconcileDetachedFill` for accounts
   * whose last profile was deleted, which therefore have no stream left at all.
   */
  readonly fillAdopter: FillAdopter;
  /**
   * Audit-stream → `action_logs` drainer. index.ts starts its background loop
   * after lifecycles and stops it on shutdown.
   */
  readonly auditDrainer: AuditDrainer;
  /** Dedicated connection for the audit drainer's blocking XREADGROUP; quit on shutdown. */
  readonly auditDrainerRedis: Redis;
  /**
   * Drop the cached profile context for a profile. The reconfigure-profile
   * pipeline job calls this so an operator config/symbol edit is visible on
   * the next tick rather than after the cache TTL.
   */
  readonly evictProfileContext: (profileId: ProfileId) => void;
  /**
   * Process-wide metrics registry. Built here so the tick + state-commit
   * paths record onto the same registry the admin /metrics route serves;
   * `index.ts` passes this into `startAdminServer`.
   */
  readonly metricsRegistry: MetricsRegistry;
  /**
   * Fleet subscription-ownership manager. index.ts start()s it after
   * markReady() (so this pod is ready before it can own an account) and
   * stop()s it during drain.
   */
  readonly subscriptionOwnership: SubscriptionOwnership;
  /**
   * Periodic fleet-global enabled-set converge (#579). index.ts start()s it
   * after `subscriptionOwnership` and stop()s it before, so a reconcile pass
   * never re-elects ownership after ownership has been torn down.
   */
  readonly enabledSetReconciler: EnabledSetReconciler;
  readonly listActive: () => readonly ActiveProfile[];
  /**
   * Shared `account-info` cache store. index.ts calls `persistAccount` once at
   * boot (via `runAccountSnapshotSeed`) to populate the cache before the first
   * WS frame or cron tick; the event-router and safety cron own the steady-
   * state writes.
   */
  readonly accountSnapshotStore: AccountSnapshotStore;
  readonly weightGovernor: WeightGovernor;
  /** Symbol filters/precision lookup (cached); used by the backtest runner. */
  readonly getSymbolInfo: (symbol: string) => Promise<SymbolInfo>;
  /**
   * Shared kline data port. One process-wide adapter multiplexes every
   * kline consumer (technicals-compute, IndicatorComputer cold-seed,
   * future tick-path windows) over a single Binance combined-stream WS
   * and per-(symbol, interval) ring. See {@link createKlineFetcher}.
   */
  readonly marketDataPort: MarketDataPort;
  readonly strategies: typeof strategiesRegistry;
  readonly notifyProviders: typeof notifyProvidersRegistry;
  /** Public "Live demo" mode: threaded to every notifier dispatch site for total suppression. */
  readonly liveDemo: boolean;
  /**
   * Fan-out for profile-scoped operator alerts (daily-loss halt, edge-decay
   * warning), gated by each profile's `notify_events` subscription. Built once here
   * so every cron shares one notifier surface.
   */
  readonly notifyEvent: NotifyEvent;
  /**
   * Fan-out for account-scoped ops alerts (dead-lettered jobs, dust
   * conversions), gated by the singleton `ops_notify_config`. Not tied to one
   * profile; an event naming an `accountId` reaches only that account's notifiers.
   */
  readonly accountNotify: Notifiers['accountNotify'];
  /**
   * The same chokepoint for a caller raising MANY events of one category for one
   * account in a pass (the orphan detector): the subscription gate and the
   * notifier resolve are read once for the whole batch instead of per event.
   */
  readonly accountNotifyBatch: Notifiers['accountNotifyBatch'];
  /**
   * Bounds the volume of durable notifier-gap traces, per (profile, topic),
   * fleet-wide. Shared so every gap-writing surface throttles on one budget
   * instead of each opening its own.
   */
  readonly notifierGapThrottle: NotifierGapThrottle;
  /** Public web base URL for notification deep links; undefined disables links. */
  readonly publicWebUrl: string | undefined;
  /**
   * Atomic write of (state, strategy_version) for a profile. Exposed so
   * the boot reconciler can upgrade a legacy state row in lockstep with
   * its schemaVersion before reconciling heldQuantity. The tick-handler
   * variant adds an outer `withTimeout` wrapper; the boot caller runs
   * once per profile during a quiet boot window and does not wrap.
   */
  readonly persistMigratedProfileState: PersistProfileState;
  /**
   * Pre-bound dependencies for {@link mutateSymbolState}. The boot
   * reconciler threads this through `runHeldQuantityReconciliation` so
   * every per-(profile, symbol) reconcile/revive write lands via the
   * atomic two-column upsert on `symbol_states` instead of clobbering
   * the legacy per-profile blob. Built here so the registry, the redis
   * handle, and `persistSymbolState` all share a single construction
   * site with the tick handler.
   */
  readonly symbolStateDeps: MutateSymbolStateDeps;
  /**
   * Dependencies for {@link runHeldQuantityReconciliation}. Built once here so
   * the boot pass, the periodic backstop cron, and the `symbol-reconcile` job
   * converge through the identical machinery — including the shared `chainByKey`
   * that serialises their writes against a concurrent tick.
   */
  readonly reconcileDeps: ReconcileOrchestratorDeps;
  /**
   * Defer a converge-to-exchange-truth pass for one (profile, symbol). The queue
   * is the seam that lets code running inside the tick's per-(profile, symbol)
   * chain lock repair a position without taking that lock again (which would
   * deadlock). Coalesced per (profile, symbol) while the job is still waiting.
   */
  readonly enqueueSymbolReconcile: (input: SymbolReconcileRequest) => Promise<void>;
  /**
   * Recovers fills Binance never replayed on the user stream, by folding
   * `getMyTrades` through the fill-adopter. The event-router drives it on
   * reconnect; the `symbol-reconcile` job drives it when a decision handler
   * discovers a fill the stream missed entirely.
   */
  readonly fillBackfiller: FillBackfiller;
  readonly lifecycles: readonly Component[];
}

export const buildBootContext = async (env: BootEnv): Promise<BootContext> => {
  const { logger, bullConn, redis, pool, db, liveDemo } = buildPrimitives(env);
  // Dependency-free leaf read; hoisted here so the builder sequence below stays
  // strictly dependency-ordered rather than being interrupted mid-flow.
  const workerEnv = loadWorkerEnv();

  // A LIVE_DEMO box holds testnet keys only — refuse to start on a live key.
  // Guarded BEFORE any subsystem builder so a misconfigured demo box fails fast
  // without opening streams, queue producers, or queue workers.
  if (liveDemo && (await repo.accounts.anyLiveMode(db))) {
    throw new Error(
      'LIVE_DEMO refuses to boot: an account is configured for the live Binance environment. A demo deployment must hold testnet keys only.',
    );
  }

  // Minted after the guard: each queue opens a lazy producer connection, so an
  // aborted live-demo boot never leaves them dangling.
  const queueSet = createQueueSet({ connection: bullConn, logger });

  const {
    accountNotify,
    accountNotifyBatch,
    notifierGapThrottle,
    orderFailedThrottle,
    notifyEvent,
  } = buildNotifiers({ db, redis, logger, liveDemo, queueSet });

  const chain = buildChain();

  const { wsFactory, weightGovernor, klineFetcher, indicatorComputer } = buildMarketData({
    env,
    redis,
    logger,
  });

  const { loadEnabledProfiles, profileManager } = buildProfileManagerSlice({ db, logger });

  const { resolveBinanceFull, resolveBinanceClient, exchangeInfoRefresh } = buildBinanceResolver({
    db,
    redis,
    logger,
    weightGovernor,
  });

  const {
    persistProfileState,
    persistSymbolState,
    coldLoad,
    symbolInfoCache,
    metricsRegistry,
    metrics,
    statePort,
    fillAdopter,
    fillBackfiller,
    enqueueSymbolReconcile,
    accountSnapshotStore,
  } = buildStatePersistence({
    db,
    redis,
    logger,
    chain,
    resolveBinanceClient,
    queueSet,
    notifyEvent,
  });

  const { eventRouter, userStreamPool } = buildEventStream({
    db,
    redis,
    logger,
    queueSet,
    wsFactory,
    profileManager,
    indicatorComputer,
    fillAdopter,
    fillBackfiller,
    accountSnapshotStore,
    notifierGapThrottle,
    enqueueSymbolReconcile,
    resolveBinanceFull,
  });

  const { auditShipper, auditDrainerRedis, auditDrainer } = buildAudit({
    db,
    redis,
    logger,
    metrics,
    profileManager,
  });

  const { liveExecutor } = buildExecutor({
    db,
    redis,
    logger,
    liveDemo,
    profileManager,
    enqueueSymbolReconcile,
  });

  const { profileContextCache, tickHandler } = buildTickHandler({
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
    auditShipper,
  });

  const {
    marketSubscriptions,
    marketLivenessWatchdog,
    subscriptionOwnership,
    enabledSetReconciler,
  } = buildFleet({
    redis,
    logger,
    klineFetcher,
    indicatorComputer,
    weightGovernor,
    eventRouter,
    userStreamPool,
    profileManager,
    loadEnabledProfiles,
    metricsRegistry,
  });

  const { symbolStateDeps, reconcileDeps } = buildReconcile({
    db,
    redis,
    logger,
    chain,
    profileManager,
    resolveBinanceClient,
    persistSymbolState,
    persistProfileState,
  });

  // Long-lived subsystems share one lifecycle protocol so boot sequences them
  // sequentially and shutdown reverses the order. Each adapter wraps the
  // subsystem's native start/stop method — they do NOT all share a name today
  // (profileManager.shutdown vs marketSubscriptions.stop vs
  // userStreamPool.closeAll), and forcing a rename through every subsystem just
  // to satisfy the contract is the wrong trade.
  const lifecycles: readonly Component[] = [
    {
      name: 'profileManager',
      start: () => profileManager.start(),
      stop: () => profileManager.shutdown(),
    },
    {
      name: 'marketSubscriptions',
      start: () => marketSubscriptions.start(),
      stop: () => marketSubscriptions.stop(),
    },
    {
      // userStreamPool's start step is the watchdog timer: every 60s it walks
      // intended-open profiles and reconnects any stream whose last message is
      // older than 90s. ws-api self-maintains ping/pong; this is a recovery
      // hatch, not a keepalive.
      name: 'userStreamPool',
      start: async () => {
        userStreamPool.startConnectionWatchdog();
      },
      stop: () => userStreamPool.closeAll(),
    },
    {
      // While the market-data WS is down, REST-poll subscribed symbols and feed
      // synthetic mini-tickers so stops/exits keep evaluating during the gap.
      // Inert while the WS is healthy.
      name: 'marketLivenessWatchdog',
      start: async () => {
        marketLivenessWatchdog.start();
      },
      stop: async () => {
        marketLivenessWatchdog.stop();
      },
    },
    {
      // marketDataPort is lazy: it opens the WS on the first subscriber, not at
      // boot. The `start` here is a no-op; `stop` drains every subscriber, closes
      // the WS, and clears the rings — see KlineFetcher.shutdown.
      name: 'marketDataPort',
      start: async () => undefined,
      stop: () => klineFetcher.shutdown(),
    },
  ];

  return {
    workerEnv,
    logger,
    pool,
    redis,
    db,
    queueSet,
    chain,
    profileManager,
    liveExecutor,
    statePort,
    exchangeInfoRefresh,
    resolveBinanceClient,
    resolveBinanceWithMode: resolveBinanceFull,
    tickHandler,
    fillAdopter,
    auditDrainer,
    auditDrainerRedis,
    evictProfileContext: profileContextCache.evictProfile,
    metricsRegistry,
    subscriptionOwnership,
    enabledSetReconciler,
    listActive: () => profileManager.listActive(),
    accountSnapshotStore,
    weightGovernor,
    getSymbolInfo: (symbol: string) => symbolInfoCache.get(symbol),
    marketDataPort: klineFetcher,
    strategies: strategiesRegistry,
    notifyProviders: notifyProvidersRegistry,
    liveDemo,
    notifyEvent,
    accountNotify,
    accountNotifyBatch,
    notifierGapThrottle,
    publicWebUrl: env.publicWebUrl,
    persistMigratedProfileState: persistProfileState,
    symbolStateDeps,
    reconcileDeps,
    fillBackfiller,
    enqueueSymbolReconcile,
    lifecycles,
  };
};
