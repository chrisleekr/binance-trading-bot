// Per-invocation tick counters. Every alert about tick health is a ratio, and a
// ratio needs a denominator that moves on EVERY path — success, throttled skip,
// and throw alike. `tick_latency_ms` is recorded on the success path only, so a
// worker whose ticks all throw reports no latency and no failures: it looks
// idle, which is indistinguishable from healthy.
//
// The failure counter is the numerator, and it must not double-count a throttle:
// a paused symbol is the operator's own instruction, not a fault.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { MarketDataPort } from '@app/binance';
import { createRegistry, type Strategy, type SymbolInfo } from '@app/strategy-core';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';

// The blocker on-change writer resolves a bound repo from the scope. Stub the
// binding so the handler never reaches a real database. It must carry the shape
// the writer actually calls: a stub missing it still passes every counter
// assertion below, because the writer swallows its own failures — which would
// silently make these the error path's counters rather than the success path's.
// WHAT it writes is asserted in build-tick-input.test.ts, not here.
vi.mock('@app/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@app/db')>();
  return {
    ...actual,
    profileRepoFromScope: () => ({
      conditionStates: {
        recordCondition: async () => ({ changed: true as const, previousCode: null, sinceMs: 0 }),
      },
    }),
  };
});

import { createChainByKey } from '../../src/lib/chain-by-key.js';
import { createTickHandler, type TickHandlerDeps } from '../../src/tick/tick-handler.js';
import type { ProfileTickContext } from '../../src/tick/build-tick-input.js';
import type { TickJobData } from '../../src/queues/job-payloads.js';

const OPERATOR = asUserId('11111111-1111-4111-8111-111111111111');
const ACCOUNT = asAccountId('33333333-3333-4333-8333-333333333333');
const PROFILE = asProfileId('22222222-2222-4222-8222-222222222222');
const SYMBOL = 'BTCUSDT';

const SYMBOL_INFO: SymbolInfo = {
  symbol: SYMBOL,
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: {
    minQty: '0.00001',
    stepSize: '0.00001',
    minNotional: '10',
    tickSize: '0.01',
    maxQty: '1000000',
    minPrice: '0.00000001',
    maxPrice: '100000000',
  },
};

/**
 * Key-aware ioredis stub. The snapshot pipeline replies one `[err, val]` tuple
 * per queued GET; every slot is a clean cache miss, except that a `disable-action`
 * key answers `[null, '1']` when the symbol is paused, which is what drives the
 * handler to a throttled skip.
 */
const buildFakeRedis = (paused: boolean): import('ioredis').Redis => {
  const makePipeline = () => {
    const queued: string[] = [];
    const pipeline = {
      get(key: string) {
        queued.push(key);
        return pipeline;
      },
      exec: async () =>
        queued.map((k) => (paused && k.includes(':disable-action:') ? [null, '1'] : [null, null])),
    };
    return pipeline;
  };
  return {
    pipeline: () => makePipeline(),
    exists: async () => 0,
    get: async () => null,
    set: async () => 'OK',
    del: async () => 1,
  } as unknown as import('ioredis').Redis;
};

const marketDataPort = {
  loadWindow: async () => [],
} as unknown as MarketDataPort;

/** The one error identity the rethrow assertion follows end to end. */
const TICK_BOOM = new Error('strategy exploded');

/** Stub strategy that either wants to SELL or blows up inside `tick()`. */
const buildSellStrategy = (throws: boolean): Strategy =>
  ({
    name: 'stub-counters',
    version: '1.0.0',
    displayName: 'stub',
    description: 'stub',
    capabilities: {
      candleIntervals: ['1h'],
      needsUserDataStream: false,
      needsMiniTicker: false,
      bundleProviders: [],
      operatorActions: [],
    },
    initialState: () => ({ schemaVersion: '1.0.0' }),
    // The handler validates the assembled bundle before calling `tick()`, so the
    // stub needs a schema that accepts anything or the tick never runs.
    bundleSchema: { parse: (value: unknown) => value },
    tick: () => {
      if (throws) throw TICK_BOOM;
      return {
        nextState: { schemaVersion: '1.0.0' },
        decisions: [
          {
            type: 'place-order',
            intent: { symbol: SYMBOL, side: 'SELL', reason: 'exit', clientOrderId: 'stub-sell-1' },
            params: { type: 'MARKET', quantity: '1' },
          },
        ],
        logs: [],
        metrics: [],
      };
    },
  }) as unknown as Strategy;

