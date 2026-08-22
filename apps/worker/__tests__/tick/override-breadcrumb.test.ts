// The pre-dispatch breadcrumb: durable proof that a tick took an override.
//
// The expiry sweep settles every override row still pending after its Redis key
// can only have expired. Without a breadcrumb it cannot tell "no tick ever fired
// inside the window" — harmless — from "a tick consumed the override, put an
// order on the wire, and was SIGKILLed before it could record the outcome", which
// may have left a real position on the exchange. Both collapse into one `expired`
// sentence today, and no operator ever sees it: the sweep only touches rows older
// than the window the override read route serves, so a swept row is unreadable by
// the API and fires no notification. The crashed-tick case reaches the operator
// nowhere at all.
//
// The row is the only place that distinction survives a SIGKILL, and a breadcrumb
// written AFTER the order is exactly the state a crash erases. So two properties
// are pinned here:
//   1. Ordering — the stamp is awaited to completion before the executor can
//      transmit anything.
//   2. Cost — the stamp is diagnostics, not the tick. A rejection, a synchronous
//      throw, or a stall must not fail, abort, or delay the tick past the same
//      persist deadline every other bookkeeping write is bounded by.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { MarketDataPort } from '@app/binance';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { createRegistry, type Strategy, type SymbolInfo } from '@app/strategy-core';
import { z } from 'zod';

import { createChainByKey } from '../../src/lib/chain-by-key.js';
import { createTickHandler, type TickHandlerDeps } from '../../src/tick/tick-handler.js';
import type { ProfileTickContext } from '../../src/tick/build-tick-input.js';
import type { TickJobData } from '../../src/queues/job-payloads.js';

const OPERATOR = asUserId('11111111-1111-4111-8111-111111111111');
const ACCOUNT = asAccountId('33333333-3333-4333-8333-333333333333');
const PROFILE = asProfileId('22222222-2222-4222-8222-222222222222');
const SCOPE = { operatorId: OPERATOR, accountId: ACCOUNT, profileId: PROFILE };
const SYMBOL = 'BTCUSDT';
const OVERRIDE_ACTION_ID = '01234567-89ab-4cde-89ab-cdef01234567';
const OVERRIDE = { kind: 'trigger-sell' as const, overrideActionId: OVERRIDE_ACTION_ID };

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

/** ioredis stub: empty snapshot slots (cold-load), plus the tick-meta/re-arm SETs. */
const buildFakeRedis = (): import('ioredis').Redis => {
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
    set: async () => 'OK',
    del: async () => 1,
  } as unknown as import('ioredis').Redis;
};

const marketDataPort = {
  loadWindow: async () => [],
} as unknown as MarketDataPort;

/**
 * Stub honouring `trigger-sell` by emitting a real market SELL: the breadcrumb's
 * whole purpose is to precede an order that can reach Binance, so a strategy that
 * only noops would leave the ordering claim untested. `emitOrder: false` is the
 * other half — a tick that consumed the override and decided against acting.
 */
const buildStubStrategy = (emitOrder: boolean): Strategy =>
  ({
    name: 'stub-breadcrumb',
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
    bundleSchema: z.object({}),
    initialState: () => ({ schemaVersion: '1.0.0' }),
    tick: () => ({
      nextState: { schemaVersion: '1.0.0' },
      decisions: emitOrder
        ? [
            {
              type: 'place-order',
              intent: {
                symbol: SYMBOL,
                side: 'SELL',
                reason: 'exit',
                clientOrderId: 'stub-exit-1',
              },
              params: { type: 'MARKET', quantity: '1' },
            },
          ]
        : [],
      logs: [],
      metrics: [],
    }),
  }) as unknown as Strategy;

