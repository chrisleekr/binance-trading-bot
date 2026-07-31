import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import { BinanceApiError, type BinanceRestClient } from '@app/binance';
import type { NotifyProviderRegistry } from '@app/notify';
import type { Decision, ExecutorContext } from '@app/strategy-core';
import { asProfileId, asUserId } from '@app/contracts';

import { cancelOrderHandler } from '../../../src/executor/decisions/cancel-order.js';
import type { DecisionDeps } from '../../../src/executor/decisions/_types.js';
import { createCancelLedger } from '../../../src/executor/cancel-ledger.js';
import type { ProfileExecutorBindings } from '../../../src/executor/live-executor.js';
import type { ProfilePersistence } from '../../../src/profile-bindings/persistence.js';

const USER = asUserId('00000000-0000-0000-0000-0000000000aa');
const PROFILE = asProfileId('00000000-0000-0000-0000-0000000000bb');
const CTX: ExecutorContext = { userId: USER, profileId: PROFILE };

const CANCEL: Extract<Decision, { type: 'cancel-order' }> = {
  type: 'cancel-order',
  orderId: 42,
  reason: 'manual-cancel',
};

const fakeRedis = (): Redis =>
  ({
    del: vi.fn(async () => 0),
    set: vi.fn(async () => 'OK'),
    incr: vi.fn(async () => 1),
    // The open-orders cache eviction runs an atomic Lua EVAL; the mock resolves
    // it so a cancel's best-effort cache maintenance is a silent no-op here.
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

// Redis fake that captures the bodies published via `multi().publish(...)`, so
// a test can assert the emitted `orders` event carries the real status (the
// SPA-visible half of the -2011 fix).
const recordingRedis = (): { redis: Redis; published: string[] } => {
  const published: string[] = [];
  const redis = {
    del: vi.fn(async () => 0),
    set: vi.fn(async () => 'OK'),
    incr: vi.fn(async () => 1),
    eval: vi.fn(async () => null),
    multi: vi.fn(() => {
      const pipeline = {
        publish: vi.fn((_channel: string, body: string) => {
          published.push(body);
          return pipeline;
        }),
        xadd: vi.fn(() => pipeline),
        exec: vi.fn(async () => []),
      };
      return pipeline;
    }),
  } as unknown as Redis;
  return { redis, published };
};

const fakeBinance = (
  cancelImpl: BinanceRestClient['cancelOrder'],
  getOrderImpl?: BinanceRestClient['getOrder'],
): BinanceRestClient =>
  ({
    cancelOrder: cancelImpl,
    // Default throws so a test that unexpectedly reaches the -2011 query path
    // fails loudly instead of silently falling back.
    getOrder:
      getOrderImpl ??
      ((async () => {
        throw new Error('getOrder not stubbed');
      }) as unknown as BinanceRestClient['getOrder']),
    ctx: () => ({ weightUsed1m: 50, mode: 'live' as const }),
  }) as unknown as BinanceRestClient;

// A GET /api/v3/order DTO (OpenOrderDto shape) for the -2011 query path.
const orderDto = (
  over: Partial<{ status: string; executedQty: string; updateTime: number }> = {},
) =>
  ({
    symbol: 'BTCUSDT',
    orderId: 42,
    clientOrderId: 'tt-c-g',
    side: 'BUY',
    type: 'LIMIT',
    price: '0.4896',
    origQty: '30.9',
    executedQty: '0',
    status: 'CANCELED',
    stopPrice: '',
    time: 1,
    updateTime: 1_700_000_000_999,
    cummulativeQuoteQty: '0',
    ...over,
  }) as unknown as Awaited<ReturnType<BinanceRestClient['getOrder']>>;

const buildBindings = (
  overrides: Partial<Omit<ProfileExecutorBindings, 'persistence'>> & {
    persistence?: Partial<ProfilePersistence>;
  },
): ProfileExecutorBindings => {
  const { persistence: persistenceOverrides, ...rest } = overrides;
  return {
    mode: 'live',
    weightLimit1m: 1200,
    quoteAsset: 'USDT',
    ...rest,
    persistence: {
      persistOrder: vi.fn() as unknown as ProfilePersistence['persistOrder'],
      resolveOrderSlot: async () => ({ symbol: 'BTCUSDT', intent: 'grid-buy' }),
      persistTrackingOrder: vi.fn(async () => undefined),
      closeOrder: vi.fn(async () => undefined),
      recordBookkeepingFailure: vi.fn(async () => undefined),
      ...persistenceOverrides,
    },
  } as ProfileExecutorBindings;
};

const buildDeps = (bindings: ProfileExecutorBindings, redis: Redis = fakeRedis()): DecisionDeps => {
  const registry: Partial<NotifyProviderRegistry> = { get: () => undefined, list: () => [] };
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

describe('cancelOrderHandler', () => {
  it('marks the (symbol, intent) slot unresolved when the cancel fails, so a later place cannot close a live order', async () => {
    // The whole point: the order is STILL RESTING on Binance. A place on the same
    // slot must not be allowed to stamp its row CANCELED.
    const cancelOrder = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const bindings = buildBindings({ binance: fakeBinance(cancelOrder) });
    const ledger = createCancelLedger();
    const deps = { ...buildDeps(bindings), cancelLedger: ledger };

    const result = await cancelOrderHandler(deps, CTX, CANCEL);

    expect(result.ok).toBe(false);
    expect(ledger.hasUnresolved('BTCUSDT', 'grid-buy')).toBe(true);
    // A different slot on the same symbol is untouched.
    expect(ledger.hasUnresolved('BTCUSDT', 'stop-loss')).toBe(false);
  });

  it('fails the whole SYMBOL closed when the failed cancel had no local row to name its slot', async () => {
    // We cannot tell which slot is left holding a live order, so no place on this
    // symbol may close a predecessor.
    const cancelOrder = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const bindings = buildBindings({
      binance: fakeBinance(cancelOrder),
      persistence: { resolveOrderSlot: async () => null },
    });
    const ledger = createCancelLedger();
    // The decision itself carries the symbol, so the cancel is still attempted.
    await cancelOrderHandler({ ...buildDeps(bindings), cancelLedger: ledger }, CTX, {
      ...CANCEL,
      symbol: 'BTCUSDT',
    });

    expect(ledger.hasUnresolved('BTCUSDT', 'any-intent-at-all')).toBe(true);
  });

  it('leaves the ledger clean when the cancel succeeds', async () => {
    const cancelOrder = vi.fn().mockResolvedValue({ orderId: 42, status: 'CANCELED' });
    const bindings = buildBindings({ binance: fakeBinance(cancelOrder) });
    const ledger = createCancelLedger();

    await cancelOrderHandler({ ...buildDeps(bindings), cancelLedger: ledger }, CTX, CANCEL);

    expect(ledger.hasUnresolved('BTCUSDT', 'grid-buy')).toBe(false);
  });

  it('threads dto.transactTime through closeOrder so closed_at uses the exchange clock', async () => {
    const closeOrder = vi.fn(async () => undefined);
    const cancelOrder = vi
      .fn()
      .mockResolvedValue({ orderId: 42, status: 'CANCELED', transactTime: 1_700_000_000_111 });
    const bindings = buildBindings({
      binance: fakeBinance(cancelOrder),
      persistence: { closeOrder },
    });

    const result = await cancelOrderHandler(buildDeps(bindings), CTX, CANCEL);

    expect(result).toEqual({ ok: true });
    expect(closeOrder).toHaveBeenCalledWith(42, 'CANCELED', 1_700_000_000_111);
  });

  it('REMOVES the cancelled order from the open-orders cache by orderId, not DEL (E3)', async () => {
    // Issue #649 C1: a successful cancel drops just that order from the cached
    // list via the atomic Lua EVAL (op 'remove', orderId, TTL) so siblings need
    // no REST cold-load. Today cancel-order DELs the whole key. RED until Phase B.
    const cancelOrder = vi.fn().mockResolvedValue({ orderId: 42, status: 'CANCELED' });
    const bindings = buildBindings({ binance: fakeBinance(cancelOrder) });
    const redis = {
      del: vi.fn(async () => 0),
      set: vi.fn(async () => 'OK'),
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

    const result = await cancelOrderHandler(buildDeps(bindings, redis), CTX, CANCEL);

    expect(result).toEqual({ ok: true });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringMatching(/open-orders:BTCUSDT$/),
      'remove',
      '42',
      expect.anything(),
    );
    const delKeys = (redis.del as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(delKeys.some((k) => /open-orders/.test(k))).toBe(false);
  });

  const reject2011 = () =>
    vi
      .fn()
      .mockRejectedValue(
        new BinanceApiError({ status: 400, code: -2011, msg: 'Unknown order sent.' }, false),
      );

  it('on -2011 racing a FILL, records the row FILLED with the true executed quantity and raw', async () => {
    const closeOrder = vi.fn(async () => undefined);
    const dto = orderDto({ status: 'FILLED', executedQty: '30.9', updateTime: 1_700_000_000_999 });
    const getOrder = vi.fn(async () => dto);
    const bindings = buildBindings({
      binance: fakeBinance(reject2011(), getOrder),
      persistence: { closeOrder },
    });
    const { redis, published } = recordingRedis();

    const result = await cancelOrderHandler(buildDeps(bindings, redis), CTX, CANCEL);

    expect(result).toEqual({ ok: true });
    expect(getOrder).toHaveBeenCalledWith({ symbol: 'BTCUSDT', orderId: 42 });
    // FILLED status, exchange updateTime as closed_at, and the fresh DTO as raw.
    expect(closeOrder).toHaveBeenCalledWith(42, 'FILLED', 1_700_000_000_999, dto);
    // The emitted `orders` event must carry the real status, not a hardcoded
    // CANCELED — the SPA order history reads it.
    expect(published.some((b) => b.includes('"status":"FILLED"'))).toBe(true);
  });

  it('-2011 probe: a FILLED order with executedQty enqueues a symbol reconcile', async () => {
    // The probe is the ONLY place this fill is ever seen: the user stream missed
    // it, so the position (heldQuantity / entryPrice) is still stale. Closing the
    // order row is not enough — the fill must be handed to a durable reconcile
    // job. It cannot be adopted inline: the tick already holds
    // chain.run(`${profileId}:${symbol}`) and chainByKey is non-reentrant.
    const closeOrder = vi.fn(async () => undefined);
    const dto = orderDto({ status: 'FILLED', executedQty: '12.5', updateTime: 1_700_000_000_000 });
    const bindings = buildBindings({
      binance: fakeBinance(
        reject2011(),
        vi.fn(async () => dto),
      ),
      persistence: { closeOrder },
    });
    const enqueueSymbolReconcile = vi.fn();
    const deps = { ...buildDeps(bindings), enqueueSymbolReconcile } as DecisionDeps;

    const result = await cancelOrderHandler(deps, CTX, CANCEL);

    expect(result).toEqual({ ok: true });
    expect(closeOrder).toHaveBeenCalledWith(42, 'FILLED', 1_700_000_000_000, dto);
    expect(enqueueSymbolReconcile).toHaveBeenCalledTimes(1);
    expect(enqueueSymbolReconcile).toHaveBeenCalledWith({
      profileId: PROFILE,
      symbol: 'BTCUSDT',
      cause: 'cancel-2011-fill',
    });
  });

  it('-2011 probe: a FILLED order that executed NOTHING adopts nothing', async () => {
    // A zero executedQty moved no base quantity, so there is no fill to adopt and
    // no position to repair. Enqueueing anyway would burn a Binance round-trip per
    // cancel-vs-cancel race.
    const dto = orderDto({ status: 'FILLED', executedQty: '0' });
    const bindings = buildBindings({
      binance: fakeBinance(
        reject2011(),
        vi.fn(async () => dto),
      ),
    });
    const enqueueSymbolReconcile = vi.fn();
    const deps = { ...buildDeps(bindings), enqueueSymbolReconcile } as DecisionDeps;

    const result = await cancelOrderHandler(deps, CTX, CANCEL);

    expect(result).toEqual({ ok: true });
    expect(enqueueSymbolReconcile).not.toHaveBeenCalled();
  });

  it('-2011 probe: a failed reconcile enqueue still closes the row and still succeeds', async () => {
    // The reconcile REPAIRS state the exchange already changed; the cancel it
    // rides on is settled either way. Failing the cancel because the repair could
    // not be scheduled would re-run the whole cancel-replace chase on a Redis blip.
    const closeOrder = vi.fn(async () => undefined);
    const error = vi.fn();
    const dto = orderDto({ status: 'FILLED', executedQty: '12.5', updateTime: 1_700_000_000_999 });
    const bindings = buildBindings({
      binance: fakeBinance(
        reject2011(),
        vi.fn(async () => dto),
      ),
      persistence: { closeOrder },
    });
    const deps = {
      ...buildDeps(bindings),
      enqueueSymbolReconcile: vi.fn(async () => {
        throw new Error('redis down');
      }),
    } as DecisionDeps;
    (deps as { logger: { error: typeof error } }).logger = {
      error,
    } as unknown as DecisionDeps['logger'];

    const result = await cancelOrderHandler(deps, CTX, CANCEL);

    expect(result).toEqual({ ok: true });
    expect(closeOrder).toHaveBeenCalledWith(42, 'FILLED', 1_700_000_000_999, dto);
    expect(error).toHaveBeenCalledOnce();
  });

  it('on -2011 when the queried order is still non-terminal, keeps the CANCELED fallback', async () => {
    const closeOrder = vi.fn(async () => undefined);
    const warn = vi.fn();
    // PARTIALLY_FILLED is not terminal: closing the row would stamp closed_at on
    // a still-resting order, so the handler keeps the CANCELED fallback.
    const dto = orderDto({ status: 'PARTIALLY_FILLED', updateTime: 1_700_000_000_777 });
    const bindings = buildBindings({
      binance: fakeBinance(
        reject2011(),
        vi.fn(async () => dto),
      ),
      persistence: { closeOrder },
    });
    const enqueueSymbolReconcile = vi.fn();
    const deps = { ...buildDeps(bindings), enqueueSymbolReconcile } as DecisionDeps;
    (deps as { logger: { warn: typeof warn } }).logger = {
      warn,
    } as unknown as DecisionDeps['logger'];

    const result = await cancelOrderHandler(deps, CTX, CANCEL);

    expect(result).toEqual({ ok: true });
    expect(closeOrder).toHaveBeenCalledWith(42, 'CANCELED', 1_700_000_000_000, undefined);
    expect(warn).toHaveBeenCalledOnce();
    // A still-resting order has not moved anything: nothing to reconcile.
    expect(enqueueSymbolReconcile).not.toHaveBeenCalled();
  });

  it('on -2011 racing a concurrent CANCEL, records the row CANCELED from the query', async () => {
    const closeOrder = vi.fn(async () => undefined);
    const dto = orderDto({ status: 'CANCELED', executedQty: '0', updateTime: 1_700_000_000_888 });
    const bindings = buildBindings({
      binance: fakeBinance(
        reject2011(),
        vi.fn(async () => dto),
      ),
      persistence: { closeOrder },
    });
    const enqueueSymbolReconcile = vi.fn();
    const deps = { ...buildDeps(bindings), enqueueSymbolReconcile } as DecisionDeps;

    const result = await cancelOrderHandler(deps, CTX, CANCEL);

    expect(result).toEqual({ ok: true });
    expect(closeOrder).toHaveBeenCalledWith(42, 'CANCELED', 1_700_000_000_888, dto);
    expect(enqueueSymbolReconcile).not.toHaveBeenCalled();
  });

  it('on -2011 when the status query itself fails, falls back to CANCELED + injected clock and warns', async () => {
    const closeOrder = vi.fn(async () => undefined);
    const warn = vi.fn();
    const getOrder = vi.fn(async () => {
      throw new Error('binance down');
    });
    const bindings = buildBindings({
      binance: fakeBinance(reject2011(), getOrder as unknown as BinanceRestClient['getOrder']),
      persistence: { closeOrder },
    });
    const enqueueSymbolReconcile = vi.fn();
    const deps = { ...buildDeps(bindings), enqueueSymbolReconcile } as DecisionDeps;
    (deps as { logger: { warn: typeof warn } }).logger = {
      warn,
    } as unknown as DecisionDeps['logger'];

    const result = await cancelOrderHandler(deps, CTX, CANCEL);

    expect(result).toEqual({ ok: true });
    // No raw on the ambiguous fallback; injected-clock timestamp; CANCELED.
    expect(closeOrder).toHaveBeenCalledWith(42, 'CANCELED', 1_700_000_000_000, undefined);
    expect(warn).toHaveBeenCalledOnce();
    // The probe never established a fill, so nothing may be claimed as one.
    expect(enqueueSymbolReconcile).not.toHaveBeenCalled();
  });

  it('cancels via Binance when decision.symbol is present even with no local row', async () => {
    // The bookkeeping-crash case: the order is live on Binance but was never
    // persisted, so resolveOrderSlot misses. The decision carries the
    // symbol, so the cancel must still hit the exchange rather than refuse.
    const closeOrder = vi.fn(async () => undefined);
    const cancelOrder = vi
      .fn()
      .mockResolvedValue({ orderId: 42, status: 'CANCELED', transactTime: 1_700_000_000_222 });
    const bindings = buildBindings({
      binance: fakeBinance(cancelOrder),
      persistence: { closeOrder, resolveOrderSlot: async () => null },
    });

    const result = await cancelOrderHandler(buildDeps(bindings), CTX, {
      ...CANCEL,
      symbol: 'ETHUSDT',
    });

    expect(result).toEqual({ ok: true });
    expect(cancelOrder).toHaveBeenCalledWith({ symbol: 'ETHUSDT', orderId: 42 });
    expect(closeOrder).toHaveBeenCalledWith(42, 'CANCELED', 1_700_000_000_222);
  });

  it('prefers decision.symbol over the local lookup when both are present', async () => {
    const resolveOrderSlot = vi.fn(async () => ({ symbol: 'BTCUSDT', intent: 'grid-buy' }));
    const cancelOrder = vi
      .fn()
      .mockResolvedValue({ orderId: 42, status: 'CANCELED', transactTime: 1_700_000_000_333 });
    const bindings = buildBindings({
      binance: fakeBinance(cancelOrder),
      persistence: { resolveOrderSlot },
    });

    const result = await cancelOrderHandler(buildDeps(bindings), CTX, {
      ...CANCEL,
      symbol: 'ETHUSDT',
    });

    expect(result).toEqual({ ok: true });
    // decision.symbol wins for the CANCEL itself — the local row is never consulted
    // to decide what to cancel.
    expect(cancelOrder).toHaveBeenCalledWith({ symbol: 'ETHUSDT', orderId: 42 });
    // The row IS read once the cancel succeeds, and only then: a cleared cancel
    // hands its locked base back, and the batch's next order must be judged against
    // the wallet that release produces, not the stale snapshot. Sizing that credit
    // is the only thing this read is for.
    expect(resolveOrderSlot).toHaveBeenCalledOnce();
  });

  it('refuses only when symbol AND local row are both unknown', async () => {
    const closeOrder = vi.fn(async () => undefined);
    const cancelOrder = vi.fn();
    const bindings = buildBindings({
      binance: fakeBinance(cancelOrder),
      persistence: { closeOrder, resolveOrderSlot: async () => null },
    });

    // No decision.symbol AND resolveOrderSlot misses → refuse.
    const result = await cancelOrderHandler(buildDeps(bindings), CTX, CANCEL);

    expect(result).toEqual({
      ok: false,
      retryable: false,
      // Nothing was sent, so nothing can have executed.
      phase: 'pre-call',
      reason: 'order 42 not found locally',
    });
    expect(cancelOrder).not.toHaveBeenCalled();
    expect(closeOrder).not.toHaveBeenCalled();
  });
});
