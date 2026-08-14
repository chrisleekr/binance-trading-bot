// End-to-end wiring of the override-settle seam through the real tick handler.
//
// The unit tests around `settleOverride` prove the decision table; this file
// proves the handler actually FEEDS it — that `output.overrideDeferred` reaches
// `deferred`, that the built tick's `overrideTtlMs` reaches `ttlMs`, and that a
// tick which placed an order can never re-arm. Hard-coding `deferred: false` at
// the call site would leave every settleOverride unit test green, so the seam
// needs its own gate. No testcontainers: the handler's Redis surface is stubbed,
// which keeps this running on every CI leg.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { MarketDataPort } from '@app/binance';
import { profileKey } from '@app/db';
import { createRegistry, type Strategy, type SymbolInfo } from '@app/strategy-core';
import { z } from 'zod';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';

import { createChainByKey } from '../../src/lib/chain-by-key.js';
import { buildOrderRefusalKey } from '../../src/executor/redis-namespace.js';
import { createTickHandler, type TickHandlerDeps } from '../../src/tick/tick-handler.js';
import type { ProfileTickContext } from '../../src/tick/build-tick-input.js';
import type { TickJobData } from '../../src/queues/job-payloads.js';

const OPERATOR = asUserId('11111111-1111-4111-8111-111111111111');
const ACCOUNT = asAccountId('33333333-3333-4333-8333-333333333333');
const PROFILE = asProfileId('22222222-2222-4222-8222-222222222222');
const SYMBOL = 'BTCUSDT';
const OVERRIDE_ACTION_ID = '01234567-89ab-4cde-89ab-cdef01234567';
const OVERRIDE = { kind: 'trigger-sell' as const, overrideActionId: OVERRIDE_ACTION_ID };
const OVERRIDE_KEY = profileKey({ accountId: ACCOUNT, profileId: PROFILE }, 'override', SYMBOL);
const REFUSAL_KEY = buildOrderRefusalKey(ACCOUNT, PROFILE, SYMBOL);

const SYMBOL_INFO: SymbolInfo = {
  symbol: SYMBOL,
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  filters: { minQty: '0.00001', stepSize: '0.00001', minNotional: '10', tickSize: '0.01' },
};

/**
 * ioredis stub covering only what the tick path touches: the snapshot pipeline
 * (all slots empty → cold-load), the tick-meta / re-arm `set`, and `exists`.
 * `set` calls are recorded so the re-arm can be asserted on the exact key.
 */
const buildFakeRedis = (
  setCalls: unknown[][],
  orderRefusal: string | null,
): import('ioredis').Redis => {
  const makeChain = (keys: string[]) => {
    const chain = {
      get(key: string) {
        keys.push(key);
        return chain;
      },
      exec: async () =>
        keys.map((key) => [null, key === REFUSAL_KEY ? orderRefusal : null] as const),
    };
    return chain;
  };
  return {
    pipeline: () => makeChain([]),
    exists: async () => 0,
    // The tick reads the order re-arm flag (audit attribution) and clears it once
    // every order lands. No flag by default.
    get: async () => null,
    set: (...argv: unknown[]): Promise<'OK'> => {
      setCalls.push(argv);
      return Promise.resolve('OK');
    },
    del: async () => 1,
  } as unknown as import('ioredis').Redis;
};

const marketDataPort = {
  loadWindow: async () => [],
} as unknown as MarketDataPort;

/**
 * Stub strategy honouring `trigger-sell`. `deferred` decides whether its tick
 * reports "I could not act"; `placeOrder` makes it also emit an order, which is
 * the combination the handler must refuse to re-arm on.
 */
const buildStubStrategy = (opts: { deferred: boolean; placeOrder?: boolean }): Strategy =>
  ({
    name: 'stub-defer',
    version: '1.0.0',
    displayName: 'stub',
    description: 'stub',
    capabilities: {
      candleIntervals: ['1h'],
      needsUserDataStream: false,
      needsMiniTicker: false,
      bundleProviders: ['override'],
      operatorActions: ['trigger-sell'],
    },
    // Permissive: the tick boundary now parses the bundle before tick(), and a
    // stub must satisfy the required contract field without constraining shape.
    bundleSchema: z.object({}),
    initialState: () => ({ schemaVersion: '1.0.0' }),
    tick: () => ({
      nextState: { schemaVersion: '1.0.0' },
      decisions: opts.placeOrder
        ? [
            {
              type: 'place-order',
              intent: {
                symbol: SYMBOL,
                side: 'SELL',
                reason: 'exit',
                clientOrderId: 'stub-exit-1',
                overrideActionId: OVERRIDE_ACTION_ID,
              },
              params: { type: 'MARKET', quantity: '1' },
            },
          ]
        : [{ type: 'noop' }],
      logs: [],
      metrics: [],
      ...(opts.deferred ? { overrideDeferred: true } : {}),
    }),
  }) as unknown as Strategy;

interface RunOpts {
  readonly deferred: boolean;
  readonly placeOrder?: boolean;
  readonly overrideTtlMs?: number;
  readonly circuitDeferred?: boolean;
}