const run = async (
  opts: { paused?: boolean; throws?: boolean } = {},
): Promise<{
  applyAll: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
  thrown: unknown;
}> => {
  const redis = buildFakeRedis(opts.paused ?? false);
  const applyAll = vi.fn(
    async (_ctx: unknown, _accountId: unknown, decisions: readonly unknown[]) =>
      decisions.map((decision) => ({ decision, result: { ok: true } })),
  );
  const record = vi.fn();
  const registry = createRegistry();
  registry.register(buildSellStrategy(opts.throws ?? false));

  const profile: ProfileTickContext = {
    operatorId: OPERATOR,
    accountId: ACCOUNT,
    profileId: PROFILE,
    scope: { operatorId: OPERATOR, accountId: ACCOUNT, profileId: PROFILE },
    symbol: SYMBOL,
    strategyName: 'stub-counters',
    strategyVersion: '1.0.0',
    config: {},
    bundleProvider: async () => ({ bundle: {} }),
    binanceMode: 'test',
    quoteAsset: 'USDT',
    weightLimit1m: 1200,
    candleInterval: '1h',
    technicalsConfig: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
    needsAccountDeployedQuote: false,
    reserveBaseQuantity: null,
  } as unknown as ProfileTickContext;

  const deps = {
    redis,
    registry,
    metrics: { record, forget: vi.fn() },
    executor: { applyAll },
    chain: createChainByKey(),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    coldLoad: {
      loadAccount: async () => ({ balances: {} }),
      loadAccountDeployedQuote: async () => '0',
      loadOpenOrders: async () => [],
      loadSymbolState: async () => null,
    },
    symbolInfoCache: { get: async () => SYMBOL_INFO },
    statePort: {
      loadForTick: async () => ({
        state: { schemaVersion: '1.0.0' },
        commit: async () => undefined,
      }),
    },
    marketDataPort,
    resolveProfile: async () => profile,
    auditShipper: { publish: async () => undefined },
    settleOverrideAction: vi.fn(async () => {}),
  } as unknown as TickHandlerDeps;

  const handler = createTickHandler(deps);
  const job = {
    data: {
      userId: String(OPERATOR),
      accountId: String(ACCOUNT),
      profileId: String(PROFILE),
      symbol: SYMBOL,
      event: 'resync',
      enqueuedAtMs: 0,
      payload: {},
    } satisfies TickJobData,
  } as unknown as Job<TickJobData>;

  let thrown: unknown = null;
  try {
    await handler(job);
  } catch (err) {
    thrown = err;
  }
  return { applyAll, record, thrown };
};

/** How many times the handler emitted `name`, whatever labels it carried. */
const countOf = (record: ReturnType<typeof vi.fn>, name: string): number =>
  record.mock.calls.filter((call) => call[0] === name).length;

describe('tick handler — per-invocation counters', () => {
  it('counts a tick that completes', async () => {
    const { record } = await run();
    expect(countOf(record, 'tick_total')).toBe(1);
    expect(countOf(record, 'tick_failures_total')).toBe(0);
  });

  it('counts a tick the operator throttled, and does not call it a failure', async () => {
    // A paused symbol is an instruction, not a fault. Counting it as a failure
    // would keep a failure-ratio alert firing for as long as the pause stands.
    const { record, applyAll } = await run({ paused: true });
    expect(applyAll).not.toHaveBeenCalled();
    expect(countOf(record, 'tick_total')).toBe(1);
    expect(countOf(record, 'tick_failures_total')).toBe(0);
  });

  it('counts a tick that throws, and rethrows it unchanged so the DLQ still sees it', async () => {
    const { record, thrown } = await run({ throws: true });
    expect(thrown).toBe(TICK_BOOM);
    expect(countOf(record, 'tick_total')).toBe(1);
    expect(countOf(record, 'tick_failures_total')).toBe(1);
  });
});
