import { describe, expect, it } from 'vitest';

import { buildEventStream } from '../../../src/boot/builders/event-stream.js';
import { anyProxy, fakeDb, fakeQueueSet, fakeRedis, silentLogger } from './fakes.js';

describe('buildEventStream', () => {
  it('constructs the router before the pool and keeps both private', () => {
    const es = buildEventStream({
      db: fakeDb(),
      redis: fakeRedis(),
      logger: silentLogger(),
      queueSet: fakeQueueSet(),
      wsFactory: () => anyProxy(),
      profileManager: { listActive: () => [] } as never,
      indicatorComputer: { clear: () => undefined } as never,
      fillAdopter: anyProxy(),
      fillBackfiller: { backfill: async () => undefined } as never,
      accountSnapshotStore: { mergeAccount: () => undefined } as never,
      notifierGapThrottle: anyProxy(),
      enqueueSymbolReconcile: async () => undefined,
      resolveBinanceFull: async () => null,
    });

    expect(Object.keys(es).sort()).toEqual(['eventRouter', 'userStreamPool']);
    expect(es.eventRouter).toBeDefined();
    expect(es.userStreamPool).toBeDefined();
  });
});
