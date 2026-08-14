import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import { BinanceApiError, OrderBudgetUnavailableError, type BinanceRestClient } from '@app/binance';
import type { NotifyProviderRegistry, AnyNotifyProvider } from '@app/notify';
import type { Decision, ExecutorContext } from '@app/strategy-core';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';

import { placeOrderHandler } from '../../../src/executor/decisions/place-order.js';
import { buildAccountInfoKey } from '../../../src/executor/redis-namespace.js';
import { isOrderRetriable } from '../../../src/tick/override-settlement.js';
import type { DecisionDeps } from '../../../src/executor/decisions/_types.js';
import { createCancelLedger } from '../../../src/executor/cancel-ledger.js';
import { createPlacementDedup } from '../../../src/executor/placement-dedup.js';
import type { ProfileExecutorBindings } from '../../../src/executor/live-executor.js';
import type { ProfilePersistence } from '../../../src/profile-bindings/persistence.js';

const USER = asUserId('00000000-0000-0000-0000-0000000000aa');
const PROFILE = asProfileId('00000000-0000-0000-0000-0000000000bb');
const ACCOUNT = asAccountId('00000000-0000-0000-0000-0000000000cc');
const CTX: ExecutorContext = { userId: USER, profileId: PROFILE };

const PLACE: Extract<Decision, { type: 'place-order' }> = {
  type: 'place-order',
  intent: {
    symbol: 'BTCUSDT',
    side: 'BUY',
    reason: 'tt-buy',
    clientOrderId: 'client-1',
  },
  params: { type: 'MARKET', quantity: '0.001' },
};

const fakeRedis = (): Redis =>
  ({
    set: vi.fn(async () => 'OK'),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 0),
    incr: vi.fn(async () => 1),
    // A resting placement upserts the shared open-orders list via an atomic Lua
    // EVAL; the mock resolves it so the best-effort cache write is a no-op here.
    eval: vi.fn(async () => null),
    multi: vi.fn(() => {
      const pipeline = {
        publish: vi.fn(() => pipeline),
        xadd: vi.fn(() => pipeline),
        exec: vi.fn(async () => []),
      };
      return pipeline;
    }),
  }) as unknown as Redis;

const fakeBinance = (overrides: Partial<BinanceRestClient> = {}): BinanceRestClient =>
  ({
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    ctx: () => ({ weightUsed1m: 50, mode: 'live' as const }),
    ...overrides,
  }) as unknown as BinanceRestClient;

const buildBindings = (
  overrides: Partial<Omit<ProfileExecutorBindings, 'persistence'>> & {
    persistence?: Partial<ProfilePersistence>;
  } = {},
): ProfileExecutorBindings => {
  const { persistence: persistenceOverrides, ...rest } = overrides;
  return {
    mode: 'live',
    binance: fakeBinance(),
    weightLimit1m: 1200,
    quoteAsset: 'USDT',
    ...rest,
    persistence: {
      persistOrder: vi.fn(async () => undefined) as unknown as ProfilePersistence['persistOrder'],
      resolveOrderSlot: async () => null,
      persistTrackingOrder: vi.fn(async () => undefined),
      closeOrder: async () => undefined,
      recordBookkeepingFailure: vi.fn(async () => undefined),
      listEnabledNotifiers: vi.fn(async () => [ENABLED_SLACK_ROW]),
      recordNotifierGap: vi.fn(async () => undefined),
      ...persistenceOverrides,
    },
  } as ProfileExecutorBindings;
};

/** A default enabled Slack notifier row so emergency-notify has somewhere to send. */
const ENABLED_SLACK_ROW = { provider: 'slack', config: {}, secrets: {}, enabled: true } as const;

const buildDeps = (bindings: ProfileExecutorBindings, redis: Redis = fakeRedis()): DecisionDeps => {
  const registry: Partial<NotifyProviderRegistry> = {
    get: () => undefined,
    list: () => [],
  };
  return {
    redis,
    logger: pino({ level: 'silent' }),
    clock: { nowMs: () => 1_700_000_000_000 },
    weightTtlSeconds: 120,
    notifyRegistry: registry as NotifyProviderRegistry,
    resolveProfile: async () => bindings,
    cancelLedger: createCancelLedger(),
  };
};

