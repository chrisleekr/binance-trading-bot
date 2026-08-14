import { describe, expect, it, vi } from 'vitest';

import { buildChain } from '../../../src/boot/builders/chain.js';
import type { SymbolInfoCacheDeps } from '../../../src/tick/symbol-info-cache.js';
import { fakeDb, fakeQueueSet, fakeRedis, silentLogger } from './fakes.js';

/**
 * The cache builds its own miss-recovery `createExchangeInfoRefresh` internally,
 * so the only place the forwarding is observable is the deps it was handed.
 */
const captured: { symbolInfoCache?: SymbolInfoCacheDeps } = {};
vi.mock('../../../src/tick/symbol-info-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/tick/symbol-info-cache.js')>();
  return {
    ...actual,
    createSymbolInfoCache: (deps: SymbolInfoCacheDeps) => {
      captured.symbolInfoCache = deps;
      return actual.createSymbolInfoCache(deps);
    },
  };
});

const { buildStatePersistence } = await import('../../../src/boot/builders/state-persistence.js');

const METRICS = { record: () => undefined, forget: () => undefined };

describe('buildStatePersistence', () => {
  it('wires the full state + persistence slice', () => {
    const sp = buildStatePersistence({
      db: fakeDb(),
      redis: fakeRedis(),
      logger: silentLogger(),
      chain: buildChain(),
      resolveBinanceClient: async () => null,
      queueSet: fakeQueueSet(),
      notifyEvent: async () => undefined,
      metrics: METRICS,
    });

    expect(Object.keys(sp).sort()).toEqual([
      'accountSnapshotStore',
      'coldLoad',
      'enqueueSymbolReconcile',
      'fillAdopter',
      'fillBackfiller',
      'persistProfileState',
      'persistSymbolState',
      'statePort',
      'symbolInfoCache',
    ]);
    expect(typeof sp.persistProfileState).toBe('function');
    expect(typeof sp.persistSymbolState).toBe('function');
    // The registry is NOT minted here: builders that run earlier record too, so
    // owning it here would hand them a second registry /metrics never serves.
    expect(sp).not.toHaveProperty('metricsRegistry');
    expect(sp.statePort).toBeDefined();
  });

  it('forwards the metrics sink into the symbol-info cache', () => {
    // The cache's default refresh closure is a SECOND `createExchangeInfoRefresh`
    // call site, run on every cache miss. Without the sink it parses the same
    // payload and drops the same filters while the drift counters read healthy.
    buildStatePersistence({
      db: fakeDb(),
      redis: fakeRedis(),
      logger: silentLogger(),
      chain: buildChain(),
      resolveBinanceClient: async () => null,
      queueSet: fakeQueueSet(),
      notifyEvent: async () => undefined,
      metrics: METRICS,
    });

    expect(captured.symbolInfoCache?.metrics).toBe(METRICS);
  });
});