interface RunOpts {
  /** Shared ordering log; the executor stub appends to it too. */
  readonly calls?: string[];
  readonly markOverridePickedUp?: TickHandlerDeps['markOverridePickedUp'];
  /** False drops the override from the bundle, leaving the tick nothing to stamp. */
  readonly withOverride?: boolean;
  /** False makes the strategy consume the override and emit no decisions at all. */
  readonly emitOrder?: boolean;
  readonly persistTimeoutMs?: number;
}

interface RunResult {
  readonly calls: string[];
  readonly warn: ReturnType<typeof vi.fn>;
  readonly applyAll: ReturnType<typeof vi.fn>;
  readonly markOverridePickedUp: ReturnType<typeof vi.fn>;
  readonly settleOverrideAction: ReturnType<typeof vi.fn>;
}

const run = async (opts: RunOpts = {}): Promise<RunResult> => {
  const calls = opts.calls ?? [];
  const warn = vi.fn();
  const applyAll = vi.fn(
    async (_ctx: unknown, _accountId: unknown, decisions: readonly unknown[]) => {
      calls.push('applyAll');
      return decisions.map((decision) => ({ decision, result: { ok: true } }));
    },
  );
  const markOverridePickedUp = vi.fn(opts.markOverridePickedUp ?? (async () => undefined));
  const settleOverrideAction = vi.fn(async () => undefined);
  const registry = createRegistry();
  registry.register(buildStubStrategy(opts.emitOrder !== false));

  const profile: ProfileTickContext = {
    operatorId: OPERATOR,
    accountId: ACCOUNT,
    profileId: PROFILE,
    scope: SCOPE,
    symbol: SYMBOL,
    strategyName: 'stub-breadcrumb',
    strategyVersion: '1.0.0',
    config: {},
    bundleProvider: async () => ({
      bundle: opts.withOverride === false ? {} : { override: OVERRIDE },
      overrideTtlMs: 120_000,
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
    redis: buildFakeRedis(),
    registry,
    executor: { applyAll },
    chain: createChainByKey(),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn,
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
    markOverridePickedUp,
    settleOverrideAction,
    ...(opts.persistTimeoutMs === undefined ? {} : { persistTimeoutMs: opts.persistTimeoutMs }),
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

  await createTickHandler(deps)(job);
  return { calls, warn, applyAll, markOverridePickedUp, settleOverrideAction };
};

/**
 * The tick warns about plenty of things; only a line naming the breadcrumb counts.
 * Matched loosely on wording, strictly on attribution — a diagnostic that cannot
 * say WHICH override lost its breadcrumb is not usable at 3am.
 */
const breadcrumbWarns = (warn: ReturnType<typeof vi.fn>): unknown[][] =>
  warn.mock.calls.filter((argv) => /breadcrumb|picked[- ]up/i.test(String(argv[1])));

describe('tick handler — override breadcrumb', () => {
  it('awaits the breadcrumb to completion before the executor can dispatch', async () => {
    // Order-sensitive on purpose, and held open by a gate rather than a sleep: the
    // dispatch cannot merely be slower than the stamp, it must be BLOCKED on it.
    // The stamp records both its entry and its settlement, so a fire-and-forget call
    // (or one moved below `applyAll`) leaves 'applyAll' ahead of 'stamp:settled'.
    // Merely asserting both were called would pass for either arrangement.
    const calls: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Generous deadline: the persist budget firing would let the dispatch through
    // for a reason other than the one under test.
    const pending = run({
      calls,
      persistTimeoutMs: 5_000,
      markOverridePickedUp: async () => {
        calls.push('stamp:entered');
        await gate;
        calls.push('stamp:settled');
      },
    });

    // The tick is now parked on the unresolved stamp. Nothing may have dispatched.
    await vi.waitFor(() => expect(calls).toContain('stamp:entered'));
    expect(calls).not.toContain('applyAll');

    release();
    const { markOverridePickedUp, applyAll } = await pending;

    expect(markOverridePickedUp).toHaveBeenCalledTimes(1);
    expect(applyAll).toHaveBeenCalledTimes(1);
    expect(calls).toContain('stamp:settled');
    expect(calls).toContain('applyAll');
    expect(calls.indexOf('stamp:entered')).toBeLessThan(calls.indexOf('applyAll'));
    expect(calls.indexOf('stamp:settled')).toBeLessThan(calls.indexOf('applyAll'));
  });

  it('stamps once, with the scope the tick already proved', async () => {
    // Re-stamping would move the breadcrumb's timestamp forward on every tick,
    // and the scope is passed rather than re-resolved: the ownership chain was
    // proven upstream, so a second `scopeProfile` SELECT here buys nothing.
    const { markOverridePickedUp } = await run();

    expect(markOverridePickedUp).toHaveBeenCalledTimes(1);
    expect(markOverridePickedUp).toHaveBeenCalledWith(SCOPE, OVERRIDE_ACTION_ID);
  });

  it('does not stamp when the tick carries no override', async () => {
    // An ordinary tick must not write to `override_actions` at all.
    const { markOverridePickedUp, applyAll } = await run({ withOverride: false });

    expect(markOverridePickedUp).not.toHaveBeenCalled();
    expect(applyAll).toHaveBeenCalledTimes(1);
  });

  it('does not stamp when the tick consumed the override but emitted no order', async () => {
    // The breadcrumb means "an order may be on the wire". A tick that emitted
    // nothing proves the opposite, and stamping it would have the sweep alarm the
    // operator about a live order for an override that never reached the exchange —
    // while destroying the true reading of that row, which is "nothing ran, press it
    // again". Every other case here dispatches, so without this one the trigger could
    // sit anywhere upstream of the executor and still look correct.
    const { markOverridePickedUp, applyAll, settleOverrideAction } = await run({
      emitOrder: false,
    });

    expect(markOverridePickedUp).not.toHaveBeenCalled();
    // The tick still ran and still closed the override out: only the breadcrumb is
    // withheld, so this is not passing for want of a tick.
    expect(applyAll).toHaveBeenCalledTimes(1);
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
  });

  it('runs the tick to completion when the breadcrumb write rejects', async () => {
    // The breadcrumb exists to explain a crash. Letting it CAUSE one — aborting a
    // force-sell the operator is waiting on because a diagnostic insert failed —
    // inverts its purpose.
    const { warn, applyAll, settleOverrideAction } = await run({
      markOverridePickedUp: async () => {
        throw new Error('pg exploded');
      },
    });

    expect(applyAll).toHaveBeenCalledTimes(1);
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
    expect(breadcrumbWarns(warn)).toHaveLength(1);
    expect(breadcrumbWarns(warn)[0]?.[0]).toMatchObject({
      symbol: SYMBOL,
      overrideActionId: OVERRIDE_ACTION_ID,
    });
  });

  it('survives a breadcrumb that throws synchronously', async () => {
    // A bare `deps.markOverridePickedUp(...)` lets a synchronous throw escape any
    // `.catch()` or deadline race wrapped around the promise it never returned.
    const { warn, applyAll, settleOverrideAction } = await run({
      markOverridePickedUp: (() => {
        throw new Error('bad scope');
      }) as unknown as TickHandlerDeps['markOverridePickedUp'],
    });

    expect(applyAll).toHaveBeenCalledTimes(1);
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
    expect(breadcrumbWarns(warn)).toHaveLength(1);
  });

  it('does not wait past the persist deadline for a stalled breadcrumb', async () => {
    // A wedged Postgres must cost the tick its deadline, not the tick. Unbounded,
    // this never resolves and the test times out rather than passing slowly.
    const { warn, applyAll, settleOverrideAction } = await run({
      persistTimeoutMs: 20,
      markOverridePickedUp: () => new Promise<void>(() => undefined),
    });

    expect(applyAll).toHaveBeenCalledTimes(1);
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
    expect(breadcrumbWarns(warn)).toHaveLength(1);
  });
});
