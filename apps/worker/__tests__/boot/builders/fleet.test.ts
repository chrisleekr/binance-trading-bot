import { describe, expect, it, vi } from 'vitest';

import { createMetricsRegistry } from '@app/observability';

import { buildFleet } from '../../../src/boot/builders/fleet.js';
import { anyProxy, fakeRedis, silentLogger } from './fakes.js';

describe('buildFleet', () => {
  it('wires the fleet slice and fires the construction-order back-edges', () => {
    const setOnReconnect = vi.fn();
    const setMarket = vi.fn();
    const fleet = buildFleet({
      redis: fakeRedis(),
      logger: silentLogger(),
      klineFetcher: {
        setOnReconnect,
        isConnected: () => false,
        msSinceLastFrame: () => 0,
        forceReconnect: () => undefined,
      } as never,
      indicatorComputer: { clear: () => undefined } as never,
      weightGovernor: { reserve: async () => true } as never,
      eventRouter: { onMarketEvent: () => undefined, onResync: () => undefined } as never,
      userStreamPool: anyProxy(),
      profileManager: { setMarket, listActive: () => [] } as never,
      loadEnabledProfiles: async () => [],
      // Real registry: subscription-ownership registers a prom-client Gauge at
      // construction, which a proxy can't satisfy.
      metricsRegistry: createMetricsRegistry({ service: 'fleet-test' }),
    });

    expect(Object.keys(fleet).sort()).toEqual([
      'enabledSetReconciler',
      'marketLivenessWatchdog',
      'marketSubscriptions',
      'subscriptionOwnership',
    ]);
    // The two back-edges must fire during construction, before any lifecycle start.
    expect(setOnReconnect).toHaveBeenCalledOnce();
    expect(setMarket).toHaveBeenCalledOnce();
  });
});
