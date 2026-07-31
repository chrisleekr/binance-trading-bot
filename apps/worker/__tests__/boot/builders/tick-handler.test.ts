import { describe, expect, it } from 'vitest';

import type { BootEnv } from '../../../src/boot/boot-env.js';
import { buildChain } from '../../../src/boot/builders/chain.js';
import { buildTickHandler } from '../../../src/boot/builders/tick-handler.js';
import { anyProxy, fakeDb, fakeQueueSet, fakeRedis, silentLogger } from './fakes.js';

const ENV: BootEnv = { redisUrl: 'redis://localhost:1', pgUrl: 'postgres://localhost:1/x' };

describe('buildTickHandler', () => {
  it('exposes the profile-context cache (for eviction) and the tick handler', () => {
    const th = buildTickHandler({
      env: ENV,
      db: fakeDb(),
      redis: fakeRedis(),
      logger: silentLogger(),
      chain: buildChain(),
      queueSet: fakeQueueSet(),
      liveExecutor: anyProxy(),
      coldLoad: anyProxy(),
      symbolInfoCache: { get: async () => ({}) } as never,
      statePort: anyProxy(),
      metrics: anyProxy(),
      klineFetcher: anyProxy(),
      notifyEvent: async () => undefined,
      orderFailedThrottle: { allow: async () => true } as never,
      auditShipper: anyProxy(),
    });

    expect(Object.keys(th).sort()).toEqual(['profileContextCache', 'tickHandler']);
    expect(typeof th.profileContextCache.evictProfile).toBe('function');
    expect(th.tickHandler).toBeDefined();
  });
});