describe('placeOrderHandler', () => {
  it('weight-throttle returns retryable=true without calling Binance', async () => {
    const binance = fakeBinance();
    const bindings = buildBindings({ binance, weightLimit1m: 100 });
    const redis = fakeRedis();
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce('150');
    const deps = buildDeps(bindings, redis);

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.retryable).toBe(true);
      expect(out.reason).toContain('weight-limit-throttle');
    }
    expect(binance.placeOrder).not.toHaveBeenCalled();
  });

  it('suppresses a duplicate MARKET placement (same clientOrderId within the window) and does not call Binance', async () => {
    const binance = fakeBinance();
    const bindings = buildBindings({ binance });
    const dedup = createPlacementDedup();
    // A prior tick already placed this exact MARKET order this window.
    dedup.record('client-1', 'acc:BTCUSDT', 1_700_000_000_000);
    const deps: DecisionDeps = { ...buildDeps(bindings), placementDedup: dedup };

    const out = await placeOrderHandler(deps, CTX, PLACE);

    // Reports success (the order this decision wanted IS on the exchange) so the
    // tick advances rather than retrying, and Binance is never re-called.
    expect(out).toEqual({ ok: true });
    expect(binance.placeOrder).not.toHaveBeenCalled();
  });

  it('records an accepted MARKET placement so the very next identical one is suppressed', async () => {
    const placeOrder = vi.fn(async () => ({
      orderId: 42,
      clientOrderId: 'client-1',
      status: 'FILLED',
    }));
    const binance = fakeBinance({ placeOrder });
    const bindings = buildBindings({ binance });
    const deps: DecisionDeps = { ...buildDeps(bindings), placementDedup: createPlacementDedup() };

    const first = await placeOrderHandler(deps, CTX, PLACE);
    const second = await placeOrderHandler(deps, CTX, PLACE);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    // The first lands; the second is suppressed by the dedup recorded on the first.
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it('does NOT dedup a LIMIT order (resting order repricing legitimately reuses the clientOrderId)', async () => {
    const placeOrder = vi.fn(async () => ({
      orderId: 43,
      clientOrderId: 'client-1',
      status: 'NEW',
    }));
    const binance = fakeBinance({ placeOrder });
    const bindings = buildBindings({ binance });
    const deps: DecisionDeps = { ...buildDeps(bindings), placementDedup: createPlacementDedup() };
    const limit: Extract<Decision, { type: 'place-order' }> = {
      ...PLACE,
      params: { type: 'LIMIT', quantity: '0.001', price: '50000', timeInForce: 'GTC' },
    };

    await placeOrderHandler(deps, CTX, limit);
    await placeOrderHandler(deps, CTX, limit);

    // Both LIMIT placements reach Binance — the MARKET-only guard never fires.
    expect(placeOrder).toHaveBeenCalledTimes(2);
  });

  it('a SELL forgets the symbol dedup so a legit re-entry (same stable clientOrderId) is NOT suppressed', async () => {
    const placeOrder = vi.fn(async () => ({
      orderId: 42,
      clientOrderId: 'client-1',
      status: 'FILLED',
    }));
    const binance = fakeBinance({ placeOrder });
    const bindings = buildBindings({ binance });
    const deps: DecisionDeps = { ...buildDeps(bindings), placementDedup: createPlacementDedup() };
    const sell: Extract<Decision, { type: 'place-order' }> = {
      ...PLACE,
      intent: { ...PLACE.intent, side: 'SELL', reason: 'tt-sell', clientOrderId: 'client-sell' },
    };

    await placeOrderHandler(deps, CTX, PLACE); // entry recorded
    await placeOrderHandler(deps, CTX, sell); // exit forgets this symbol's entry records
    await placeOrderHandler(deps, CTX, PLACE); // re-entry (same id) — must place, not suppress

    // Two BUYs reach Binance: the SELL cleared the dedup between them.
    const buyCalls = placeOrder.mock.calls.filter((c) => (c[0] as { side: string }).side === 'BUY');
    expect(buyCalls).toHaveLength(2);
  });

  it('records the dedup on accept even when post-submit bookkeeping fails, so the next identical MARKET order is suppressed', async () => {
    const placeOrder = vi.fn(async () => ({
      orderId: 42,
      clientOrderId: 'client-1',
      status: 'FILLED',
    }));
    const bindings = buildBindings({
      binance: fakeBinance({ placeOrder }),
      persistence: {
        persistOrder: vi.fn(async () => {
          throw new Error('pg down');
        }) as unknown as ProfilePersistence['persistOrder'],
      },
    });
    const deps: DecisionDeps = { ...buildDeps(bindings), placementDedup: createPlacementDedup() };

    const first = await placeOrderHandler(deps, CTX, PLACE); // accepted; bookkeeping throws
    const second = await placeOrderHandler(deps, CTX, PLACE); // suppressed by the on-accept record

    expect(first.ok).toBe(false); // bookkeeping failure is non-retryable
    expect(second).toEqual({ ok: true });
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it('post-submit bookkeeping failure is non-retryable and notifies + logs the orphan', async () => {
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => ({
        orderId: 42,
        clientOrderId: 'client-1',
        status: 'FILLED',
      })),
    } as unknown as Partial<BinanceRestClient>);
    const persistOrder = vi.fn(async () => {
      throw new Error('disk full');
    });
    const recordBookkeepingFailure = vi.fn(async () => undefined);
    const bindings = buildBindings({
      binance,
      persistence: {
        persistOrder: persistOrder as unknown as ProfilePersistence['persistOrder'],
        recordBookkeepingFailure,
      },
    });
    const provider: AnyNotifyProvider = {
      name: 'slack',
      send: vi.fn(async () => undefined),
    } as unknown as AnyNotifyProvider;
    const registry: Partial<NotifyProviderRegistry> = {
      get: (n) => (n === 'slack' ? provider : undefined),
      list: () => [provider],
    };
    const deps: DecisionDeps = {
      ...buildDeps(bindings),
      notifyRegistry: registry as NotifyProviderRegistry,
    };

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.retryable).toBe(false);
      // The producer half of the phase contract. Binance ACCEPTED this order —
      // only the local write failed — so the order is live on the exchange and no
      // caller may re-issue it. The override settle reads this exact field to
      // decide whether to re-arm; `rejected` here would double a market order.
      expect(out.phase).toBe('accepted');
      expect(out.reason).toContain('bookkeeping failed');
    }
    // No silent failure: the orphan is surfaced to the operator and the log.
    expect(provider.send).toHaveBeenCalledOnce();
    expect((provider.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      message: {
        topic: 'order-bookkeeping-failed',
        severity: 'error',
        title: 'Order placed but not recorded',
        symbol: 'BTCUSDT',
      },
    });
    expect(recordBookkeepingFailure).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      orderId: 42,
      err: 'disk full',
    });
  });

  it('writes a tracking row carrying the REAL Binance id when the normal write fails', async () => {
    // The order is live. Without a row carrying its Binance id, the user-data
    // stream cannot reconcile the fill and the operator's only trace is an orphan
    // alert 10 minutes later. The recovery row is what makes it reconcilable.
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => ({
        orderId: 42,
        clientOrderId: 'client-1',
        status: 'NEW',
      })),
    } as unknown as Partial<BinanceRestClient>);
    const persistTrackingOrder = vi.fn(async () => undefined);
    const bindings = buildBindings({
      binance,
      persistence: {
        persistOrder: (async () => {
          throw new Error('live slot occupied');
        }) as unknown as ProfilePersistence['persistOrder'],
        persistTrackingOrder:
          persistTrackingOrder as unknown as ProfilePersistence['persistTrackingOrder'],
      },
    });

    const out = await placeOrderHandler(buildDeps(bindings), CTX, PLACE);

    expect(persistTrackingOrder).toHaveBeenCalledWith(
      expect.objectContaining({ binanceOrderId: 42n, clientOrderId: 'client-1', status: 'NEW' }),
    );
    expect(out.ok).toBe(false);
  });

  it('a failing tracking-row write does not change the bookkeeping verdict', async () => {
    // It is a recovery path: its own failure must not mask the original error nor
    // flip the non-retryable result that keeps the live order from being doubled.
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => ({ orderId: 42, clientOrderId: 'client-1', status: 'NEW' })),
    } as unknown as Partial<BinanceRestClient>);
    const bindings = buildBindings({
      binance,
      persistence: {
        persistOrder: (async () => {
          throw new Error('disk full');
        }) as unknown as ProfilePersistence['persistOrder'],
        persistTrackingOrder: (async () => {
          throw new Error('pg down');
        }) as unknown as ProfilePersistence['persistTrackingOrder'],
      },
    });

    const out = await placeOrderHandler(buildDeps(bindings), CTX, PLACE);

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.phase).toBe('accepted');
      expect(out.retryable).toBe(false);
      expect(out.reason).toContain('disk full');
    }
  });

  it('captures the drizzle PG root cause from err.cause in the recorded bookkeeping failure', async () => {
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => ({
        orderId: 42,
        clientOrderId: 'client-1',
        status: 'FILLED',
      })),
    } as unknown as Partial<BinanceRestClient>);
    const persistOrder = vi.fn(async () => {
      const e = new Error('Failed query: insert into orders ...');
      (e as { cause?: unknown }).cause =
        'null value in column "status" violates not-null constraint';
      throw e;
    });
    const recordBookkeepingFailure = vi.fn(async () => undefined);
    const bindings = buildBindings({
      binance,
      persistence: {
        persistOrder: persistOrder as unknown as ProfilePersistence['persistOrder'],
        recordBookkeepingFailure,
      },
    });

    const out = await placeOrderHandler(buildDeps(bindings), CTX, PLACE);

    expect(out.ok).toBe(false);
    expect(recordBookkeepingFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.stringContaining('null value in column'),
      }),
    );
    const recordedErr = (recordBookkeepingFailure.mock.calls[0]?.[0] as { err: string }).err;
    expect(recordedErr).toContain('Failed query: insert into orders');
  });

  it('bookkeeping failure on a profile with no enabled notifiers writes an order-bookkeeping-failed gap and still records the failure', async () => {
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => ({
        orderId: 42,
        clientOrderId: 'client-1',
        status: 'FILLED',
      })),
    } as unknown as Partial<BinanceRestClient>);
    const persistOrder = vi.fn(async () => {
      throw new Error('disk full');
    });
    const recordBookkeepingFailure = vi.fn(async () => undefined);
    const recordNotifierGap = vi.fn(async () => undefined);
    const bindings = buildBindings({
      binance,
      persistence: {
        persistOrder: persistOrder as unknown as ProfilePersistence['persistOrder'],
        recordBookkeepingFailure,
        listEnabledNotifiers: vi.fn(async () => []),
        recordNotifierGap,
      },
    });
    const deps = buildDeps(bindings);

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.retryable).toBe(false);
    expect(recordNotifierGap).toHaveBeenCalledOnce();
    expect(recordNotifierGap.mock.calls[0]?.[0]).toMatchObject({
      topic: 'order-bookkeeping-failed',
      symbol: 'BTCUSDT',
    });
    expect(recordBookkeepingFailure).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      orderId: 42,
      err: 'disk full',
    });
  });

  it('regression: a gap-trace DB blip during the bookkeeping catch cannot throw into place-order — still returns non-retryable and records the failure', async () => {
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => ({
        orderId: 42,
        clientOrderId: 'client-1',
        status: 'FILLED',
      })),
    } as unknown as Partial<BinanceRestClient>);
    const persistOrder = vi.fn(async () => {
      throw new Error('disk full');
    });
    const recordBookkeepingFailure = vi.fn(async () => undefined);
    const bindings = buildBindings({
      binance,
      persistence: {
        persistOrder: persistOrder as unknown as ProfilePersistence['persistOrder'],
        recordBookkeepingFailure,
        // The gap-read itself blips: the try/catch in emergencyNotify must
        // swallow it so the non-retryable RETURN contract holds (a throw here
        // would replay the BullMQ job and place a duplicate live order).
        listEnabledNotifiers: vi.fn(async () => {
          throw new Error('db unreachable');
        }),
        recordNotifierGap: vi.fn(async () => undefined),
      },
    });
    const deps = buildDeps(bindings);

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.retryable).toBe(false);
      expect(out.reason).toContain('bookkeeping failed');
    }
    expect(recordBookkeepingFailure).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      orderId: 42,
      err: 'disk full',
    });
  });

  it('weight-throttle on a profile with no enabled notifiers writes a binance-weight-throttle gap and returns retryable', async () => {
    const binance = fakeBinance();
    const recordNotifierGap = vi.fn(async () => undefined);
    const bindings = buildBindings({
      binance,
      weightLimit1m: 100,
      persistence: {
        listEnabledNotifiers: vi.fn(async () => []),
        recordNotifierGap,
      },
    });
    const redis = fakeRedis();
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce('150');
    const deps = buildDeps(bindings, redis);

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.retryable).toBe(true);
    expect(recordNotifierGap).toHaveBeenCalledOnce();
    expect(recordNotifierGap.mock.calls[0]?.[0]).toMatchObject({
      topic: 'binance-weight-throttle',
      symbol: 'BTCUSDT',
    });
    expect(binance.placeOrder).not.toHaveBeenCalled();
  });

  it("persists status='NEW' when the accepted order's response carries no status (ACK shape)", async () => {
    // STOP_LOSS_LIMIT entries return an ACK-shape response with no `status`
    // field. orders.status is NOT NULL, so passing dto.status (undefined)
    // straight through fails the insert for every real resting BUY.
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => ({ orderId: 99, clientOrderId: 'client-1' })),
    } as unknown as Partial<BinanceRestClient>);
    const persistOrder = vi.fn(async () => undefined);
    const bindings = buildBindings({
      binance,
      persistence: {
        persistOrder: persistOrder as unknown as ProfilePersistence['persistOrder'],
      },
    });
    // Capture the published `orders` events so we assert the WS payload — not
    // just the DB row — carries the defaulted status (both call sites changed).
    const published: string[] = [];
    const redis = {
      set: vi.fn(async () => 'OK'),
      get: vi.fn(async () => null),
      del: vi.fn(async () => 0),
      incr: vi.fn(async () => 1),
      multi: vi.fn(() => {
        const pipeline = {
          publish: vi.fn((_ch: string, body: string) => {
            published.push(body);
            return pipeline;
          }),
          xadd: vi.fn(() => pipeline),
          exec: vi.fn(async () => []),
        };
        return pipeline;
      }),
    } as unknown as Redis;
    const deps = buildDeps(bindings, redis);

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out).toEqual({ ok: true });
    expect(persistOrder).toHaveBeenCalledWith(expect.objectContaining({ status: 'NEW' }), {
      // No cancel failed this tick, so reusing the live slot is safe.
      closePrevious: true,
    });
    const arg = persistOrder.mock.calls[0]?.[0] as { status?: string };
    expect(arg?.status).toBe('NEW');
    // The order-accepted WS event must also carry status='NEW', not undefined.
    const ordersEvents = published
      .map((b) => JSON.parse(b) as { topic?: string; payload?: { status?: string } })
      .filter((e) => e.topic === 'orders');
    expect(ordersEvents.some((e) => e.payload?.status === 'NEW')).toBe(true);
  });

  it('UPSERTs the placed order into the open-orders cache instead of DELeting the key (E3)', async () => {
    // Issue #649 C1: a successful placement patches the cached open-orders list
    // in place via the atomic Lua EVAL (op 'upsert', full order payload, TTL),
    // so a sibling profile's next tick sees the new resting order without a REST
    // cold-load. Today place-order DELs the whole key. RED until Phase B.
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => ({ orderId: 99, clientOrderId: 'client-1', status: 'NEW' })),
    } as unknown as Partial<BinanceRestClient>);
    const bindings = buildBindings({ binance });
    const redis = {
      set: vi.fn(async () => 'OK'),
      get: vi.fn(async () => null),
      del: vi.fn(async () => 0),
      incr: vi.fn(async () => 1),
      eval: vi.fn(async () => null),
      multi: vi.fn(() => {
        const pipeline = {
          publish: vi.fn(() => pipeline),
          xadd: vi.fn(() => pipeline),
          exec: vi.fn(async () => []),
        };
        return pipeline;
      }),
    } as unknown as Redis;
    const deps = { ...buildDeps(bindings, redis), accountId: ACCOUNT };

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out).toEqual({ ok: true });
    // upsert op with a JSON payload carrying the placed order's identity.
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringMatching(/open-orders:BTCUSDT$/),
      'upsert',
      expect.stringContaining('"orderId":99'),
      expect.anything(),
    );
    // No whole-key DEL of the open-orders snapshot.
    const delKeys = (redis.del as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(delKeys.some((k) => /open-orders/.test(k))).toBe(false);
  });

  it('sends a native trailing stop as a STOP_LOSS with a delta and no prices, and caches it that way', async () => {
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => ({ orderId: 77, clientOrderId: 'client-1', status: 'NEW' })),
    } as unknown as Partial<BinanceRestClient>);
    const bindings = buildBindings({ binance });
    const redis = fakeRedis();
    const deps = { ...buildDeps(bindings, redis), accountId: ACCOUNT };

    const trail: Extract<Decision, { type: 'place-order' }> = {
      type: 'place-order',
      intent: {
        symbol: 'BTCUSDT',
        side: 'SELL',
        reason: 'protective-stop',
        clientOrderId: 'client-1',
      },
      params: { type: 'STOP_LOSS', quantity: '0.001', trailingDelta: 1551 },
    };

    expect(await placeOrderHandler(deps, CTX, trail)).toEqual({ ok: true });
    expect(binance.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'STOP_LOSS', trailingDelta: 1551 }),
    );
    const sent = (binance.placeOrder as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      Record<string, unknown> | undefined;
    // Binance rejects a trailing STOP_LOSS that also carries a trigger, and the
    // whole point of the order is that it has no banded price to refuse.
    expect(sent).not.toHaveProperty('stopPrice');
    expect(sent).not.toHaveProperty('price');

    const upsert = (redis.eval as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[3] === 'upsert',
    );
    const cached = JSON.parse(String(upsert?.[4])) as Record<string, unknown>;
    expect(cached.trailingDelta).toBe(1551);
    // NOT '0'. A zero here is what renders a stop priced at nothing in the UI;
    // the empty string is the same "absent" sentinel a missing stopPrice uses,
    // and every reader parses it to unknown rather than to a real price.
    expect(cached.price).toBe('');
  });

  it('forwards intent.meta to persistOrder so strategy order metadata lands in orders.meta', async () => {
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => ({ orderId: 7, clientOrderId: 'client-1', status: 'NEW' })),
    } as unknown as Partial<BinanceRestClient>);
    const persistOrder = vi.fn(async () => undefined);
    const bindings = buildBindings({
      binance,
      persistence: {
        persistOrder: persistOrder as unknown as ProfilePersistence['persistOrder'],
      },
    });
    const deps = buildDeps(bindings);

    const withMeta: Extract<Decision, { type: 'place-order' }> = {
      ...PLACE,
      intent: { ...PLACE.intent, meta: { gridTradeIndex: 3 } },
    };
    const out = await placeOrderHandler(deps, CTX, withMeta);

    expect(out).toEqual({ ok: true });
    expect(persistOrder).toHaveBeenCalledWith(
      expect.objectContaining({ meta: { gridTradeIndex: 3 } }),
      { closePrevious: true },
    );
  });

  it('omits meta from persistOrder when the intent carries none', async () => {
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => ({ orderId: 8, clientOrderId: 'client-1', status: 'NEW' })),
    } as unknown as Partial<BinanceRestClient>);
    const persistOrder = vi.fn(async () => undefined);
    const bindings = buildBindings({
      binance,
      persistence: {
        persistOrder: persistOrder as unknown as ProfilePersistence['persistOrder'],
      },
    });
    const deps = buildDeps(bindings);

    await placeOrderHandler(deps, CTX, PLACE);

    const arg = persistOrder.mock.calls[0]?.[0] as { meta?: unknown } | undefined;
    expect(arg).toBeDefined();
    expect(arg && 'meta' in arg).toBe(false);
  });

  it('-1021 is classified non-retryable and does NOT loop at the place-order level', async () => {
    // -1021 recovery (server-time resync + one retry) now lives in the binance
    // client's call(). A -1021 that surfaces here is a persistent host-clock
    // skew, so place-order classifies it non-retryable and calls placeOrder once.
    const placeOrder = vi.fn(async () => {
      throw new BinanceApiError({ status: 400, code: -1021, message: 'recvWindow drift' });
    });
    const binance = fakeBinance({ placeOrder } as unknown as Partial<BinanceRestClient>);
    const bindings = buildBindings({ binance });
    const deps = buildDeps(bindings);

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.retryable).toBe(false);
    expect(placeOrder).toHaveBeenCalledOnce();
  });

  it('illegal-value (-1100..-1199) emergency code fires an emergency-notify to Slack', async () => {
    const placeOrder = vi.fn(async () => {
      throw new BinanceApiError({
        status: 400,
        code: -1102,
        message: 'mandatory parameter missing',
      });
    });
    const binance = fakeBinance({ placeOrder } as unknown as Partial<BinanceRestClient>);
    // The profile's real Slack row: visible config + write-once secret. Emergency
    // notify must deliver the MERGED config (secret webhook included), not `{}`.
    const bindings = buildBindings({
      binance,
      persistence: {
        listEnabledNotifiers: vi.fn(async () => [
          {
            provider: 'slack',
            config: { channel: '#alerts' },
            secrets: { webhookUrl: 'https://hooks.slack.com/services/T/B/C' },
            enabled: true,
          },
        ]),
      },
    });
    const provider: AnyNotifyProvider = {
      name: 'slack',
      send: vi.fn(async () => undefined),
    } as unknown as AnyNotifyProvider;
    const registry: Partial<NotifyProviderRegistry> = {
      get: (n) => (n === 'slack' ? provider : undefined),
      list: () => [provider],
    };
    const deps: DecisionDeps = {
      ...buildDeps(bindings),
      notifyRegistry: registry as NotifyProviderRegistry,
    };

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.retryable).toBe(false);
    expect(provider.send).toHaveBeenCalledOnce();
    // The real webhook (from secrets) reaches the provider — the blank-URL bug.
    expect((provider.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      config: { webhookUrl: 'https://hooks.slack.com/services/T/B/C', channel: '#alerts' },
    });
  });

  it('logic-error -2010 is non-retryable and does NOT fire emergency notify', async () => {
    const cause = new BinanceApiError(
      {
        status: 400,
        code: -2010,
        msg: 'Account has insufficient balance for requested action.',
      },
      false,
      'rejected',
    );
    const placeOrder = vi.fn(async () => {
      throw cause;
    });
    const binance = fakeBinance({ placeOrder } as unknown as Partial<BinanceRestClient>);
    const bindings = buildBindings({ binance });
    const provider: AnyNotifyProvider = {
      name: 'slack',
      send: vi.fn(async () => undefined),
    } as unknown as AnyNotifyProvider;
    const registry: Partial<NotifyProviderRegistry> = {
      get: (n) => (n === 'slack' ? provider : undefined),
      list: () => [provider],
    };
    const deps: DecisionDeps = {
      ...buildDeps(bindings),
      notifyRegistry: registry as NotifyProviderRegistry,
    };

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.retryable).toBe(false);
      expect(out.cause).toBe(cause);
    }
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('-2010 on a SELL enqueues a reconcile and STILL stays non-retryable', async () => {
    // Binance refusing a SELL for want of balance is the loudest possible signal
    // that the position was already sold and the fill never reached the stream.
    // Repair the state — but do NOT make the order retryable: a SELL retrying
    // against a balance that is not coming back loops forever.
    const placeOrder = vi.fn(async () => {
      throw new BinanceApiError({
        status: 400,
        code: -2010,
        message: 'Account has insufficient balance for requested action.',
      });
    });
    const binance = fakeBinance({ placeOrder } as unknown as Partial<BinanceRestClient>);
    const sell = { ...PLACE, intent: { ...PLACE.intent, side: 'SELL' as const } };
    // Control: the same rejection with no reconcile seam wired. The verdict must
    // be byte-identical with and without it — the reconcile repairs state, it does
    // not re-classify the order.
    const control = await placeOrderHandler(buildDeps(buildBindings({ binance })), CTX, sell);
    const enqueueSymbolReconcile = vi.fn();
    const deps: DecisionDeps = {
      ...buildDeps(buildBindings({ binance })),
      enqueueSymbolReconcile,
    };

    const out = await placeOrderHandler(deps, CTX, sell);

    expect(out).toEqual(control);
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.retryable).toBe(false);
      expect(out.reason).toContain('-2010');
    }
    expect(enqueueSymbolReconcile).toHaveBeenCalledTimes(1);
    expect(enqueueSymbolReconcile).toHaveBeenCalledWith({
      profileId: PROFILE,
      symbol: 'BTCUSDT',
      cause: 'place-2010-insufficient',
    });
  });

  it('a -2010 that means "symbol not permitted" enqueues NO reconcile, even on a SELL', async () => {
    // -2010 is an umbrella code. The reconcile above is worth its getAccount +
    // getMyTrades only when the refusal implies a balance the stream missed. A
    // permission refusal implies nothing about the position and never clears,
    // so reconciling on it just spends weight on every tick, forever.
    const placeOrder = vi.fn(async () => {
      throw new BinanceApiError(
        {
          status: 400,
          code: -2010,
          msg: 'This symbol is not permitted for this account.',
        },
        false,
        'rejected',
      );
    });
    const binance = fakeBinance({ placeOrder } as unknown as Partial<BinanceRestClient>);
    const sell = { ...PLACE, intent: { ...PLACE.intent, side: 'SELL' as const } };
    const enqueueSymbolReconcile = vi.fn();
    const deps: DecisionDeps = {
      ...buildDeps(buildBindings({ binance })),
      enqueueSymbolReconcile,
    };

    const out = await placeOrderHandler(deps, CTX, sell);

    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.retryable).toBe(false);
    expect(enqueueSymbolReconcile).not.toHaveBeenCalled();
  });

  it('-2010 on a BUY enqueues nothing: a short quote balance says nothing about the position', async () => {
    const placeOrder = vi.fn(async () => {
      throw new BinanceApiError({
        status: 400,
        code: -2010,
        message: 'Account has insufficient balance for requested action.',
      });
    });
    const binance = fakeBinance({ placeOrder } as unknown as Partial<BinanceRestClient>);
    const enqueueSymbolReconcile = vi.fn();
    const deps: DecisionDeps = {
      ...buildDeps(buildBindings({ binance })),
      enqueueSymbolReconcile,
    };

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out.ok).toBe(false);
    expect(enqueueSymbolReconcile).not.toHaveBeenCalled();
  });

  it('binance-emergency on a profile with no enabled notifiers writes a gap action_log', async () => {
    const placeOrder = vi.fn(async () => {
      throw new BinanceApiError({
        status: 400,
        code: -1102,
        message: 'mandatory parameter missing',
      });
    });
    const binance = fakeBinance({ placeOrder } as unknown as Partial<BinanceRestClient>);
    const recordNotifierGap = vi.fn(async () => undefined);
    const bindings = buildBindings({
      binance,
      persistence: {
        listEnabledNotifiers: vi.fn(async () => []),
        recordNotifierGap,
      },
    });
    const deps = buildDeps(bindings);

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out.ok).toBe(false);
    expect(recordNotifierGap).toHaveBeenCalledOnce();
    expect(recordNotifierGap.mock.calls[0]?.[0]).toMatchObject({
      topic: 'binance-emergency',
      symbol: 'BTCUSDT',
    });
  });

  it('throttle suppresses a second gap action_log within the window for the same topic', async () => {
    const placeOrder = vi.fn(async () => {
      throw new BinanceApiError({
        status: 400,
        code: -1102,
        message: 'mandatory parameter missing',
      });
    });
    const binance = fakeBinance({ placeOrder } as unknown as Partial<BinanceRestClient>);
    const recordNotifierGap = vi.fn(async () => undefined);
    const bindings = buildBindings({
      binance,
      persistence: {
        listEnabledNotifiers: vi.fn(async () => []),
        recordNotifierGap,
      },
    });
    // First call allowed, second within the window suppressed.
    const allow = vi
      .fn<(key: string) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const deps: DecisionDeps = { ...buildDeps(bindings), notifierGapThrottle: { allow } };

    await placeOrderHandler(deps, CTX, PLACE);
    await placeOrderHandler(deps, CTX, PLACE);

    expect(recordNotifierGap).toHaveBeenCalledOnce();
    expect(allow).toHaveBeenCalledTimes(2);
    expect(allow.mock.calls[0]?.[0]).toBe(`${PROFILE}:binance-emergency`);
  });

  it('binance-emergency with enabled notifiers does NOT write a gap action_log', async () => {
    const placeOrder = vi.fn(async () => {
      throw new BinanceApiError({
        status: 400,
        code: -1102,
        message: 'mandatory parameter missing',
      });
    });
    const binance = fakeBinance({ placeOrder } as unknown as Partial<BinanceRestClient>);
    const recordNotifierGap = vi.fn(async () => undefined);
    const provider: AnyNotifyProvider = {
      name: 'slack',
      send: vi.fn(async () => undefined),
    } as unknown as AnyNotifyProvider;
    const registry: Partial<NotifyProviderRegistry> = {
      get: (n) => (n === 'slack' ? provider : undefined),
      list: () => [provider],
    };
    const bindings = buildBindings({
      binance,
      persistence: {
        listEnabledNotifiers: vi.fn(async () => [ENABLED_SLACK_ROW]),
        recordNotifierGap,
      },
    });
    const deps: DecisionDeps = {
      ...buildDeps(bindings),
      notifyRegistry: registry as NotifyProviderRegistry,
    };

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out.ok).toBe(false);
    expect(recordNotifierGap).not.toHaveBeenCalled();
  });

  it('records a gap when an enabled notifier resolves to an unregistered provider (no silent failure)', async () => {
    const placeOrder = vi.fn(async () => {
      throw new BinanceApiError({
        status: 400,
        code: -1102,
        message: 'mandatory parameter missing',
      });
    });
    const binance = fakeBinance({ placeOrder } as unknown as Partial<BinanceRestClient>);
    const recordNotifierGap = vi.fn(async () => undefined);
    const bindings = buildBindings({
      binance,
      persistence: {
        // Enabled row for a provider the worker registry does not know.
        listEnabledNotifiers: vi.fn(async () => [
          { provider: 'telegram', config: {}, secrets: {}, enabled: true },
        ]),
        recordNotifierGap,
      },
    });
    // Base deps registry: get() => undefined, so nothing can dispatch.
    const deps = buildDeps(bindings);

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out.ok).toBe(false);
    // Nothing delivered → the gap trace must still fire.
    expect(recordNotifierGap).toHaveBeenCalledOnce();
    expect(recordNotifierGap.mock.calls[0]?.[0]).toMatchObject({ topic: 'binance-emergency' });
  });

  it('fans out to every registered notifier even when one provider send throws', async () => {
    const placeOrder = vi.fn(async () => {
      throw new BinanceApiError({
        status: 400,
        code: -1102,
        message: 'mandatory parameter missing',
      });
    });
    const binance = fakeBinance({ placeOrder } as unknown as Partial<BinanceRestClient>);
    const slack: AnyNotifyProvider = {
      name: 'slack',
      send: vi.fn(async () => {
        throw new Error('webhook down');
      }),
    } as unknown as AnyNotifyProvider;
    const telegram: AnyNotifyProvider = {
      name: 'telegram',
      send: vi.fn(async () => undefined),
    } as unknown as AnyNotifyProvider;
    const registry: Partial<NotifyProviderRegistry> = {
      get: (n) => (n === 'slack' ? slack : n === 'telegram' ? telegram : undefined),
      list: () => [slack, telegram],
    };
    const recordNotifierGap = vi.fn(async () => undefined);
    const bindings = buildBindings({
      binance,
      persistence: {
        listEnabledNotifiers: vi.fn(async () => [
          { provider: 'slack', config: {}, secrets: {}, enabled: true },
          { provider: 'telegram', config: {}, secrets: {}, enabled: true },
        ]),
        recordNotifierGap,
      },
    });
    const deps: DecisionDeps = {
      ...buildDeps(bindings),
      notifyRegistry: registry as NotifyProviderRegistry,
    };

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out.ok).toBe(false);
    // safeNotify swallows slack's throw, so telegram is still attempted.
    expect(slack.send).toHaveBeenCalledOnce();
    expect(telegram.send).toHaveBeenCalledOnce();
    // At least one dispatch happened → no gap.
    expect(recordNotifierGap).not.toHaveBeenCalled();
  });

  // The pre-flight is a GUARD, not a gate. When it cannot read the wallet it must
  // stand down and let the order through — a wallet it cannot read is not a wallet
  // that cannot pay, and blocking every order on a Redis blip would halt trading.
  it('fails OPEN when the account-snapshot read rejects: the order still goes to Binance', async () => {
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => ({ orderId: 5, clientOrderId: 'c', status: 'NEW' })),
    } as unknown as Partial<BinanceRestClient>);
    const redis = fakeRedis();
    (redis.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
      if (key.includes('accountInfo')) throw new Error('redis down');
      return null;
    });
    const deps: DecisionDeps = {
      ...buildDeps(buildBindings({ binance }), redis),
      accountId: ACCOUNT,
    };

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out).toEqual({ ok: true });
    expect(binance.placeOrder).toHaveBeenCalledOnce();
  });

  it('fails OPEN when the snapshot read never settles: the 500ms deadline releases the order', async () => {
    vi.useFakeTimers();
    try {
      const binance = fakeBinance({
        placeOrder: vi.fn(async () => ({ orderId: 6, clientOrderId: 'c', status: 'NEW' })),
      } as unknown as Partial<BinanceRestClient>);
      const redis = fakeRedis();
      (redis.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) =>
        key.includes('accountInfo') ? new Promise(() => undefined) : null,
      );
      const deps: DecisionDeps = {
        ...buildDeps(buildBindings({ binance }), redis),
        accountId: ACCOUNT,
      };

      const pending = placeOrderHandler(deps, CTX, PLACE);
      await vi.advanceTimersByTimeAsync(600);
      const out = await pending;

      // A stalled Redis delays the money path by the deadline and no longer.
      expect(out).toEqual({ ok: true });
      expect(binance.placeOrder).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unfundable SELL is blocked at pre-flight: Binance is never called and the operator is told once', async () => {
    // The -2010 storm. A deleted profile left its protective stops resting on
    // Binance; the operator adopted those orphans into this profile, so the whole
    // ENA position is LOCKED by them (free 0.00, locked 189.87). Momentum sizes its
    // own stop from the wallet total, fires it, Binance rejects it as insufficient
    // balance — and nothing stops the next tick from firing the identical order
    // again: ~215k rejected placements in 3 days. The wallet is readable BEFORE the
    // call, so an order the wallet cannot fund must never reach the wire, and the
    // operator must hear about it once, not once per tick.
    //
    // The double answers exactly as Binance did in the storm — if the order reaches
    // the wire it is rejected with -2010.
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => {
        throw new BinanceApiError({
          status: 400,
          code: -2010,
          message: 'Account has insufficient balance for requested action.',
        });
      }),
    } as unknown as Partial<BinanceRestClient>);
    const bindings = {
      ...buildBindings({ binance }),
      // The base asset a SELL spends is derived from the profile's quote asset:
      // ENAUSDT minus USDT ⇒ ENA. (Bindings must carry it for the pre-flight.)
      quoteAsset: 'USDT',
    } as ProfileExecutorBindings;

    // The `account-info` key exactly as `parseAccountSnapshot` reads it.
    const accountInfo = JSON.stringify({
      balances: {
        ENA: { free: '0.00000000', locked: '189.87000000' },
        USDT: { free: '120.00000000', locked: '0.00000000' },
      },
    });
    const redis = fakeRedis();
    (redis.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) =>
      key === buildAccountInfoKey(ACCOUNT, PROFILE) ? accountInfo : null,
    );

    const provider: AnyNotifyProvider = {
      name: 'slack',
      send: vi.fn(async () => undefined),
    } as unknown as AnyNotifyProvider;
    const registry: Partial<NotifyProviderRegistry> = {
      get: (n) => (n === 'slack' ? provider : undefined),
      list: () => [provider],
    };
    const deps: DecisionDeps = {
      ...buildDeps(bindings, redis),
      accountId: ACCOUNT,
      notifyRegistry: registry as NotifyProviderRegistry,
    };

    const unfundableStop: Extract<Decision, { type: 'place-order' }> = {
      type: 'place-order',
      intent: {
        symbol: 'ENAUSDT',
        side: 'SELL',
        reason: 'protective-stop',
        clientOrderId: 'ena-protective-stop',
      },
      params: {
        type: 'STOP_LOSS_LIMIT',
        quantity: '189.87',
        stopPrice: '0.2800',
        price: '0.2772',
      },
    };

    const out = await placeOrderHandler(deps, CTX, unfundableStop);

    // The money assertion: free ENA is 0, so this order cannot fill — it must not
    // be transmitted at all. Every rejected placement in the storm crossed this line.
    expect(binance.placeOrder).not.toHaveBeenCalled();

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      // Nothing was sent, so nothing can be live: `pre-call` is what lets an
      // override settle re-arm safely. Non-retryable because retrying an order the
      // wallet still cannot fund is precisely the storm.
      expect(out.phase).toBe('pre-call');
      expect(out.retryable).toBe(false);
      expect(out.reason).toMatch(/unfundable|insufficient|shortfall/i);
    }

    // Told once — the loop is broken, not narrated 215,000 times.
    expect(provider.send).toHaveBeenCalledOnce();
    expect((provider.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      message: { symbol: 'ENAUSDT' },
    });
  });
});

