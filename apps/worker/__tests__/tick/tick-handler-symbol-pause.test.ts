// End-to-end wiring of the per-symbol "Pause" kill-switch (issue #658) through
// the real tick handler.
//
// A per-coin Pause writes a `disable-action:<symbol>` Redis key; the tick reads
// it on the snapshot pipeline and short-circuits. This gate proves the handler
// treats a paused symbol as a silent throttled noop: NO executor call (no
// cancel/sell), the distinct `tick_throttled_symbol_pause` metric, and NO
// action-log write. Without it a paused coin would keep buying and selling.
// No testcontainers — the handler's Redis surface is stubbed — so it runs on
// every CI leg. Mirrors tick-handler-override-settle.test.ts.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { MarketDataPort } from '@app/binance';
import { createRegistry, type Strategy, type SymbolInfo } from '@app/strategy-core';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';

// The entry-blocker on-change writer resolves a bound repo from the scope and
// appends an action_log. Mock the binding so any action-log write is observable;
// a paused tick must NOT append (C5).
const appendSpy = vi.fn(async () => undefined);
vi.mock('@app/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@app/db')>();
  return { ...actual, profileRepoFromScope: () => ({ actionLogs: { append: appendSpy } }) };
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
  filters: { minQty: '0.00001', stepSize: '0.00001', minNotional: '10', tickSize: '0.01' },
};

/**
 * Key-aware ioredis stub. The snapshot pipeline replies one `[err, val]` tuple
 * per queued GET, in order: every slot is a clean cache miss EXCEPT any
 * `disable-action` key, which returns `[null, '1']` — i.e. the symbol is PAUSED.
 * readRawSnapshot GETs that key on the pipeline, so a non-null reply drives the
 * tick to a paused noop (the fake errors/answers that exact slot by key,
 * independent of its cursor position).
 */
const buildFakeRedis = (): import('ioredis').Redis => {
  const makePipeline = () => {
    const queued: string[] = [];
    const pipeline = {
      get(key: string) {
        queued.push(key);
        return pipeline;
      },
      exec: async () =>
        queued.map((k) => (k.includes(':disable-action:') ? [null, '1'] : [null, null])),
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

/**
 * Stub strategy that always wants to SELL. If the pause is NOT enforced the
 * handler forwards this order to the executor — the exact money-affecting
 * behaviour the gate must catch.
 */
const buildSellStrategy = (): Strategy =>
  ({
    name: 'stub-pause',
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
    tick: () => ({
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
    }),
  }) as unknown as Strategy;

const run = async (): Promise<{
  applyAll: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
}> => {
  appendSpy.mockClear();
  const redis = buildFakeRedis();
  const applyAll = vi.fn(
    async (_ctx: unknown, _accountId: unknown, decisions: readonly unknown[]) =>
      decisions.map((decision) => ({ decision, result: { ok: true } })),
  );
  const record = vi.fn();
  const registry = createRegistry();
  registry.register(buildSellStrategy());

  const profile: ProfileTickContext = {
    operatorId: OPERATOR,
    accountId: ACCOUNT,
    profileId: PROFILE,
    scope: { operatorId: OPERATOR, accountId: ACCOUNT, profileId: PROFILE },
    symbol: SYMBOL,
    strategyName: 'stub-pause',
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
    metrics: { record },
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
      event: 'tick',
      enqueuedAtMs: 0,
      payload: {},
    } satisfies TickJobData,
  } as unknown as Job<TickJobData>;

  await handler(job);
  return { applyAll, record };
};

describe('tick handler — per-symbol pause (#658)', () => {
  it('does no executor work and records the pause throttle metric when the symbol is paused', async () => {
    // C3 + C5. A paused symbol freezes ALL new buy+sell decisions: the strategy
    // wants to SELL, but the handler short-circuits to a silent throttled noop
    // BEFORE the executor — no cancel, no sell, no order at all — records the
    // distinct `tick_throttled_symbol_pause` metric, and writes NO action-log.
    // Without the short-circuit the tick would reach executor.applyAll with the
    // SELL and never record the pause metric.
    const { applyAll, record } = await run();

    expect(applyAll).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      'tick_throttled_symbol_pause',
      1,
      expect.objectContaining({ profileId: PROFILE, symbol: SYMBOL }),
    );
    expect(appendSpy).not.toHaveBeenCalled();
  });
});
