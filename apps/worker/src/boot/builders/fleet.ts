// Fleet + market-subscription wiring, and the typed back-edges.
//
// The market subscriptions manager wraps the kline port and routes events into
// the event-router; the liveness watchdog REST-polls during a WS gap. The two
// construction-order back-edges (klineFetcher.setOnReconnect, profileManager.
// setMarket) are the single assign point for cycles the build order can't
// satisfy, and both fire here BEFORE any lifecycle start().

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import { fetchClosedKlines, type WeightGovernor } from '@app/binance';
import type { MetricsRegistry } from '@app/observability';
import { sleep } from '@app/core/sleep';

import {
  createMarketSubscriptionsManager,
  triggerResyncForAllSubscribed,
} from 'market-data/subscriptions-manager.js';
import {
  createMarketLivenessWatchdog,
  createKlineGapPriceFetcher,
} from 'market-data/market-liveness-watchdog.js';
import {
  createSubscriptionOwnership,
  type SubscriptionOwnership,
} from 'user-stream/subscription-ownership.js';
import { workerMemberId } from '../member-registry.js';
import {
  createEnabledSetReconciler,
  type EnabledSetReconciler,
} from 'profile-manager/enabled-set-reconciler.js';
import type { ProfileManager } from 'profile-manager/profile-manager.js';

import type { MarketData } from './market-data.js';
import type { EventStream } from './event-stream.js';
import type { ProfileManagerSlice } from './profile-manager.js';

export interface FleetDeps {
  readonly redis: Redis;
  readonly logger: Logger;
  readonly klineFetcher: MarketData['klineFetcher'];
  readonly indicatorComputer: MarketData['indicatorComputer'];
  readonly weightGovernor: WeightGovernor;
  readonly eventRouter: EventStream['eventRouter'];
  readonly userStreamPool: EventStream['userStreamPool'];
  readonly profileManager: ProfileManager;
  readonly loadEnabledProfiles: ProfileManagerSlice['loadEnabledProfiles'];
  readonly metricsRegistry: MetricsRegistry;
}

export interface Fleet {
  readonly marketSubscriptions: ReturnType<typeof createMarketSubscriptionsManager>;
  readonly marketLivenessWatchdog: ReturnType<typeof createMarketLivenessWatchdog>;
  readonly subscriptionOwnership: SubscriptionOwnership;
  readonly enabledSetReconciler: EnabledSetReconciler;
}

export const buildFleet = ({
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
}: FleetDeps): Fleet => {
  // Subscriptions manager wraps the kline fetcher and routes market events /
  // resyncs into the event-router.
  const marketSubscriptions = createMarketSubscriptionsManager({
    port: klineFetcher,
    onMarketEvent: (e) => eventRouter.onMarketEvent(e),
    onResync: (s) => eventRouter.onResync(s),
    // Drop the symbol's in-memory indicator state when its last claim is reaped,
    // matching the kline-ring drop — bounds the indicator-state Map under churn.
    clearIndicatorState: (s, iv) => indicatorComputer.clear(s, iv),
    logger,
  });

  // Market-data liveness watchdog: while the kline WS is down, REST-poll each
  // subscribed symbol's freshest price and feed it as a synthetic mini-ticker
  // through the same `onMarketEvent` path a real frame uses, so the strategy
  // keeps evaluating during the gap (in-process stops/trailing/time-stop would
  // otherwise freeze until reconnect). Inert while the WS is healthy.
  const marketLivenessWatchdog = createMarketLivenessWatchdog({
    isConnected: () => klineFetcher.isConnected(),
    msSinceLastFrame: () => klineFetcher.msSinceLastFrame(),
    forceReconnect: () => klineFetcher.forceReconnect(),
    subscribedSymbols: () => marketSubscriptions.subscribedSymbols(),
    fetchPrice: createKlineGapPriceFetcher(({ symbol, interval, limit }) =>
      fetchClosedKlines(
        { baseUrl: 'https://api.binance.com', symbol, interval, limit },
        {
          fetch,
          nowMs: () => Date.now(),
          sleep,
          // Bulk weight (no order priority): a gap poll must never starve an order.
          reserveWeight: (w) => weightGovernor.reserve(w),
        },
      ),
    ),
    feed: (e) => eventRouter.onMarketEvent(e),
    clock: { nowMs: () => Date.now() },
    logger,
  });

  // ── Typed back-edges, no forward-ref wrappers ─────────────────────
  // Each setter is the single assign point for one cycle the construction
  // order can't satisfy. All fire before any lifecycle `start()`, so the
  // first WS frame / profile enable sees the wired collaborator.
  klineFetcher.setOnReconnect(() => {
    // A WS reconnect propagates as a per-symbol resync via the subscriptions
    // manager; the event-router turns each onResync(symbol) into a `resync` tick
    // per profile so state computed during the disconnect window is recomputed
    // against authoritative state.
    void triggerResyncForAllSubscribed(marketSubscriptions, (s) => eventRouter.onResync(s));
  });
  profileManager.setMarket({
    addSymbols: (symbols, candleInterval) =>
      marketSubscriptions.addSymbols(symbols, candleInterval),
    removeSymbols: (symbols, candleInterval) =>
      marketSubscriptions.removeSymbols(symbols, candleInterval),
  });
  // Fleet subscription ownership: exactly one live pod holds each account's
  // user-data stream, elected by HRW over the fleet ready-member set. index.ts
  // start()s this AFTER markReady() so this pod is a ready member before it can
  // win an account, and stop()s it on shutdown. selfId must match the member
  // registry's id (both hostname:pid). This is the SOLE opener/closer of the
  // user-data stream (profileManager no longer touches it): at single replica
  // the sole ready member owns every account, so its first reconcile opens all
  // streams at boot; the election only redistributes once replicas>1 is on.
  const subscriptionOwnership = createSubscriptionOwnership({
    redis,
    logger,
    selfId: workerMemberId(),
    pool: userStreamPool,
    listActive: () => profileManager.listActive(),
    metrics: metricsRegistry,
  });

  // Periodic fleet-global membership converge (#579). Re-reads the enabled set
  // and converges profileManager, then re-elects ownership so a runtime
  // subscribe/unsubscribe that a single-consumer pipeline job applied on one pod
  // propagates to every pod. index.ts start()s this after ownership and stop()s
  // it before ownership on shutdown.
  const enabledSetReconciler = createEnabledSetReconciler({
    loadEnabledProfiles,
    profileManager,
    ownership: subscriptionOwnership,
    logger,
  });

  return {
    marketSubscriptions,
    marketLivenessWatchdog,
    subscriptionOwnership,
    enabledSetReconciler,
  };
};
