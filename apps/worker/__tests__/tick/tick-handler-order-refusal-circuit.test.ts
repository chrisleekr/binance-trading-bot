import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { BinanceApiError, type MarketDataPort } from '@app/binance';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { createRegistry, type Decision, type Strategy, type SymbolInfo } from '@app/strategy-core';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';

import type { AuditEntry } from '../../src/audit-shipper/audit-shipper.js';
import { buildOrderRefusalKey } from '../../src/executor/redis-namespace.js';
import { createChainByKey } from '../../src/lib/chain-by-key.js';
import type { TickJobData } from '../../src/queues/job-payloads.js';
import type { ProfileTickContext } from '../../src/tick/build-tick-input.js';
import {
  ORDER_REFUSAL_PROBE_MS,
  ORDER_REFUSAL_TTL_MS,
  parseOrderRefusalState,
} from '../../src/tick/order-refusal-circuit.js';
import { createTickHandler } from '../../src/tick/tick-handler.js';
import type { TickHandlerDeps } from '../../src/tick/tick-types.js';

const OPERATOR = asUserId('11111111-1111-4111-8111-111111111111');
const ACCOUNT = asAccountId('33333333-3333-4333-8333-333333333333');
const PROFILE = asProfileId('22222222-2222-4222-8222-222222222222');
const SYMBOL = 'BTCUSDT';
const START_MS = 1_700_000_000_000;

const PLACE: Extract<Decision, { type: 'place-order' }> = {
  type: 'place-order',
  intent: {
    symbol: SYMBOL,
    side: 'BUY',
    reason: 'entry',
    clientOrderId: 'client-1',
  },
  params: { type: 'LIMIT', quantity: '0.010', price: '50000', timeInForce: 'GTC' },
};

const SYMBOL_INFO: SymbolInfo = {
  symbol: SYMBOL,
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: { minQty: '0.0001', stepSize: '0.0001', minNotional: '10', tickSize: '0.01' },
};

const strategy = {
  name: 'refusal-test',
  version: '1.0.0',
  displayName: 'refusal test',
  description: 'refusal test',
  capabilities: {
    candleIntervals: ['1h'],
    needsUserDataStream: false,
    needsMiniTicker: false,
    bundleProviders: [],
    operatorActions: [],
  },
  bundleSchema: z.object({}),
  initialState: () => ({ schemaVersion: '1.0.0' }),
  tick: () => ({
    nextState: { schemaVersion: '1.0.0', orderEmitted: true },
    decisions: [PLACE],
    logs: [],
    metrics: [],
  }),
} as unknown as Strategy;

