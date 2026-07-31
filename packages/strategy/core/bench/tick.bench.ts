import { bench, describe } from 'vitest';
import { z } from 'zod';
import type { Strategy, TickInput } from '../src/index.js';

const noopStrategy: Strategy<unknown, { counter: number }, Readonly<Record<string, unknown>>> = {
  name: 'bench-noop',
  version: '1.0.0',
  displayName: 'BenchNoop',
  description: 'pure noop for the strategy-core perf gate',
  capabilities: {
    candleIntervals: [],
    needsUserDataStream: false,
    needsMiniTicker: false,
    bundleProviders: [],
    operatorActions: [],
  },
  configSchema: z.unknown(),
  stateSchema: z.object({ counter: z.number() }),
  bundleSchema: z.record(z.string(), z.unknown()),
  events: {},
  initialState: () => ({ counter: 0 }),
  tick: (input) => ({
    nextState: { counter: input.state.counter + 1 },
    decisions: [{ type: 'noop' }],
    logs: [],
    metrics: [],
  }),
};

const baseInput: TickInput<unknown, { counter: number }, Readonly<Record<string, unknown>>> = {
  clock: { nowMs: () => 0 },
  rng: { next: () => 0 },
  trigger: { kind: 'tick' },
  profile: {
    id: 'p1',
    userId: 'u1',
    binanceMode: 'test',
    status: 'running',
    strategyVersion: '1.0.0',
  },
  config: {},
  state: { counter: 0 },
  market: {
    symbol: 'BTCUSDT',
    currentPrice: '0',
    candlesByInterval: {},
    symbolInfo: {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      status: 'TRADING',
      filters: {
        minNotional: '0',
        tickSize: '0.01',
        stepSize: '0.0001',
        minQty: '0',
        maxQty: '0',
        minPrice: '0',
        maxPrice: '0',
      },
    },
  },
  account: { balances: {} },
  openOrders: [],
  bundle: {},
  limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
};

describe('tick() p99 (idle scenario)', () => {
  bench('noop strategy tick', () => {
    noopStrategy.tick(baseInput);
  });
});
