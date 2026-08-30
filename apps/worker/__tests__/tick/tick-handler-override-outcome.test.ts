// The override must be settled on the ORDER'S OUTCOME, not on the strategy's
// intent to act.
//
// The sibling `tick-handler-override-settle.test.ts` proves the intent seam:
// a strategy that says "I deferred" gets its override re-armed. That is only
// half the story. A strategy can emit a perfectly good override-driven order
// and still have it (a) refused before it ever left the process, (b) fail so
// ambiguously that nobody knows whether Binance filled it, (c) be rejected
// outright by Binance, or (d) be dropped by the daily-loss breaker. In every
// one of those cases the operator's action did NOT happen, yet the row is
// marked done and the operator is told it succeeded.
//
// Correlating an order back to the override that caused it is only possible if
// the order CARRIES the override's id (`intent.overrideActionId`) — a heuristic
// ("a BUY got dropped, probably the override's") would settle the wrong row the
// moment a strategy emits an unrelated order in the same tick. And re-arming is
// only safe when the order provably never executed, which is what
// `DecisionResult.phase` reports:
//
//   pre-call  → refused before any Binance call        → safe to re-arm
//   rejected  → Binance parsed it and said no          → provably not executed
//   ambiguous → transport/5xx; may have executed       → NEVER re-arm
//   accepted  → order is live, bookkeeping failed      → NEVER re-arm
//
// Re-arm iff the order provably did not execute AND the cause is transient:
// `(phase === 'pre-call' || phase === 'rejected') && retryable`.
//
// Redis and the executor are stubbed, so this runs on every CI leg.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { MarketDataPort } from '@app/binance';
import { profileKey } from '@app/db';
import { createRegistry, type Strategy, type SymbolInfo } from '@app/strategy-core';
import { z } from 'zod';
import { asAccountId, asProfileId, asUserId, DAILY_ENTRY_HALT_REASON } from '@app/contracts';

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
const HALT_KEY = profileKey({ accountId: ACCOUNT, profileId: PROFILE }, 'entryHaltDaily');

const TTL_MS = 120_000;

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

/** The failure shapes the executor reports; `phase` is what makes re-arm decidable. */
type OrderFailure = {
  readonly ok: false;
  readonly retryable: boolean;
  readonly phase: 'pre-call' | 'rejected' | 'ambiguous' | 'accepted';
  readonly reason: string;
};
type OrderResult = { readonly ok: true } | OrderFailure;

/**
 * ioredis stub covering the tick path: the snapshot pipeline (all slots empty →
 * cold-load), `exists` for the halt flag, and `set` for tick-meta / the re-arm.
 * `halted` arms the daily-loss breaker on its real key so the halt filter runs
 * exactly as it does in production.
 */
const buildFakeRedis = (
  setCalls: unknown[][],
  halted: boolean,
  hangRearm = false,
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
    exists: async (key: string) => (halted && key === HALT_KEY ? 1 : 0),
    // The tick reads the order re-arm flag (audit attribution) and clears it once
    // every order lands. No flag by default.
    get: async () => null,
    set: (...argv: unknown[]): Promise<'OK'> => {
      setCalls.push(argv);
      // A stalled ioredis command never rejects and never resolves: there is no
      // client-side command timeout and `maxRetriesPerRequest: null` keeps it
      // queued. This reproduces exactly that on the re-arm key.
      if (hangRearm && argv[0] === OVERRIDE_KEY) return new Promise<'OK'>(() => {});
      return Promise.resolve('OK');
    },
    del: async () => 1,
  } as unknown as import('ioredis').Redis;
};

const marketDataPort = {
  loadWindow: async () => [],
} as unknown as MarketDataPort;

interface StubOrder {
  readonly side: 'BUY' | 'SELL';
  readonly clientOrderId: string;
  /** Stamped only when this order is the override's; absent = an unrelated order. */
  readonly overrideActionId?: string;
}

/**
 * Stub strategy that ACTS on the override (never defers) and stamps the
 * override's id on the orders it emits because of it. That stamp is the only
 * legitimate way the worker can attribute an order's fate back to the override.
 */
