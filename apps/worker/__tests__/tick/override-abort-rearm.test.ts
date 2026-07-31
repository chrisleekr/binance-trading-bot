// An operator override is destructively removed from Redis by the bundle-builder
// (`del(overrideKey)`) long before the tick decides its fate. Everything between
// that DEL and `settleOverride` used to be unprotected: the handler's three try
// blocks each ended in `throw err` and none had a `finally`. A throw in that window
// lost the override outright, its `override_actions` row stayed `pending`, and no
// later tick retried it. The operator pressed the button and nothing happened.
//
// These tests drive the REAL `createTickHandler` (same harness shape as
// tick-handler-override-settle.test.ts) and force a throw at each side of the DEL,
// asserting the override survives an aborted tick exactly when re-arming it cannot
// double-execute an order or wedge the symbol behind a poison payload.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { MarketDataPort } from '@app/binance';
import { profileKey } from '@app/db';
import { createRegistry, type Strategy, type SymbolInfo } from '@app/strategy-core';
import { z } from 'zod';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';

import { createChainByKey } from '../../src/lib/chain-by-key.js';
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
const OVERRIDE_TTL_MS = 120_000;
/** Milliseconds the injected clock advances per read. */
const CLOCK_STEP_MS = 25;

const SYMBOL_INFO: SymbolInfo = {
  symbol: SYMBOL,
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  filters: { minQty: '0.00001', stepSize: '0.00001', minNotional: '10', tickSize: '0.01' },
};

/** Distinguishable from an incidental setup failure, so no assertion false-passes. */
class InjectedTickError extends Error {}

/**
 * ioredis stub covering only what the tick path touches: the snapshot pipeline
 * (all slots empty, so cold-load), the tick-meta / re-arm `set`, and `exists`.
 * Every `set` argv is recorded so the override re-arm can be asserted on its key.
 */
const buildFakeRedis = (
  setCalls: unknown[][],
  rejectOverrideSet = false,
): import('ioredis').Redis => {
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
  return {
    pipeline: () => makeChain({ n: 0 }),
    exists: async () => 0,
    get: async () => null,
    set: (...argv: unknown[]): Promise<'OK'> => {
      setCalls.push(argv);
      return rejectOverrideSet && argv[0] === OVERRIDE_KEY
        ? Promise.reject(new Error('redis down'))
        : Promise.resolve('OK');
    },
    del: async () => 1,
  } as unknown as import('ioredis').Redis;
};

const marketDataPort = {
  loadWindow: async () => [],
} as unknown as MarketDataPort;

/**
 * The weight governor's bulk-read backpressure signal. Matched by NAME in
 * `tick-skip.ts` (it crosses a package boundary where `instanceof` can go false),
 * so the stub has to reproduce the name, not the class.
 */
const governorUnavailableError = (): Error => {
  const err = new Error('governor bulk read unavailable');
  err.name = 'RedisUnavailableError';
  return err;
};

const unavailableMarketDataPort = {
  loadWindow: async () => {
    throw governorUnavailableError();
  },
} as unknown as MarketDataPort;

const PLACE_ORDER = {
  type: 'place-order',
  intent: {
    symbol: SYMBOL,
    side: 'SELL',
    reason: 'exit',
    clientOrderId: 'stub-exit-1',
  },
  params: { type: 'MARKET', quantity: '1' },
};

/**
 * Stub strategy honouring `trigger-sell`. `tickThrows` reproduces a plugin fault
 * mid-tick; `placeOrder` makes the tick emit an order, which is what decides
 * whether an aborted tick may re-arm.
 */
const buildStubStrategy = (opts: { tickThrows?: boolean; placeOrder?: boolean }): Strategy =>
  ({
    name: 'stub-abort',
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
    // Permissive: the tick boundary parses the bundle before tick(), and a stub
    // must satisfy the required contract field without constraining shape.
    bundleSchema: z.object({}),
    initialState: () => ({ schemaVersion: '1.0.0' }),
    tick: () => {
      if (opts.tickThrows === true) throw new InjectedTickError('strategy tick blew up');
      return {
        nextState: { schemaVersion: '1.0.0' },
        decisions: opts.placeOrder === true ? [PLACE_ORDER] : [{ type: 'noop' }],
        logs: [],
        metrics: [],
      };
    },
  }) as unknown as Strategy;

