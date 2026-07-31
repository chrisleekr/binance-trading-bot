import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { assertDeterministic } from '../src/determinism.js';
import type { Strategy, TickInput } from '../src/contract.js';

interface NoopState {
  readonly counter: number;
}

const NoopBundleSchema = z.record(z.string(), z.unknown());

const noopStrategy: Strategy<unknown, NoopState, Readonly<Record<string, unknown>>> = {
  name: 'noop',
  version: '1.0.0',
  displayName: 'Noop',
  description: 'pure deterministic test strategy',
  capabilities: {
    candleIntervals: [],
    needsUserDataStream: false,
    needsMiniTicker: false,
    bundleProviders: [],
    operatorActions: [],
  },
  configSchema: z.unknown(),
  stateSchema: z.object({ counter: z.number() }),
  bundleSchema: NoopBundleSchema,
  events: {},
  initialState: () => ({ counter: 0 }),
  tick: (input) => ({
    nextState: { counter: input.state.counter + 1 },
    decisions: [],
    logs: [],
    metrics: [],
  }),
};

const baseInput: TickInput<unknown, NoopState, Readonly<Record<string, unknown>>> = {
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

describe('assertDeterministic', () => {
  it('passes when tick is deterministic', () => {
    const result = assertDeterministic(noopStrategy, baseInput);
    expect(result.equal).toBe(true);
    expect(result.first.nextState.counter).toBe(1);
    expect(result.second.nextState.counter).toBe(1);
  });

  it('throws a cycle-detected error when tick output contains a self-reference', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cyclicStrategy: Strategy<unknown, NoopState, Readonly<Record<string, unknown>>> = {
      ...noopStrategy,
      tick: () => ({
        nextState: cyclic as unknown as NoopState,
        decisions: [],
        logs: [],
        metrics: [],
      }),
    };
    expect(() => assertDeterministic(cyclicStrategy, baseInput)).toThrow(/cycle detected/);
  });

  it('throws when tick output diverges', () => {
    let n = 0;
    const flaky: Strategy<unknown, NoopState, Readonly<Record<string, unknown>>> = {
      ...noopStrategy,
      tick: () => ({
        nextState: { counter: n++ },
        decisions: [],
        logs: [],
        metrics: [],
      }),
    };
    expect(() => assertDeterministic(flaky, baseInput)).toThrow(/divergent output/);
  });
});