const profile = {
  operatorId: OPERATOR,
  accountId: ACCOUNT,
  profileId: PROFILE,
  scope: { operatorId: OPERATOR, accountId: ACCOUNT, profileId: PROFILE },
  symbol: SYMBOL,
  strategyName: strategy.name,
  strategyVersion: strategy.version,
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

const job = {
  data: {
    userId: String(OPERATOR),
    accountId: String(ACCOUNT),
    profileId: String(PROFILE),
    symbol: SYMBOL,
    event: 'tick',
    enqueuedAtMs: START_MS,
    payload: {},
  } satisfies TickJobData,
} as unknown as Job<TickJobData>;

interface HarnessOptions {
  readonly refusalReadError?: boolean;
  readonly refusalWriteError?: boolean;
}

const buildHarness = (options: HarnessOptions = {}) => {
  let nowMs = START_MS;
  let acceptsOrders = false;
  let refusalWritesFail = options.refusalWriteError === true;
  const store = new Map<string, string>();
  const refusalKey = buildOrderRefusalKey(ACCOUNT, PROFILE, SYMBOL);
  // Full argument list, not just key and value: the TTL is the only bound on a
  // refusal key, so a dropped `PX` would leave one resting per (account,
  // profile, symbol) forever and a two-argument double could not see it.
  const setCalls: unknown[][] = [];
  const set = vi.fn(async (key: string, value: string, ...rest: unknown[]) => {
    if (refusalWritesFail && key === refusalKey) throw new Error('refusal write failed');
    setCalls.push([key, value, ...rest]);
    store.set(key, value);
    return 'OK';
  });
  const del = vi.fn(async (...keys: string[]) => {
    let removed = 0;
    for (const key of keys) removed += store.delete(key) ? 1 : 0;
    return removed;
  });
  const redis = {
    pipeline: () => {
      const keys: string[] = [];
      const pipe = {
        get(key: string) {
          keys.push(key);
          return pipe;
        },
        async exec() {
          return keys.map((key) =>
            options.refusalReadError && key === refusalKey
              ? [new Error('refusal read failed'), null]
              : [null, store.get(key) ?? null],
          );
        },
      };
      return pipe;
    },
    set,
    del,
    exists: async () => 0,
  } as unknown as Redis;

  const registry = createRegistry();
  registry.register(strategy);
  const exchangeAttempts: number[] = [];
  const applyOptions: unknown[] = [];
  const refusal = () => {
    const cause = new BinanceApiError(
      { status: 400, code: -2010, msg: 'Account has insufficient balance for requested action.' },
      false,
      'rejected',
    );
    return {
      ok: false as const,
      retryable: false,
      phase: 'rejected' as const,
      reason: cause.message,
      cause,
    };
  };
  const executor = {
    applyAll: async (
      _ctx: unknown,
      _accountId: unknown,
      decisions: readonly Decision[],
      _scope: unknown,
      _resolved: unknown,
      applyOption: { readonly deferRepeatedRefusal?: true } | undefined,
    ) => {
      applyOptions.push(applyOption);
      if (applyOption?.deferRepeatedRefusal === true) {
        return decisions.map((decision) => ({
          decision,
          result: {
            ok: false as const,
            retryable: true,
            phase: 'pre-call' as const,
            deferred: true as const,
            reason: 'deferred: probe once per minute',
          },
        }));
      }
      exchangeAttempts.push(nowMs);
      return decisions.map((decision) => ({
        decision,
        result: acceptsOrders ? ({ ok: true } as const) : refusal(),
      }));
    },
  };
  const commit = vi.fn(async () => undefined);
  const recordOrderRefusalCondition = vi.fn(async () => undefined);
  const notifyOrderFailed = vi.fn(async () => undefined);
  const notifyOrderRefusalLoop = vi.fn(async () => undefined);
  const audits: AuditEntry[] = [];
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const deps = {
    redis,
    registry,
    executor,
    chain: createChainByKey(),
    logger,
    clock: { nowMs: () => nowMs },
    coldLoad: {
      loadAccount: async () => ({ balances: {} }),
      loadAccountDeployedQuote: async () => '0',
      loadOpenOrders: async () => [],
      loadSymbolState: async () => null,
      loadProfileKv: async () => ({}),
    },
    symbolInfoCache: { get: async () => SYMBOL_INFO },
    statePort: {
      loadForTick: async () => ({ state: { schemaVersion: '1.0.0' }, commit }),
    },
    marketDataPort: { loadWindow: async () => [] } as unknown as MarketDataPort,
    resolveProfile: async () => profile,
    auditShipper: {
      publish: async (entry: AuditEntry) => {
        audits.push(entry);
      },
    },
    recordOrderRefusalCondition,
    notifyOrderFailed,
    notifyOrderRefusalLoop,
  } as unknown as TickHandlerDeps;

  return {
    run: () => createTickHandler(deps)(job),
    advance: (ms: number) => {
      nowMs += ms;
    },
    acceptOrders: () => {
      acceptsOrders = true;
    },
    failRefusalWrites: () => {
      refusalWritesFail = true;
    },
    refusalKey,
    store,
    setCalls,
    exchangeAttempts,
    applyOptions,
    commit,
    recordOrderRefusalCondition,
    notifyOrderFailed,
    notifyOrderRefusalLoop,
    audits,
    logger,
  };
};

const drainNotifications = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe('tick handler order-refusal circuit', () => {
  it('sends three identical refusals, suppresses repeats, and probes at exactly 60 seconds', async () => {
    const h = buildHarness();

    await h.run();
    await h.run();
    await h.run();
    await drainNotifications();

    expect(h.exchangeAttempts).toHaveLength(3);
    expect(parseOrderRefusalState(h.store.get(h.refusalKey))).toMatchObject({ count: 3 });
    expect(h.setCalls.filter((call) => call[0] === h.refusalKey).at(-1)).toEqual([
      h.refusalKey,
      expect.any(String),
      'PX',
      ORDER_REFUSAL_TTL_MS,
    ]);
    expect(h.notifyOrderFailed).toHaveBeenCalledTimes(2);
    expect(h.notifyOrderRefusalLoop).toHaveBeenCalledTimes(1);
    expect(h.notifyOrderRefusalLoop).toHaveBeenLastCalledWith(
      expect.objectContaining({ probe: false }),
    );
    const warningsAfterTrip = h.logger.warn.mock.calls.length;

    await h.run();
    h.advance(ORDER_REFUSAL_PROBE_MS - 1);
    await h.run();
    expect(h.exchangeAttempts).toHaveLength(3);
    expect(h.applyOptions.slice(-2)).toEqual([
      { deferRepeatedRefusal: true },
      { deferRepeatedRefusal: true },
    ]);
    expect(h.logger.warn).toHaveBeenCalledTimes(warningsAfterTrip);

    h.advance(1);
    await h.run();
    await drainNotifications();

    expect(h.exchangeAttempts).toHaveLength(4);
    expect(h.notifyOrderRefusalLoop).toHaveBeenCalledTimes(2);
    expect(h.notifyOrderRefusalLoop).toHaveBeenLastCalledWith(
      expect.objectContaining({ probe: true }),
    );
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.recordOrderRefusalCondition.mock.calls.map((call) => call[1]?.code)).toEqual([
      null,
      null,
      '-2010',
      '-2010',
      '-2010',
      '-2010',
    ]);
    expect(h.audits).toHaveLength(6);
  });

  it('clears the Redis circuit and durable condition when a probe succeeds', async () => {
    const h = buildHarness();

    await h.run();
    await h.run();
    await h.run();
    h.advance(ORDER_REFUSAL_PROBE_MS);
    h.acceptOrders();

    await h.run();

    expect(h.exchangeAttempts).toHaveLength(4);
    expect(h.store.has(h.refusalKey)).toBe(false);
    expect(h.recordOrderRefusalCondition).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ code: null }),
    );
    expect(h.commit).toHaveBeenCalledTimes(1);
  });

  it('does not claim a trip when the Redis trip write fails', async () => {
    const h = buildHarness();

    await h.run();
    await h.run();
    h.failRefusalWrites();
    await h.run();
    await drainNotifications();

    expect(parseOrderRefusalState(h.store.get(h.refusalKey))).toMatchObject({ count: 2 });
    expect(h.notifyOrderRefusalLoop).not.toHaveBeenCalled();
    expect(h.notifyOrderFailed).toHaveBeenCalledTimes(3);
  });

  it('does not claim a refused probe when its refreshed deadline is not durable', async () => {
    const h = buildHarness();

    await h.run();
    await h.run();
    await h.run();
    await drainNotifications();
    h.advance(ORDER_REFUSAL_PROBE_MS);
    h.failRefusalWrites();

    await h.run();
    await drainNotifications();

    expect(h.notifyOrderRefusalLoop).toHaveBeenCalledTimes(1);
    expect(h.notifyOrderFailed).toHaveBeenCalledTimes(3);
  });

  it('fails open and skips circuit mutation and condition sync when its snapshot slot errors', async () => {
    const h = buildHarness({ refusalReadError: true });

    await expect(h.run()).resolves.toMatchObject({ decisionCount: 1 });

    expect(h.exchangeAttempts).toHaveLength(1);
    expect(h.store.has(h.refusalKey)).toBe(false);
    expect(h.recordOrderRefusalCondition).not.toHaveBeenCalled();
  });

  it('does not claim a condition transition when the Redis state write fails', async () => {
    const h = buildHarness({ refusalWriteError: true });

    await expect(h.run()).resolves.toMatchObject({ decisionCount: 1 });

    expect(h.exchangeAttempts).toHaveLength(1);
    expect(h.recordOrderRefusalCondition).not.toHaveBeenCalled();
  });
});
