// Fail-closed propagation, end to end: a tick that emits TWO place-orders must
// fail the JOB (→ DLQ) and leave the per-(profile, symbol) state UN-COMMITTED.
//
// `applyAll` throws `MultiPlacementError` before transmitting anything (the retry
// model cannot express partial-placement progress). The unit test on `applyAll`
// proves the throw; THIS test proves the tick-handler lets it propagate — the
// job fails, nothing swallows it — AND stamps tick-meta first so the DLQ line is
// diagnosable, AND never advances the state. It drives the REAL `createTickHandler`
// with the REAL `createLiveExecutor`: the placement-count check fires before any
// order handler runs, so the throw is genuine without a live Binance path.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { MarketDataPort } from '@app/binance';
import { createRegistry, type Decision, type Strategy, type SymbolInfo } from '@app/strategy-core';
import { z } from 'zod';
import type { NotifyProviderRegistry } from '@app/notify';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';

import { createChainByKey } from '../../src/lib/chain-by-key.js';
import { createLiveExecutor, MultiPlacementError } from '../../src/executor/live-executor.js';
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
  filters: { minQty: '0.00001', stepSize: '0.00001', minNotional: '10', tickSize: '0.01' },
};

const place = (clientOrderId: string): Decision => ({
  type: 'place-order',
  intent: { symbol: SYMBOL, side: 'BUY', reason: 'entry', clientOrderId },
  params: { type: 'MARKET', quantity: '1' },
});

/** The state the strategy WOULD advance to. Committing it would bury the refusal. */
const NEXT_STATE = { schemaVersion: '1.0.0', advanced: true };

const buildStubStrategy = (decisions: readonly Decision[]): Strategy =>
  ({
    name: 'stub-multi-place',
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
    // Permissive: the tick boundary now parses the bundle before tick(), and a
    // stub must satisfy the required contract field without constraining shape.
    bundleSchema: z.object({}),
    initialState: () => ({ schemaVersion: '1.0.0' }),
    tick: () => ({ nextState: NEXT_STATE, decisions, logs: [], metrics: [] }),
  }) as unknown as Strategy;

const drive = async (
  decisions: readonly Decision[],
  /**
   * Replaces the reply of `redis.set` so a test can break the tick-meta stamp. MUST NOT
   * be async here or in the stub below: an async wrapper turns a SYNCHRONOUS throw into
   * a rejection, which the deadline guard already handled before this change.
   */
  redisSet?: (...argv: unknown[]) => unknown,
) => {
  const setCalls: unknown[][] = [];
  const commit = vi.fn(async () => undefined);
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: vi.fn(),
  } as unknown as Logger;

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
    set: (...argv: unknown[]): unknown => {
      setCalls.push(argv);
      return redisSet ? redisSet(...argv) : Promise.resolve('OK');
    },
    del: async () => 1,
  } as unknown as Redis;

  const registry = createRegistry();
  registry.register(buildStubStrategy(decisions));

  const profile = {
    operatorId: OPERATOR,
    accountId: ACCOUNT,
    profileId: PROFILE,
    scope: { operatorId: OPERATOR, accountId: ACCOUNT, profileId: PROFILE },
    symbol: SYMBOL,
    strategyName: 'stub-multi-place',
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

  // The REAL executor: `applyAll` throws MultiPlacementError on the two-placement
  // array before any order handler or `resolveProfile` runs, so the throw the
  // tick-handler must propagate is the production one.
  const executor = createLiveExecutor({
    redis,
    notifyRegistry: {} as unknown as NotifyProviderRegistry,
    strategies: registry,
    logger,
    // Never reached: the placement-count check throws before any handler resolves.
    resolveProfile: vi.fn(async () => ({}) as never),
    notifierGapThrottle: { allow: async () => true },
  });

  const deps = {
    redis,
    registry,
    executor,
    chain: createChainByKey(),
    logger,
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
    notifyOrderFailed: async () => undefined,
  } as unknown as TickHandlerDeps;

  const job = {
    data: {
      userId: String(OPERATOR),
      accountId: String(ACCOUNT),
      profileId: String(PROFILE),
      symbol: SYMBOL,
      event: 'tick',
      enqueuedAtMs: 0,
      payload: {},
    } satisfies TickJobData,
  } as unknown as Job<TickJobData>;

  const outcome = await createTickHandler(deps)(job).then(
    () => ({ thrown: undefined as unknown }),
    (thrown: unknown) => ({ thrown }),
  );

  // The tick-meta stamp is the only `redis.set` carrying `lastTickError`.
  const tickMetaWrites = setCalls.filter(
    (c) => typeof c[1] === 'string' && (c[1] as string).includes('lastTickError'),
  );
  return { outcome, commit, tickMetaWrites };
};

describe('tick handler — a multi-placement tick fails closed (DLQ, state un-committed)', () => {
  it('rejects, stamps tick-meta, and never commits when a tick emits two place-orders', async () => {
    const { outcome, commit, tickMetaWrites } = await drive([place('cid-1'), place('cid-2')]);

    // The job FAILS → BullMQ dead-letters it. Nothing swallowed the throw.
    expect(outcome.thrown).toBeInstanceOf(MultiPlacementError);
    // tick-meta stamped BEFORE the DLQ so the operator gets a diagnosable line,
    // not a bare stack — the error message rides `lastTickError`.
    expect(tickMetaWrites).toHaveLength(1);
    expect(tickMetaWrites[0]?.[1]).toContain('place-order decisions in one tick');
    // The retry model's safety hinge: a refused tick must NOT advance the state.
    expect(commit).not.toHaveBeenCalled();
  });

  it('dead-letters with the ORIGINAL cause even when the tick-meta stamp throws synchronously', async () => {
    // The stamp on this path is AWAITED inside the catch that then rethrows the tick's
    // real error. A synchronously-throwing `redis.set` there does not merely lose the
    // stamp: it replaces the error in flight, so BullMQ dead-letters the job blaming a
    // Redis SET while the actual cause — here a strategy emitting two placements in one
    // tick — never reaches the operator at all. A diagnostic write must never be able
    // to overwrite the diagnosis.
    const stampBoom = new Error('SET exploded before returning a promise');
    const { outcome, commit, tickMetaWrites } = await drive(
      [place('cid-1'), place('cid-2')],
      () => {
        throw stampBoom;
      },
    );

    expect(outcome.thrown).toBeInstanceOf(MultiPlacementError);
    expect(outcome.thrown).not.toBe(stampBoom);
    // Proves the throwing stamp was actually reached, so the assertion above is not
    // passing because the stamp was skipped.
    expect(tickMetaWrites).toHaveLength(1);
    expect(commit).not.toHaveBeenCalled();
  });
});