interface RunOpts {
  /** `false` models a tick with nothing for the bundle-builder to have consumed. */
  readonly withOverride?: boolean;
  readonly bundleProviderThrows?: boolean;
  readonly tickThrows?: boolean;
  readonly applyAllThrows?: boolean;
  readonly placeOrder?: boolean;
  readonly overrideTtlMs?: number;
  /** Redis refuses the compensating write, the one failure mode the finally must absorb. */
  readonly rejectOverrideSet?: boolean;
  /**
   * The candle load raises the weight governor's backpressure signal, which the
   * handler answers with a graceful skip-RETURN rather than a throw.
   */
  readonly governorUnavailable?: boolean;
}

const run = async (
  opts: RunOpts,
): Promise<{
  setCalls: unknown[][];
  settleOverrideAction: ReturnType<typeof vi.fn>;
  thrown: unknown;
}> => {
  const setCalls: unknown[][] = [];
  const redis = buildFakeRedis(setCalls, opts.rejectOverrideSet === true);
  const settleOverrideAction = vi.fn(async () => {});
  // Monotonic and stepping: every `nowMs()` burns 25ms of the operator's window.
  let nowMs = 1_700_000_000_000;
  const clock = {
    nowMs: () => {
      nowMs += CLOCK_STEP_MS;
      return nowMs;
    },
  };
  const registry = createRegistry();
  registry.register(
    buildStubStrategy({
      ...(opts.tickThrows === undefined ? {} : { tickThrows: opts.tickThrows }),
      ...(opts.placeOrder === undefined ? {} : { placeOrder: opts.placeOrder }),
    }),
  );

  const ttlMs = opts.overrideTtlMs ?? OVERRIDE_TTL_MS;
  const profile: ProfileTickContext = {
    operatorId: OPERATOR,
    accountId: ACCOUNT,
    profileId: PROFILE,
    scope: { operatorId: OPERATOR, accountId: ACCOUNT, profileId: PROFILE },
    symbol: SYMBOL,
    strategyName: 'stub-abort',
    strategyVersion: '1.0.0',
    config: {},
    // The provider stands in for the bundle-builder that already DEL'd the key:
    // a non-null `bundle.override` IS the proof the operator's key is gone.
    bundleProvider: async () => {
      if (opts.bundleProviderThrows === true) {
        throw new InjectedTickError('bundle provider blew up');
      }
      return opts.withOverride === false
        ? { bundle: {} }
        : { bundle: { override: OVERRIDE }, overrideTtlMs: ttlMs };
    },
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
      applyAll: async (_ctx: unknown, _accountId: unknown, decisions: readonly unknown[]) => {
        if (opts.applyAllThrows === true) throw new InjectedTickError('executor blew up');
        return decisions.map((decision) => ({ decision, result: { ok: true } }));
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
    marketDataPort: opts.governorUnavailable === true ? unavailableMarketDataPort : marketDataPort,
    resolveProfile: async () => profile,
    auditShipper: { publish: async () => undefined },
    settleOverrideAction,
    // Advances on every read, so the re-armed window is provably the operator's
    // ORIGINAL deadline minus this tick's latency. A fixed clock would let an
    // `elapsedMs: () => 0` regression pass.
    clock,
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

  const thrown = await createTickHandler(deps)(job).then(
    () => undefined as unknown,
    (err: unknown) => err,
  );
  return { setCalls, settleOverrideAction, thrown };
};

// The handler also SETs its tick-meta blob and the order re-arm flag, so only the
// writes to the override key count as a re-arm.
const rearmCalls = (setCalls: unknown[][]): unknown[][] =>
  setCalls.filter((argv) => argv[0] === OVERRIDE_KEY);

/** The re-arm shape settleOverride already uses: key, value, PX <remaining>, NX. */
const expectRearmShape = (argv: unknown[] | undefined): void => {
  expect(argv?.[1]).toBe(JSON.stringify(OVERRIDE));
  expect(argv?.[2]).toBe('PX');
  // A remainder of the operator's ORIGINAL window, never a fresh one: strictly
  // less than the full TTL, because the stepping clock proves the tick's own
  // latency was charged against it.
  expect(typeof argv?.[3]).toBe('number');
  expect(argv?.[3] as number).toBeGreaterThan(0);
  expect(argv?.[3] as number).toBeLessThan(OVERRIDE_TTL_MS);
  // NX yields to a newer override the operator pushed while this tick was dying.
  expect(argv?.[4]).toBe('NX');
};

describe('tick handler — an aborted tick must not swallow a consumed override', () => {
  it('settles rather than re-arms when the override itself is what killed the tick', async () => {
    // `strategy.tick` is pure, so a throw there is deterministic in this override:
    // the next tick would die at the same line. Re-arming would loop a poison
    // payload to the TTL, and the symbol would commit no state for that whole
    // window — no trailing sell, no protective stop, on a live position. The
    // operator gets a verdict instead.
    const { setCalls, settleOverrideAction, thrown } = await run({ tickThrows: true });

    // The abort itself must still dead-letter the job. The settle is additive.
    expect(thrown).toBeInstanceOf(InjectedTickError);

    expect(rearmCalls(setCalls)).toHaveLength(0);
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
    expect(settleOverrideAction.mock.calls[0]?.[1]).toBe(OVERRIDE_ACTION_ID);
    expect(settleOverrideAction.mock.calls[0]?.[2]).toEqual({
      status: 'rejected',
      reason: expect.any(String) as unknown as string,
    });
  });

  it('re-arms when the executor throws and no order was dispatched', async () => {
    // The tick emitted only a noop, so no order can be live on the exchange and
    // handing the override to the next tick cannot duplicate a trade.
    const { setCalls, settleOverrideAction, thrown } = await run({ applyAllThrows: true });

    expect(thrown).toBeInstanceOf(InjectedTickError);
    const rearms = rearmCalls(setCalls);
    expect(rearms).toHaveLength(1);
    expectRearmShape(rearms[0]);
    expect(settleOverrideAction).not.toHaveBeenCalled();
  });

  it('refuses to re-arm when the executor throws on a tick that dispatched an order', async () => {
    // The executor threw somewhere inside a place-order, so the order may have
    // reached Binance. Re-arming would let the next tick place a SECOND one under
    // a fresh clientOrderId, which Binance's open-order dedup would not catch.
    // Settle the row instead: the operator sees an outcome, not a silent double sell.
    const { setCalls, settleOverrideAction, thrown } = await run({
      applyAllThrows: true,
      placeOrder: true,
    });

    expect(thrown).toBeInstanceOf(InjectedTickError);
    expect(rearmCalls(setCalls)).toHaveLength(0);
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
  });

  it('does not touch the override key when the tick dies before it was consumed', async () => {
    // The bundle-builder never ran, so the operator's key is still in Redis with
    // its own TTL. Writing it back would be inventing state.
    const { setCalls, settleOverrideAction, thrown } = await run({ bundleProviderThrows: true });

    expect(thrown).toBeInstanceOf(InjectedTickError);
    expect(rearmCalls(setCalls)).toHaveLength(0);
    expect(settleOverrideAction).not.toHaveBeenCalled();
  });

  it('does not invent an override when an ordinary tick aborts', async () => {
    // No override in the bundle at all: an abort here has nothing to restore.
    const { setCalls, settleOverrideAction, thrown } = await run({
      withOverride: false,
      tickThrows: true,
    });

    expect(thrown).toBeInstanceOf(InjectedTickError);
    expect(rearmCalls(setCalls)).toHaveLength(0);
    expect(settleOverrideAction).not.toHaveBeenCalled();
  });

  it('re-arms on a graceful skip-return, not only on a throw', async () => {
    // The governor's bulk-read backpressure is answered with a RETURN, not a
    // rethrow, and it is reachable after the bundle read: the candle load runs
    // downstream of it. A compensation hung off the catch blocks alone would miss
    // this entirely and lose the override just as silently.
    const { setCalls, settleOverrideAction, thrown } = await run({ governorUnavailable: true });

    // A skip, so the job resolves and the next market event re-ticks.
    expect(thrown).toBeUndefined();
    const rearms = rearmCalls(setCalls);
    expect(rearms).toHaveLength(1);
    expectRearmShape(rearms[0]);
    expect(settleOverrideAction).not.toHaveBeenCalled();
  });

  it('propagates the original tick error when the compensating re-arm itself fails', async () => {
    // The compensation runs from a `finally` while the real failure is unwinding.
    // A Redis fault there must not become the error the operator sees, or the
    // DLQ line would blame the wrong thing and the executor fault would vanish.
    const { setCalls, settleOverrideAction, thrown } = await run({
      applyAllThrows: true,
      rejectOverrideSet: true,
    });

    expect(thrown).toBeInstanceOf(InjectedTickError);
    expect(rearmCalls(setCalls)).toHaveLength(1);
    // A failed re-arm has still executed nothing, so marking the row done would
    // be a lie; the stranded-row sweep resolves it once the window has passed.
    expect(settleOverrideAction).not.toHaveBeenCalled();
  });

  it('settles a successful override tick exactly once and never re-arms it', async () => {
    // At-most-once guard on the fix itself: an abort-path settle added alongside
    // the existing one must not double-settle the happy path.
    const { setCalls, settleOverrideAction, thrown } = await run({});

    expect(thrown).toBeUndefined();
    expect(rearmCalls(setCalls)).toHaveLength(0);
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
    expect(settleOverrideAction.mock.calls[0]?.[1]).toBe(OVERRIDE_ACTION_ID);
  });
});
