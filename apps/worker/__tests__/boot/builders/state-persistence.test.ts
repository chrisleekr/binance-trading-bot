import { describe, expect, it } from 'vitest';

import { buildChain } from '../../../src/boot/builders/chain.js';
import { buildStatePersistence } from '../../../src/boot/builders/state-persistence.js';
import { fakeDb, fakeQueueSet, fakeRedis, silentLogger } from './fakes.js';

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
    });

    expect(Object.keys(sp).sort()).toEqual([
      'accountSnapshotStore',
      'coldLoad',
      'enqueueSymbolReconcile',
      'fillAdopter',
      'fillBackfiller',
      'metrics',
      'metricsRegistry',
      'persistProfileState',
      'persistSymbolState',
      'statePort',
      'symbolInfoCache',
    ]);
    expect(typeof sp.persistProfileState).toBe('function');
    expect(typeof sp.persistSymbolState).toBe('function');
    // The metrics registry is minted here so the tick + state-commit paths share it.
    expect(sp.metricsRegistry).toBeDefined();
    expect(sp.statePort).toBeDefined();
  });
});
