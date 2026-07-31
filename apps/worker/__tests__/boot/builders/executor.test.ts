import { describe, expect, it } from 'vitest';

import { buildExecutor } from '../../../src/boot/builders/executor.js';
import { fakeDb, fakeRedis, silentLogger } from './fakes.js';

describe('buildExecutor', () => {
  it('constructs the live executor', () => {
    const { liveExecutor } = buildExecutor({
      db: fakeDb(),
      redis: fakeRedis(),
      logger: silentLogger(),
      liveDemo: false,
      profileManager: { listActive: () => [] } as never,
      enqueueSymbolReconcile: async () => undefined,
    });
    expect(liveExecutor).toBeDefined();
  });
});