const run = async (
  opts: RunOpts,
): Promise<{
  setCalls: unknown[][];
  settleOverrideAction: ReturnType<typeof vi.fn>;
  markOverridePickedUp: ReturnType<typeof vi.fn>;
  applyOptions: unknown[];
}> => {
  const setCalls: unknown[][] = [];
  const orderRefusal = opts.circuitDeferred
    ? JSON.stringify({
        v: 1,
        request: {
          clientOrderId: 'stub-exit-1',
          symbol: SYMBOL,
          side: 'SELL',
          type: 'MARKET',
          quantity: '1',
          price: null,
          stopPrice: null,
          timeInForce: null,
        },
        rejection: { code: -2010, msg: 'Account has insufficient balance.' },
        count: 3,
        nextProbeAtMs: Number.MAX_SAFE_INTEGER,
      })
    : null;
  const redis = buildFakeRedis(setCalls, orderRefusal);
  const settleOverrideAction = vi.fn(async () => {});
  const markOverridePickedUp = vi.fn(async () => true);
  const applyOptions: unknown[] = [];
  const registry = createRegistry();
  registry.register(buildStubStrategy(opts));

  const profile: ProfileTickContext = {
    operatorId: OPERATOR,
    accountId: ACCOUNT,
    profileId: PROFILE,
    scope: { operatorId: OPERATOR, accountId: ACCOUNT, profileId: PROFILE },
    symbol: SYMBOL,
    strategyName: 'stub-defer',
    strategyVersion: '1.0.0',
    config: {},
    bundleProvider: async () => ({
      bundle: { override: OVERRIDE },
      ...(opts.overrideTtlMs === undefined ? {} : { overrideTtlMs: opts.overrideTtlMs }),
    }),
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
    executor: {
      // Echo the decisions back as applied, the shape the handler audits on.
      applyAll: async (
        _ctx: unknown,
        _accountId: unknown,
        decisions: readonly unknown[],
        _scope: unknown,
        _resolved: unknown,
        options: { readonly deferRepeatedRefusal?: true } | undefined,
      ) => {
        applyOptions.push(options);
        return decisions.map((decision) => ({
          decision,
          result:
            options?.deferRepeatedRefusal === true
              ? {
                  ok: false as const,
                  retryable: true,
                  phase: 'pre-call' as const,
                  deferred: true as const,
                  reason: 'deferred: repeated refusal circuit',
                }
              : { ok: true as const },
        }));
      },
    },
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
    settleOverrideAction,
    markOverridePickedUp,
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
  return { setCalls, settleOverrideAction, markOverridePickedUp, applyOptions };
};

// Only the override key matters here; the handler also SETs its tick-meta blob.
const rearmCalls = (setCalls: unknown[][]): unknown[][] =>
  setCalls.filter((argv) => argv[0] === OVERRIDE_KEY);

describe('tick handler — override settle wiring', () => {
  it('re-arms the override key when the strategy defers, leaving the row pending', async () => {
    const { setCalls, settleOverrideAction } = await run({
      deferred: true,
      overrideTtlMs: 120_000,
    });

    const rearms = rearmCalls(setCalls);
    expect(rearms).toHaveLength(1);
    expect(rearms[0]?.[1]).toBe(JSON.stringify(OVERRIDE));
    expect(rearms[0]?.[2]).toBe('PX');
    expect(rearms[0]?.[4]).toBe('NX');
    expect(settleOverrideAction).not.toHaveBeenCalled();
  });

  it('consumes the override when the strategy acted on it', async () => {
    const { setCalls, settleOverrideAction } = await run({
      deferred: false,
      overrideTtlMs: 120_000,
    });

    expect(rearmCalls(setCalls)).toHaveLength(0);
    expect(settleOverrideAction).toHaveBeenCalledWith(
      // The scope the tick already proved — the settle re-resolves nothing.
      { operatorId: OPERATOR, accountId: ACCOUNT, profileId: PROFILE },
      OVERRIDE_ACTION_ID,
      // The stub strategy emits a bare noop, so from the worker's side the
      // override produced no order: it declined, and the row says so.
      { status: 'rejected', reason: expect.any(String) as unknown as string },
    );
  });

  it('refuses to re-arm when the deferring tick also placed an order', async () => {
    // A defer means "I could not act". Placing an order says otherwise, and a
    // re-arm would hand the same override to the next tick, which would place a
    // SECOND order under a different clientOrderId. Consume instead.
    const { setCalls, settleOverrideAction } = await run({
      deferred: true,
      placeOrder: true,
      overrideTtlMs: 120_000,
    });

    expect(rearmCalls(setCalls)).toHaveLength(0);
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
  });

  it('re-arms a circuit-deferred override without claiming it was dispatched', async () => {
    const { setCalls, settleOverrideAction, markOverridePickedUp, applyOptions } = await run({
      deferred: true,
      placeOrder: true,
      overrideTtlMs: 120_000,
      circuitDeferred: true,
    });

    expect(applyOptions).toEqual([{ deferRepeatedRefusal: true }]);
    expect(rearmCalls(setCalls)).toHaveLength(1);
    expect(markOverridePickedUp).not.toHaveBeenCalled();
    expect(settleOverrideAction).not.toHaveBeenCalled();
  });

  it('consumes a deferred override when the provider surfaced no TTL', async () => {
    // No known window to restore -> re-arming would invent one.
    const { setCalls, settleOverrideAction } = await run({ deferred: true });

    expect(rearmCalls(setCalls)).toHaveLength(0);
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
  });
});
