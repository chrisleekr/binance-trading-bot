import { afterEach, describe, expect, it } from 'vitest';

import type { BootEnv } from '../../../src/boot/boot-env.js';
import { buildMarketData } from '../../../src/boot/builders/market-data.js';
import { fakeRedis, silentLogger } from './fakes.js';

const ENV: BootEnv = { redisUrl: 'redis://localhost:1', pgUrl: 'postgres://localhost:1/x' };

describe('buildMarketData', () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
  });

  it('wires the market-data slice without opening the WS', () => {
    const md = buildMarketData({ env: ENV, redis: fakeRedis(), logger: silentLogger() });
    shutdown = () => md.klineFetcher.shutdown();

    expect(Object.keys(md).sort()).toEqual([
      'indicatorComputer',
      'klineFetcher',
      'weightGovernor',
      'wsFactory',
    ]);
    expect(typeof md.wsFactory).toBe('function');
    expect(typeof md.weightGovernor.reserve).toBe('function');
    // Lazy port: the combined-stream socket opens on first subscribe, not at boot.
    expect(md.klineFetcher.isConnected()).toBe(false);
  });
});