const buildStubStrategy = (orders: readonly StubOrder[]): Strategy =>
  ({
    name: 'stub-outcome',
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
      decisions: orders.map((o) => ({
        type: 'place-order',
        intent: {
          symbol: SYMBOL,
          side: o.side,
          reason: 'operator-override',
          clientOrderId: o.clientOrderId,
          ...(o.overrideActionId === undefined ? {} : { overrideActionId: o.overrideActionId }),
        },
        params: { type: 'MARKET', quantity: '1' },
      })),
      logs: [],
      metrics: [],
    }),
  }) as unknown as Strategy;

interface RunOpts {
  readonly orders: readonly StubOrder[];
  /**
   * Result the executor reports for a place-order. A function keyed on
   * `clientOrderId` lets one tick's orders land differently — which is the whole
   * point of the partial-fan-out case.
   */
  readonly orderResult: OrderResult | ((clientOrderId: string) => OrderResult);
  readonly halted?: boolean;
  /** Make the re-arm `SET` hang forever, as a stalled ioredis command does. */
  readonly hangRearm?: boolean;
  /** Make the row writer throw before it returns a promise, not reject one. */
  readonly settleThrows?: boolean;
}

interface RunResult {
  readonly rearms: unknown[][];
  readonly settleOverrideAction: ReturnType<typeof vi.fn>;
  readonly notifyOverrideOutcome: ReturnType<typeof vi.fn>;
}

