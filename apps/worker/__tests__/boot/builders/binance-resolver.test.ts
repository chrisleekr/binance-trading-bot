import { describe, expect, it } from 'vitest';

import { buildBinanceResolver } from '../../../src/boot/builders/binance-resolver.js';
import { anyProxy, fakeDb, fakeRedis, silentLogger } from './fakes.js';

describe('buildBinanceResolver', () => {
  it('exposes the resolve + exchange-info surface', () => {
    const r = buildBinanceResolver({
      db: fakeDb(),
      redis: fakeRedis(),
      logger: silentLogger(),
      weightGovernor: anyProxy(),
    });
    expect(Object.keys(r).sort()).toEqual([
      'exchangeInfoRefresh',
      'resolveBinanceClient',
      'resolveBinanceFull',
    ]);
    expect(typeof r.resolveBinanceFull).toBe('function');
    expect(typeof r.resolveBinanceClient).toBe('function');
    expect(typeof r.exchangeInfoRefresh).toBe('function');
  });
});
