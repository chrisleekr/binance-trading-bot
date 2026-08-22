// The LIVE tick fails closed on a schema-invalid assembled bundle: it must be
// rejected BEFORE `strategy.tick` runs, so the job DLQs and the
// per-(profile, symbol) state stays UN-COMMITTED — a malformed bundle must never
// reach the strategy or advance state.
//
// Drives the REAL `createTickHandler` to a ready tick (mirrors
// tick-handler-multi-place.test.ts), but the stub declares a bundleSchema that
// rejects the assembled `{}` bundle and its `tick` is a spy. The handler throws
// the schema error at the boundary: `tick` is never called, the executor is
// never reached, and `commit` never runs.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { MarketDataPort } from '@app/binance';
import { createRegistry, type Strategy, type SymbolInfo } from '@app/strategy-core';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { z } from 'zod';

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
 * Stub strategy whose bundleSchema demands a key the assembled bundle (`{}`) does
 * not carry, so the parse gate rejects it. `tick` returns a benign noop and
 * is a spy: without the gate it IS invoked; with the gate it must not be.
 */
const buildStubStrategy = (tick: ReturnType<typeof vi.fn>): Strategy =>
  ({
    name: 'stub-bundle-schema',
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
    // Rejects the assembled `{}` bundle: `mustBePresent` is required.
    bundleSchema: z.object({ mustBePresent: z.string() }),
    initialState: () => ({ schemaVersion: '1.0.0' }),
    tick,
  }) as unknown as Strategy;

const run = async () => {
  const tick = vi.fn(() => ({
    nextState: { schemaVersion: '1.0.0' },
    decisions: [],
    logs: [],
    metrics: [],
  }));
  const commit = vi.fn(async () => undefined);
  const applyAll = vi.fn(
    async (_ctx: unknown, _accountId: unknown, decisions: readonly unknown[]) =>
      decisions.map((decision) => ({ decision, result: { ok: true } })),
  );

  const makeChain = (count: { n: number }) => {
    const chain = {
      get() {
        count.n += 1;
        return chain;
      },
      exec: async () => Array.from({ length: count.n }, () => [null, null] as const),
    };
    return chain;
  };
  const redis = {
    pipeline: () => makeChain({ n: 0 }),
    exists: async () => 0,
    get: async () => null,
    set: async () => 'OK',
    del: async () => 1,
  } as unknown as Redis;

  const registry = createRegistry();
  registry.register(buildStubStrategy(tick));

  const profile = {
    operatorId: OPERATOR,
    accountId: ACCOUNT,
    profileId: PROFILE,
    scope: { operatorId: OPERATOR, accountId: ACCOUNT, profileId: PROFILE },
    symbol: SYMBOL,
    strategyName: 'stub-bundle-schema',
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
    executor: { applyAll },
    chain: createChainByKey(),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as unknown as Logger,
    coldLoad: {
      loadAccount: async () => ({ balances: {} }),
      loadAccountDeployedQuote: async () => '0',
      loadOpenOrders: async () => [],
      loadSymbolState: async () => null,
    },
    symbolInfoCache: { get: async () => SYMBOL_INFO },
    statePort: {
      loadForTick: async () => ({ state: { schemaVersion: '1.0.0' }, commit }),
    },
    marketDataPort: { loadWindow: async () => [] } as unknown as MarketDataPort,
    resolveProfile: async () => profile,
    auditShipper: { publish: async () => undefined },
    settleOverrideAction: vi.fn(async () => {}),
  } as unknown as TickHandlerDeps;

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

  const outcome = await createTickHandler(deps)(job).then(
    () => ({ thrown: undefined as unknown }),
    (thrown: unknown) => ({ thrown }),
  );
  return { outcome, tick, applyAll, commit };
};

describe('tick handler — a schema-invalid bundle fails closed before strategy.tick', () => {
  it('rejects at the boundary, never calls tick/executor, and never commits state', async () => {
    const { outcome, tick, applyAll, commit } = await run();

    // The throw must be the SCHEMA rejection, not an unrelated setup failure —
    // an unrelated throw could otherwise false-pass the fail-closed assertions.
    expect(outcome.thrown).toBeInstanceOf(z.ZodError);
    // The strategy never runs on an invalid bundle.
    expect(tick).not.toHaveBeenCalled();
    // No decision reaches the executor.
    expect(applyAll).not.toHaveBeenCalled();
    // Fail-closed hinge: a rejected tick must NOT advance the persisted state.
    expect(commit).not.toHaveBeenCalled();
  });
});