// A transport-level throw (socket reset, timeout) is the ONLY way into
// `resolveAmbiguousPlacement`: the response never arrived, so the order may or may
// not be live. Every assertion below is a money assertion — the two ways to get
// this wrong are a DUPLICATE live order and a SILENTLY MISSING protective stop.
describe('placeOrderHandler — a placement whose response was lost', () => {
  const SENT_AT = 1_700_000_000_000;
  // recvWindow (5s) + the 1s clock-skew margin: the instant after which Binance can
  // no longer admit the placement, and so the instant a -2013 becomes conclusive.
  const ADMISSION_CLOSES_AT = SENT_AT + 6_000;

  const mkClock = (start: number) => {
    let t = start;
    return { nowMs: () => t, advance: (ms: number) => (t += ms) };
  };

  const probedOrder = (over: Record<string, unknown> = {}) =>
    ({
      symbol: 'BTCUSDT',
      orderId: 4242,
      clientOrderId: 'client-1',
      side: 'BUY',
      type: 'MARKET',
      price: '0',
      origQty: '0.001',
      executedQty: '0.001',
      status: 'FILLED',
      stopPrice: '',
      time: SENT_AT + 600, // created AFTER we sent ⇒ provably this attempt's order
      updateTime: SENT_AT + 600,
      cummulativeQuoteQty: '60',
      ...over,
    }) as never;

  const notExist = () =>
    new BinanceApiError(
      { status: 400, code: -2013, msg: 'Order does not exist.' } as never,
      false,
      'rejected',
    );

  /** Deps whose clock the test drives, and whose `sleep` records + advances it. */
  const buildTimedDeps = (bindings: ProfileExecutorBindings, clock: ReturnType<typeof mkClock>) => {
    const slept: number[] = [];
    const deps: DecisionDeps = {
      ...buildDeps(bindings),
      clock,
      sleep: async (ms: number) => {
        slept.push(ms);
        clock.advance(ms);
      },
    };
    return { deps, slept };
  };

  it('an exhausted ORDERS budget is a pre-call refusal, never an ambiguity probe', async () => {
    // The governor refuses BEFORE the request is signed, so no order can exist.
    // The `getOrder` assertion is the real subject: it fails the moment the
    // generic transport branch wins the ordering, which would probe Binance for
    // an order that was never sent and resolve it as `ambiguous` — the one
    // verdict that is deliberately never retried.
    const clock = mkClock(SENT_AT);
    const binance = fakeBinance({
      placeOrder: vi.fn(() => Promise.reject(new OrderBudgetUnavailableError(86_400_000, 90_000))),
      getOrder: vi.fn(async () => probedOrder()),
    });
    const { deps } = buildTimedDeps(buildBindings({ binance }), clock);

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.phase).toBe('pre-call');
      // Retryable: the window decays, so the next tick re-emits the intent.
      expect(out.retryable).toBe(true);
      expect(out.reason).toContain('order-budget-exhausted');
      // PLACE is not deferrable — an entry that never went out leaves the
      // operator with a trade they think they have, so it must still alert.
      expect(out.deferred).toBeUndefined();
    }
    expect(binance.getOrder).not.toHaveBeenCalled();
  });

  it('a DEFERRABLE order refused by the budget is marked deferred, so it alerts no differently than a shed', async () => {
    // The executor peeks at the budget before the batch and sheds silently when
    // it is empty. This is the same condition reached the other way: the peek
    // passed, a sibling profile on the same account took the slot, and the
    // reservation gave up. Identical cause, identical operator impact — so if
    // this arrives unmarked, the suppression the shed exists for turns into a
    // coin flip on thread timing.
    const clock = mkClock(SENT_AT);
    const binance = fakeBinance({
      placeOrder: vi.fn(() => Promise.reject(new OrderBudgetUnavailableError(10_000, 61_000))),
    });
    const { deps } = buildTimedDeps(buildBindings({ binance }), clock);

    const out = await placeOrderHandler(deps, CTX, {
      ...PLACE,
      intent: { ...PLACE.intent, deferrable: true },
    });

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.deferred).toBe(true);
      // Still a failure, not a success: state stays un-advanced so the next
      // tick re-emits the intent.
      expect(out.retryable).toBe(true);
      expect(out.phase).toBe('pre-call');
    }
  });

  it('probe finds THIS attempt’s order: records it with the REAL orderId and its REAL status, and refuses to re-issue', async () => {
    const clock = mkClock(SENT_AT);
    const persistTrackingOrder = vi.fn(async () => undefined);
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => {
        clock.advance(300);
        throw new Error('socket hang up');
      }),
      getOrder: vi.fn(async () => probedOrder()),
    });
    const bindings = buildBindings({
      binance,
      persistence: {
        persistTrackingOrder:
          persistTrackingOrder as unknown as ProfilePersistence['persistTrackingOrder'],
      },
    });
    const { deps } = buildTimedDeps(bindings, clock);

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      // The order is on the exchange. `accepted` is what forbids a re-issue.
      expect(out.phase).toBe('accepted');
      expect(out.retryable).toBe(false);
    }
    // The Binance id is the only handle the user-data stream can reconcile by, and
    // the status must be the exchange's, not a hardcoded NEW: a probed MARKET order
    // is already FILLED, and a FILLED row written as still-open would hold the live
    // slot and be stamped CANCELED by the next order.
    expect(persistTrackingOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        binanceOrderId: 4242n,
        status: 'FILLED',
        clientOrderId: 'client-1',
      }),
    );
  });

  it('records the dedup when the probe proves a lost-response MARKET order landed (the highest-risk double-fill guard)', async () => {
    const clock = mkClock(SENT_AT);
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => {
        clock.advance(300);
        throw new Error('socket hang up');
      }),
      getOrder: vi.fn(async () => probedOrder()), // provably-ours FILLED MARKET order
    });
    const bindings = buildBindings({ binance });
    const dedup = createPlacementDedup();
    const { deps } = buildTimedDeps(bindings, clock);
    const timedDeps: DecisionDeps = { ...deps, placementDedup: dedup };

    const out = await placeOrderHandler(timedDeps, CTX, PLACE);

    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.phase).toBe('accepted');
    // The lost-response MARKET order is on the exchange; without recording its
    // clientOrderId a read-your-writes re-emit next tick would double-fill it. This
    // fails if the record call in resolveAmbiguousPlacement is removed.
    expect(await dedup.seenRecently(PLACE.intent.clientOrderId, `acc:BTCUSDT`, clock.nowMs())).toBe(
      true,
    );
  });

  it('a -2013 AFTER the admission window has closed is conclusive: rejected + retryable, no wait', async () => {
    const clock = mkClock(SENT_AT);
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => {
        clock.advance(7_000); // a slow timeout: the window is long gone
        throw new Error('ETIMEDOUT');
      }),
      getOrder: vi.fn(async () => {
        throw notExist();
      }),
    });
    const { deps, slept } = buildTimedDeps(buildBindings({ binance }), clock);

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      // Binance can no longer admit the placement and has never seen it ⇒ it never
      // landed ⇒ safe to re-issue.
      expect(out.phase).toBe('rejected');
      expect(out.retryable).toBe(true);
    }
    expect(slept).toEqual([]); // nothing left to wait out
    expect(binance.getOrder).toHaveBeenCalledOnce();
  });

  it('a -2013 BEFORE the window closes is NOT conclusive: it waits out the window and re-probes', async () => {
    // THE duplicate-order bug. The socket died at t+300ms but Binance will still
    // admit the request until t+5s; a -2013 here means "not landed YET". Believing
    // it would leave the state un-advanced, the next tick would re-place, and for a
    // MARKET order the original FILLS first — which frees the clientOrderId, so the
    // duplicate is accepted. Two positions.
    const clock = mkClock(SENT_AT);
    const getOrder = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw notExist(); // t+300ms: not there yet
      })
      .mockImplementationOnce(async () => probedOrder()); // after the wait: it landed
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => {
        clock.advance(300);
        throw new Error('ECONNRESET');
      }),
      getOrder,
    });
    const { deps, slept } = buildTimedDeps(buildBindings({ binance }), clock);

    const out = await placeOrderHandler(deps, CTX, PLACE);

    // It waited out exactly the remainder of the window...
    expect(slept).toEqual([ADMISSION_CLOSES_AT - (SENT_AT + 300)]);
    expect(getOrder).toHaveBeenCalledTimes(2);
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      // ...and never called it rejected: the order was live all along.
      expect(out.phase).toBe('accepted');
      expect(out.retryable).toBe(false);
    }
  });

  it('a -2013 that survives the wait IS conclusive: rejected + retryable', async () => {
    const clock = mkClock(SENT_AT);
    const getOrder = vi.fn(async () => {
      throw notExist();
    });
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => {
        clock.advance(300);
        throw new Error('ECONNRESET');
      }),
      getOrder,
    });
    const { deps, slept } = buildTimedDeps(buildBindings({ binance }), clock);

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(slept).toEqual([5_700]);
    expect(getOrder).toHaveBeenCalledTimes(2);
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.phase).toBe('rejected');
      expect(out.retryable).toBe(true);
    }
  });

  it('a probe that matches an OLDER order sharing the clientOrderId proves NOTHING: ambiguous, never accepted', async () => {
    // Momentum re-uses one stable clientOrderId per (profile, symbol) for its
    // protective stop across every cancel-and-re-arm, and Binance only guarantees
    // uniqueness among OPEN orders — so the probe can return a long-dead namesake.
    // Calling that `accepted` would say "the stop is live, never re-issue it" and
    // leave the position running UNGUARDED, forever.
    const clock = mkClock(SENT_AT);
    const persistTrackingOrder = vi.fn(async () => undefined);
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => {
        clock.advance(300);
        throw new Error('socket hang up');
      }),
      getOrder: vi.fn(async () =>
        probedOrder({ orderId: 11, status: 'CANCELED', time: SENT_AT - 60_000 }),
      ),
    });
    const bindings = buildBindings({
      binance,
      persistence: {
        persistTrackingOrder:
          persistTrackingOrder as unknown as ProfilePersistence['persistTrackingOrder'],
      },
    });
    const { deps } = buildTimedDeps(bindings, clock);

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.phase).toBe('ambiguous');
    // Nothing was proven, so nothing is recorded: writing the stale order's row
    // would claim a stop we do not have.
    expect(persistTrackingOrder).not.toHaveBeenCalled();
  });

  it('a probe that itself fails stays ambiguous — and ambiguous is NEVER retried', async () => {
    const clock = mkClock(SENT_AT);
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => {
        throw new Error('socket hang up');
      }),
      getOrder: vi.fn(async () => {
        throw new Error('binance unreachable');
      }),
    });
    const { deps } = buildTimedDeps(buildBindings({ binance }), clock);

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.phase).toBe('ambiguous');
      // The money assertion: the order may be LIVE, so nothing may re-issue it —
      // whatever `retryable` says, the phase forbids the retry.
      expect(isOrderRetriable(out)).toBe(false);
    }
  });

  it('a failing persistTrackingOrder cannot change the verdict — the order is still live', async () => {
    const clock = mkClock(SENT_AT);
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => {
        clock.advance(300);
        throw new Error('socket hang up');
      }),
      getOrder: vi.fn(async () => probedOrder()),
    });
    const bindings = buildBindings({
      binance,
      persistence: {
        persistTrackingOrder: (async () => {
          throw new Error('pg down');
        }) as unknown as ProfilePersistence['persistTrackingOrder'],
      },
    });
    const { deps } = buildTimedDeps(bindings, clock);

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.phase).toBe('accepted');
      expect(out.retryable).toBe(false);
    }
  });
  // The client signs AFTER the shared weight governor admits the call, and reports
  // that instant on the thrown error. These two cases are what that plumbing buys.
  it('anchors the wait to the SIGNED instant, not our pre-call reading (a governor-delayed placement)', async () => {
    // The governor held the placement 4s against the shared weight bucket, so
    // Binance's 5s admission window starts 4s after we called. Anchoring to our own
    // pre-call reading would end the wait while the request is STILL ADMISSIBLE, the
    // re-probe would return -2013, we would declare it never landed, and the retry
    // would duplicate a live order.
    const clock = mkClock(SENT_AT);
    const getOrder = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw notExist();
      })
      .mockImplementationOnce(async () => probedOrder({ time: SENT_AT + 4_500 }));
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => {
        clock.advance(4_000); // governor admission wait
        const signedAtLocalMs = clock.nowMs();
        clock.advance(300); // …then the socket dies
        throw Object.assign(new Error('ECONNRESET'), {
          binanceSignedAtLocalMs: signedAtLocalMs,
          binanceTimeOffsetMs: 0,
        });
      }),
      getOrder,
    });
    const { deps, slept } = buildTimedDeps(buildBindings({ binance }), clock);

    const out = await placeOrderHandler(deps, CTX, PLACE);

    // Window closes at signedAt(+4000) + 5000 + 1000 margin; we are at +4300.
    expect(slept).toEqual([5_700]);
    expect(getOrder).toHaveBeenCalledTimes(2);
    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.phase).toBe('accepted'); // never `rejected`
  });

  it('judges the probe’s identity on BINANCE’s clock — a namesake inside the skew window is NOT ours', async () => {
    // Our host runs 2s BEHIND Binance (timeOffsetMs = +2000). A stale namesake from
    // an earlier re-arm, created 1.5s (Binance time) before our send, still has
    // `time > sentAtMs` on OUR clock. Accepting it would say "the stop is live, never
    // re-issue" and leave the position unguarded forever.
    const clock = mkClock(SENT_AT);
    const persistTrackingOrder = vi.fn(async () => undefined);
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => {
        const signedAtLocalMs = clock.nowMs();
        clock.advance(300);
        throw Object.assign(new Error('socket hang up'), {
          binanceSignedAtLocalMs: signedAtLocalMs,
          binanceTimeOffsetMs: 2_000,
        });
      }),
      // sentAtBinance = SENT_AT + 2000; this order predates it by 1.5s.
      getOrder: vi.fn(async () =>
        probedOrder({ orderId: 11, status: 'CANCELED', time: SENT_AT + 500 }),
      ),
    });
    const bindings = buildBindings({
      binance,
      persistence: {
        persistTrackingOrder:
          persistTrackingOrder as unknown as ProfilePersistence['persistTrackingOrder'],
      },
    });
    const { deps } = buildTimedDeps(bindings, clock);

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.phase).toBe('ambiguous');
    expect(persistTrackingOrder).not.toHaveBeenCalled();
  });
});