const run = async (opts: RunOpts): Promise<RunResult> => {
  const setCalls: unknown[][] = [];
  const redis = buildFakeRedis(setCalls, opts.halted === true, opts.hangRearm === true);
  const resultOf = (clientOrderId: string): OrderResult =>
    typeof opts.orderResult === 'function' ? opts.orderResult(clientOrderId) : opts.orderResult;
  const settleOverrideAction = vi.fn(() => {
    // Not async: the settle's deadline race only guards a promise it was handed,
    // so a throw raised before that promise exists is the shape that escapes it.
    if (opts.settleThrows === true) throw new Error('row writer exploded');
    return Promise.resolve();
  });
  const notifyOverrideOutcome = vi.fn(async () => {});
  const registry = createRegistry();
  registry.register(buildStubStrategy(opts.orders));

  const profile: ProfileTickContext = {
    operatorId: OPERATOR,
    accountId: ACCOUNT,
    profileId: PROFILE,
    scope: { operatorId: OPERATOR, accountId: ACCOUNT, profileId: PROFILE },
    symbol: SYMBOL,
    strategyName: 'stub-outcome',
    strategyVersion: '1.0.0',
    config: {},
    bundleProvider: async () => ({ bundle: { override: OVERRIDE }, overrideTtlMs: TTL_MS }),
    binanceMode: 'test',
    quoteAsset: 'USDT',
    weightLimit1m: 1200,
    candleInterval: '1h',
    technicalsConfig: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
    needsAccountDeployedQuote: false,
  } as unknown as ProfileTickContext;

  const deps = {
    redis,
    registry,
    executor: {
      // Only the decisions that survived the halt filter reach here — the
      // handler must derive "suppressed" from what it did NOT hand over.
      applyAll: async (_ctx: unknown, _accountId: unknown, decisions: readonly unknown[]) =>
        decisions.map((decision) => ({
          decision,
          result: resultOf(
            (decision as { intent: { clientOrderId: string } }).intent.clientOrderId,
          ),
        })),
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
    notifyOverrideOutcome,
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

  await handler(job);

  // The handler also SETs its tick-meta blob; only the override key is a re-arm.
  return {
    rearms: setCalls.filter((argv) => argv[0] === OVERRIDE_KEY),
    settleOverrideAction,
    notifyOverrideOutcome,
  };
};

const overrideSell: StubOrder = {
  side: 'SELL',
  clientOrderId: 'stub-override-sell',
  overrideActionId: OVERRIDE_ACTION_ID,
};
const overrideBuy: StubOrder = {
  side: 'BUY',
  clientOrderId: 'stub-override-buy',
  overrideActionId: OVERRIDE_ACTION_ID,
};

/** The outcome recorded on the `override_actions` row — settle's 3rd argument. */
const settledOutcome = (fn: ReturnType<typeof vi.fn>): { status: string; reason?: string } =>
  (fn.mock.calls[0] as unknown[])[2] as { status: string; reason?: string };

describe('tick handler — override settles on the order outcome', () => {
  it('re-arms an override whose order was refused before any Binance call', async () => {
    // Weight-limit throttle: the order provably never left the process, and the
    // operator's window still has time. Losing it here silently drops a
    // force-sell the operator explicitly asked for.
    const { rearms, settleOverrideAction } = await run({
      orders: [overrideSell],
      orderResult: {
        ok: false,
        retryable: true,
        phase: 'pre-call',
        reason: 'request-weight limit reached; order refused before dispatch',
      },
    });

    expect(rearms).toHaveLength(1);
    expect(rearms[0]?.[1]).toBe(JSON.stringify(OVERRIDE));
    expect(rearms[0]?.[2]).toBe('PX');
    expect(rearms[0]?.[4]).toBe('NX');
    expect(settleOverrideAction).not.toHaveBeenCalled();
  });

  it('re-arms a Binance rejection that is transient, since a parsed code proves nothing executed', async () => {
    // -1003 (too many requests) is a REJECTION — Binance parsed the order and
    // refused it — so retrying cannot duplicate anything, and the cause clears.
    const { rearms, settleOverrideAction } = await run({
      orders: [overrideSell],
      orderResult: {
        ok: false,
        retryable: true,
        phase: 'rejected',
        reason: '-1003 Too many requests',
      },
    });

    expect(rearms).toHaveLength(1);
    expect(settleOverrideAction).not.toHaveBeenCalled();
  });

  it('never re-arms an ambiguous failure; settles it `unknown` and tells the operator', async () => {
    // A 5xx or a transport error means the execution status is UNKNOWN: Binance
    // may have filled the order. Re-arming would risk a second market order, and
    // reporting success would be a lie. Consume it honestly and escalate.
    const { rearms, settleOverrideAction, notifyOverrideOutcome } = await run({
      orders: [overrideSell],
      orderResult: {
        ok: false,
        retryable: true,
        phase: 'ambiguous',
        reason: 'HTTP 503 from Binance; execution status unknown',
      },
    });

    expect(rearms).toHaveLength(0);
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
    expect(settledOutcome(settleOverrideAction)).toEqual({
      status: 'unknown',
      reason: expect.stringContaining('503') as unknown as string,
    });
    expect(notifyOverrideOutcome).toHaveBeenCalledTimes(1);
  });

  it('settles a definitive Binance rejection as `rejected` with the exchange reason', async () => {
    // -2010 is deterministic: retrying just loops to the TTL and buries the real
    // reason. Give the operator the exchange's own words at once.
    const { rearms, settleOverrideAction, notifyOverrideOutcome } = await run({
      orders: [overrideSell],
      orderResult: {
        ok: false,
        retryable: false,
        phase: 'rejected',
        reason: '-2010 Account has insufficient balance for requested action',
      },
    });

    expect(rearms).toHaveLength(0);
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
    expect(settledOutcome(settleOverrideAction)).toEqual({
      status: 'rejected',
      reason: expect.stringContaining('-2010') as unknown as string,
    });
    expect(notifyOverrideOutcome).not.toHaveBeenCalled();
  });

  it('settles a breaker-suppressed override BUY as `rejected` and never re-arms it', async () => {
    // The daily-loss halt lasts until the next UTC day; the override's window is
    // minutes. Re-arming is provably futile, and marking it done would tell the
    // operator their buy went through.
    const { rearms, settleOverrideAction } = await run({
      orders: [overrideBuy],
      orderResult: { ok: true },
      halted: true,
    });

    expect(rearms).toHaveLength(0);
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
    const outcome = settledOutcome(settleOverrideAction);
    expect(outcome.status).toBe('rejected');
    // The breaker's own words, from the one constant the api's 409 also uses, so
    // the operator cannot be told two different things about one breaker.
    expect(outcome.reason).toBe(DAILY_ENTRY_HALT_REASON);
  });

  it('never re-arms an `accepted` failure; settles it `applied` with the bookkeeping reason', async () => {
    // Binance TOOK the order; only the local write failed. Re-arming here would
    // re-place an order that is already live on the exchange — the single most
    // dangerous thing this code can do. It is also NOT an `unknown`: we know
    // exactly what happened, so it must not wake the operator.
    const { rearms, settleOverrideAction, notifyOverrideOutcome } = await run({
      orders: [overrideSell],
      orderResult: {
        ok: false,
        retryable: false,
        phase: 'accepted',
        reason: 'order accepted but bookkeeping failed: persistOrder timed out',
      },
    });

    expect(rearms).toHaveLength(0);
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
    expect(settledOutcome(settleOverrideAction)).toEqual({
      status: 'applied',
      reason: expect.stringContaining('bookkeeping failed') as unknown as string,
    });
    expect(notifyOverrideOutcome).not.toHaveBeenCalled();
  });

  it('never re-arms when ANY order stamped with the override id was accepted', async () => {
    // The fail-safe against a plugin that emits two orders under one override id.
    // The first is accepted by Binance; the second is refused pre-call by the
    // weight throttle — which is retryable and provably-not-executed, i.e. exactly
    // the shape that re-arms. Taking that verdict would hand the override to the
    // next tick, which re-places an order that ALREADY FILLED. One success settles
    // the row, whatever its siblings did.
    const { rearms, settleOverrideAction } = await run({
      orders: [
        { side: 'SELL', clientOrderId: 'stub-first', overrideActionId: OVERRIDE_ACTION_ID },
        { side: 'SELL', clientOrderId: 'stub-second', overrideActionId: OVERRIDE_ACTION_ID },
      ],
      orderResult: (clientOrderId) =>
        clientOrderId === 'stub-first'
          ? { ok: true }
          : {
              ok: false,
              retryable: true,
              phase: 'pre-call',
              reason: 'weight-limit-throttle weight=1200 limit=1200',
            },
    });

    expect(rearms).toHaveLength(0);
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
    const outcome = settledOutcome(settleOverrideAction);
    expect(outcome.status).toBe('applied');
    // The sibling's failure is still triageable — it just does not decide the row.
    expect(outcome.reason).toContain('weight-limit-throttle');
  });

  it('leaves the row pending when the re-arm SET blows its deadline', async () => {
    // A stalled ioredis command neither resolves nor rejects, and the re-arm runs
    // inside the per-symbol chain lock — so an unbounded await would stall the NEXT
    // tick for this symbol too. The deadline turns it into a rejection. The row must
    // NOT be settled: nothing executed, so marking it done would be a lie; the
    // stranded-row reaper resolves it.
    const { rearms, settleOverrideAction, notifyOverrideOutcome } = await run({
      orders: [overrideSell],
      orderResult: {
        ok: false,
        retryable: true,
        phase: 'pre-call',
        reason: 'weight-limit-throttle weight=1200 limit=1200',
      },
      hangRearm: true,
    });

    // The SET was attempted (and hung); the tick still returned.
    expect(rearms).toHaveLength(1);
    expect(settleOverrideAction).not.toHaveBeenCalled();
    expect(notifyOverrideOutcome).not.toHaveBeenCalled();
  });

  it('does not fail the tick when the settle action throws synchronously', async () => {
    // The settle runs one line AFTER the override ticket was disarmed, so a failure
    // escaping it has no compensation left behind it: the orders are already placed
    // and the audit already shipped, and a rejected tick means BullMQ retries the
    // whole thing and the strategy emits them a second time.
    const running = run({
      orders: [overrideSell],
      orderResult: { ok: true },
      settleThrows: true,
    });

    await expect(running).resolves.toBeDefined();
    const { settleOverrideAction } = await running;
    // The write was genuinely attempted; the tick just refuses to die with it.
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
  });

  it('attributes a suppressed BUY to the override only by id, never by heuristic', async () => {
    // The halt drops an unrelated BUY the strategy emitted on its own, while the
    // override's own SELL goes through. Blaming the breaker for the override
    // would settle the wrong row and hide a successful force-sell.
    const { rearms, settleOverrideAction } = await run({
      orders: [{ side: 'BUY', clientOrderId: 'stub-grid-buy' }, overrideSell],
      orderResult: { ok: true },
      halted: true,
    });

    expect(rearms).toHaveLength(0);
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
    expect(settledOutcome(settleOverrideAction).status).toBe('applied');
  });
});
