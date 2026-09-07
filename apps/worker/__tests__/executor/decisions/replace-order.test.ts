import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import { BinanceApiError, OrderBudgetUnavailableError, type BinanceRestClient } from '@app/binance';
import type { NotifyProviderRegistry } from '@app/notify';
import { createRegistry, type Decision, type ExecutorContext } from '@app/strategy-core';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';

import { replaceOrderHandler } from '../../../src/executor/decisions/replace-order.js';
import type { DecisionDeps } from '../../../src/executor/decisions/_types.js';
import { createCancelLedger } from '../../../src/executor/cancel-ledger.js';
import { transitionOrderRefusal } from '../../../src/tick/order-refusal-circuit.js';
import type { ProfileExecutorBindings } from '../../../src/executor/live-executor.js';
import type { ProfilePersistence } from '../../../src/profile-bindings/persistence.js';

const USER = asUserId('00000000-0000-0000-0000-0000000000aa');
const PROFILE = asProfileId('00000000-0000-0000-0000-0000000000bb');
const ACCOUNT = asAccountId('00000000-0000-0000-0000-0000000000cc');
const CLOCK = { nowMs: () => 1_700_000_000_000 };
// Deliberately NOT the worker clock: a close stamped from the exchange's own record must be distinguishable from one stamped by the fallback.
const CANCEL_LEG_MS = 1_699_999_987_000;
const CTX: ExecutorContext = { userId: USER, profileId: PROFILE, clock: CLOCK };

const cancelReplaceOrderMock = (implementation: BinanceRestClient['cancelReplaceOrder']) =>
  vi.fn<BinanceRestClient['cancelReplaceOrder']>(implementation);
const placeOrderMock = (implementation: BinanceRestClient['placeOrder']) =>
  vi.fn<BinanceRestClient['placeOrder']>(implementation);

const REPLACE: Extract<Decision, { type: 'replace-order' }> = {
  type: 'replace-order',
  cancelOrderId: 42,
  reason: 'test-replace',
  intent: {
    symbol: 'BTCUSDT',
    side: 'SELL',
    reason: 'protective-stop',
    clientOrderId: 'client-2',
  },
  params: {
    type: 'STOP_LOSS_LIMIT',
    stopPrice: '95',
    price: '94.5',
    quantity: '0.001',
    timeInForce: 'GTC',
  },
};

// A fused position-closing SELL: the successor is a terminal MARKET whose intent reason differs from the cancelled leg's `protective-stop`. Neither the successor's intent nor its terminal status can reach the cancelled row's live slot, so `cancelOrderId` is the only key that closes it.
const FUSED_CLOSE: Extract<Decision, { type: 'replace-order' }> = {
  type: 'replace-order',
  cancelOrderId: 42,
  reason: 'tt-protective-stop-superseded',
  intent: {
    symbol: 'BTCUSDT',
    side: 'SELL',
    reason: 'grid-stop-loss',
    clientOrderId: 'client-exit',
  },
  params: { type: 'MARKET', quantity: '0.001' },
};

// Binance's cancel leg for a retired stop that had partially filled: the documented shape is a CANCELED status carrying the partial in `executedQty`, stamped with the exchange clock. The clock and the quantity are what prove the row was written from the exchange record rather than the worker clock, and neither is recoverable later — a partially-filled-then-cancelled order emits no FILLED execution report for the fill reconciler to pick up.
const CANCEL_LEG = {
  orderId: 42,
  status: 'CANCELED',
  transactTime: CANCEL_LEG_MS,
  executedQty: '0.0004',
} as const;

const filledSuccessor = (
  cancelResponse: unknown = CANCEL_LEG,
): Awaited<ReturnType<BinanceRestClient['cancelReplaceOrder']>> =>
  ({
    cancelResult: 'SUCCESS' as const,
    newOrderResult: 'SUCCESS' as const,
    cancelResponse,
    newOrderResponse: { orderId: 43, clientOrderId: 'client-exit', status: 'FILLED' },
  }) as Awaited<ReturnType<BinanceRestClient['cancelReplaceOrder']>>;

// The operator's own close, fused with the retraction of the stop that was protecting the position. `buildManualOrderDecision` emits a LIMIT whenever the operator named a price, and `closingSellDecisions` routes EVERY manual SELL through this fusion — so a rule that only recognised a MARKET successor as a close would stop clearing for exactly this one.
const MANUAL_LIMIT_CLOSE: Extract<Decision, { type: 'replace-order' }> = {
  type: 'replace-order',
  cancelOrderId: 42,
  reason: 'tt-protective-stop-superseded',
  intent: {
    symbol: 'BTCUSDT',
    side: 'SELL',
    reason: 'manual',
    clientOrderId: 'client-manual',
  },
  params: { type: 'LIMIT', quantity: '0.001', price: '101', timeInForce: 'GTC' },
};

const persistOrderMock = (implementation: ProfilePersistence['persistOrder']) =>
  vi.fn<ProfilePersistence['persistOrder']>(implementation);

const fakeRedis = (): Redis =>
  ({
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
  }) as unknown as Redis;

const fakeBinance = (overrides: Partial<BinanceRestClient> = {}): BinanceRestClient =>
  ({
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    cancelReplaceOrder: vi.fn(),
    getOrder: vi.fn(),
    ctx: () => ({ weightUsed1m: 50, mode: 'live' as const }),
    ...overrides,
  }) as unknown as BinanceRestClient;

const ENABLED_SLACK_ROW = { provider: 'slack', config: {}, secrets: {}, enabled: true } as const;

const buildBindings = (
  overrides: Partial<Omit<ProfileExecutorBindings, 'persistence' | 'binance'>> & {
    persistence?: Partial<ProfilePersistence>;
    binance?: BinanceRestClient;
  } = {},
): ProfileExecutorBindings => {
  const { persistence: persistenceOverrides, binance, ...rest } = overrides;
  return {
    mode: 'live',
    binance: binance ?? fakeBinance(),
    weightLimit1m: 1200,
    quoteAsset: 'USDT',
    ...rest,
    persistence: {
      persistOrder: persistOrderMock(async () => undefined),
      resolveOrderSlot: async () => null,
      persistTrackingOrder: vi.fn(async () => undefined),
      closeOrder: async () => undefined,
      recordBookkeepingFailure: vi.fn(async () => undefined),
      listEnabledNotifiers: vi.fn(async () => [ENABLED_SLACK_ROW]),
      recordNotifierGap: vi.fn(async () => undefined),
      ...persistenceOverrides,
    },
  } as unknown as ProfileExecutorBindings;
};

const buildDeps = (
  bindings: ProfileExecutorBindings,
  redis: Redis = fakeRedis(),
  overrides: Partial<DecisionDeps> = {},
): DecisionDeps => {
  const registry: Partial<NotifyProviderRegistry> = { get: () => undefined, list: () => [] };
  return {
    redis,
    accountId: ACCOUNT,
    logger: pino({ level: 'silent' }),
    clock: CLOCK,
    weightTtlSeconds: 120,
    notifyRegistry: registry as NotifyProviderRegistry,
    strategies: createRegistry(),
    resolveProfile: async () => bindings,
    cancelLedger: createCancelLedger(),
    ...overrides,
  };
};

describe('replaceOrderHandler', () => {
  // A clean cancelReplace must call the client exactly once with the successor's order params plus the resting order's id, never call placeOrder, persist the successor, and evict the cancelled order from cache.
  it('C1: SUCCESS/SUCCESS persists the successor and evicts the cancelled order', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(
      async () =>
        ({
          cancelResult: 'SUCCESS' as const,
          newOrderResult: 'SUCCESS' as const,
          cancelResponse: { orderId: 42, status: 'CANCELED', transactTime: CANCEL_LEG_MS },
          newOrderResponse: { orderId: 43, clientOrderId: 'client-2', status: 'NEW' },
        }) as Awaited<ReturnType<BinanceRestClient['cancelReplaceOrder']>>,
    );
    const binance = fakeBinance({ cancelReplaceOrder });
    const persistOrder = persistOrderMock(async () => undefined);
    const closeOrder = vi.fn(async () => undefined);
    const bindings = buildBindings({ binance, persistence: { persistOrder, closeOrder } });
    const redis = fakeRedis();
    const deps = buildDeps(bindings, redis);

    const out = await replaceOrderHandler(deps, CTX, REPLACE);

    expect(cancelReplaceOrder).toHaveBeenCalledTimes(1);
    const params = cancelReplaceOrder.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'STOP_LOSS_LIMIT',
      quantity: '0.001',
      newClientOrderId: 'client-2',
      cancelOrderId: 42,
    });
    expect(binance.placeOrder).not.toHaveBeenCalled();
    expect(closeOrder).toHaveBeenCalledWith(42, 'CANCELED', CANCEL_LEG_MS, {
      orderId: 42,
      status: 'CANCELED',
      transactTime: CANCEL_LEG_MS,
    });
    expect(persistOrder).toHaveBeenCalledWith(
      expect.objectContaining({ binanceOrderId: 43n }),
      expect.anything(),
    );
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringMatching(/open-orders:BTCUSDT$/),
      'remove',
      '42',
      expect.anything(),
    );
    expect(out).toEqual({ ok: true });
  });

  it('stamps the placement owner before cancelReplace and before the -2021 retry', async () => {
    const firstOrder: string[] = [];
    const placementOwner = {
      register: vi.fn(async () => {
        firstOrder.push('register');
      }),
      ownerOf: vi.fn(async () => null),
    };
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      firstOrder.push('cancelReplaceOrder');
      return {
        cancelResult: 'SUCCESS' as const,
        newOrderResult: 'SUCCESS' as const,
        cancelResponse: { orderId: 42, status: 'CANCELED' },
        newOrderResponse: { orderId: 43, clientOrderId: 'client-2', status: 'NEW' },
      } as Awaited<ReturnType<BinanceRestClient['cancelReplaceOrder']>>;
    });
    const firstBinance = fakeBinance({ cancelReplaceOrder });
    const firstCloseOrder = vi.fn(async () => undefined);
    const firstBindings = buildBindings({
      binance: firstBinance,
      persistence: { closeOrder: firstCloseOrder },
    });
    const firstDeps = buildDeps(firstBindings, fakeRedis(), { placementOwner });

    await replaceOrderHandler(firstDeps, CTX, REPLACE);

    expect(placementOwner.register).toHaveBeenCalledWith(ACCOUNT, PROFILE, 'client-2');
    expect(firstOrder).toEqual(['register', 'cancelReplaceOrder']);
    // This body carries a terminal status and NO exchange clock, which is the one shape the worker-clock fallback exists for. Without the assertion the fallback is unpinned: a bare cast would read `undefined` into `closed_at` and every test here would still pass.
    expect(firstCloseOrder).toHaveBeenCalledWith(42, 'CANCELED', CLOCK.nowMs(), {
      orderId: 42,
      status: 'CANCELED',
    });

    const secondOrder: string[] = [];
    placementOwner.register.mockClear();
    placementOwner.register.mockImplementation(async () => {
      secondOrder.push('register');
    });
    const retryCancelReplaceOrder = cancelReplaceOrderMock(async () => {
      secondOrder.push('cancelReplaceOrder');
      throw new BinanceApiError(
        { status: 409, code: -2021, msg: 'Order cancel-replace partially failed.' },
        false,
        'rejected',
      );
    });
    const placeOrder = placeOrderMock(async () => {
      secondOrder.push('placeOrder');
      return { orderId: 44, clientOrderId: 'client-2', status: 'NEW' };
    });
    const secondBinance = fakeBinance({
      cancelReplaceOrder: retryCancelReplaceOrder,
      placeOrder,
    });
    const secondBindings = buildBindings({ binance: secondBinance });
    const secondDeps = buildDeps(secondBindings, fakeRedis(), { placementOwner });

    await replaceOrderHandler(secondDeps, CTX, REPLACE);

    expect(placementOwner.register).toHaveBeenCalledTimes(2);
    expect(placementOwner.register).toHaveBeenLastCalledWith(ACCOUNT, PROFILE, 'client-2');
    expect(secondOrder).toEqual(['register', 'cancelReplaceOrder', 'register', 'placeOrder']);
  });

  // A SUCCESS/SUCCESS response with no readable successor order id must not be reported as a success, because nothing is left resting to protect.
  it('C1 negative: SUCCESS without a new-order body is not ok:true', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(
      async () =>
        ({
          cancelResult: 'SUCCESS' as const,
          newOrderResult: 'SUCCESS' as const,
          cancelResponse: { orderId: 42, status: 'CANCELED' },
          newOrderResponse: null,
        }) as Awaited<ReturnType<BinanceRestClient['cancelReplaceOrder']>>,
    );
    const binance = fakeBinance({ cancelReplaceOrder });
    const bindings = buildBindings({ binance });
    const enqueueSymbolReconcile = vi.fn();
    const deps = buildDeps(bindings, fakeRedis(), { enqueueSymbolReconcile });

    const out = await replaceOrderHandler(deps, CTX, REPLACE);

    expect(out).toEqual({
      ok: false,
      retryable: false,
      phase: 'accepted',
      reason: 'cancelReplace: SUCCESS without a new order body',
    });
    expect(enqueueSymbolReconcile).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'replace-order-failed' }),
    );
  });

  // -2022, cancel refused and nothing changed, must never call placeOrder, must leave the open-orders cache untouched, and must enqueue the reconcile.
  it('C2: -2022 makes no placeOrder call and enqueues a reconcile', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new BinanceApiError(
        { status: 400, code: -2022, msg: 'Cancel order failed.' },
        false,
        'rejected',
      );
    });
    const binance = fakeBinance({ cancelReplaceOrder });
    const closeOrder = vi.fn(async () => undefined);
    const bindings = buildBindings({ binance, persistence: { closeOrder } });
    const redis = fakeRedis();
    const enqueueSymbolReconcile = vi.fn();
    const deps = buildDeps(bindings, redis, { enqueueSymbolReconcile });

    const out = await replaceOrderHandler(deps, CTX, REPLACE);

    expect(binance.placeOrder).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
    expect(enqueueSymbolReconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: PROFILE,
        symbol: 'BTCUSDT',
        cause: 'replace-order-failed',
      }),
    );
    // The stop is STILL RESTING on a genuine refusal, so its local row must not be stamped CANCELED — that would record a live order as gone.
    expect(closeOrder).not.toHaveBeenCalled();
    // NOT_ATTEMPTED under STOP_ON_FAILURE is proof the successor never reached the matching engine, so the decision must stay re-issuable; a non-retryable result settles an operator override `rejected` and silently abandons their force-sell.
    expect(out).toMatchObject({ ok: false, retryable: true, phase: 'rejected' });
  });

  // `-2011` is CANCEL_REJECTED, not absence, so it collapses two OPPOSITE states: a concurrent cancel already took the order off the book, or the order FILLED. Anything the executor decides from the body alone is a guess. A terminal, non-filling status is the case where the order really is gone, which is the -2021 state — without the shared repair the strategy re-emits the same replacement against a phantom order every tick until the open-orders cache TTL expires, leaving the position unsold.
  it('probes a -2011 cancel leg, and re-places the successor when the order was genuinely retired', async () => {
    const order = <string[]>[];
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      order.push('cancelReplace');
      throw new BinanceApiError(
        { status: 400, code: -2022, msg: 'Order cancel-replace failed.', cancelLegCode: -2011 },
        false,
        'rejected',
      );
    });
    const probed = {
      orderId: 42,
      status: 'CANCELED',
      updateTime: CANCEL_LEG_MS,
      executedQty: '0',
    };
    const getOrder = vi.fn(async () => {
      order.push('getOrder');
      return probed;
    }) as unknown as BinanceRestClient['getOrder'];
    const placeOrder = placeOrderMock(async () => {
      order.push('placeOrder');
      return { orderId: 44, clientOrderId: 'client-exit', status: 'FILLED' };
    });
    const closeOrder = vi.fn(async () => {
      order.push('closeOrder');
    });
    const binance = fakeBinance({ cancelReplaceOrder, placeOrder, getOrder });
    const bindings = buildBindings({ binance, persistence: { closeOrder } });
    const redis = fakeRedis();
    const enqueueSymbolReconcile = vi.fn();

    const out = await replaceOrderHandler(
      buildDeps(bindings, redis, { enqueueSymbolReconcile }),
      CTX,
      FUSED_CLOSE,
    );

    expect(getOrder).toHaveBeenCalledWith({ symbol: 'BTCUSDT', orderId: 42 });
    expect(order).toEqual(['cancelReplace', 'getOrder', 'closeOrder', 'placeOrder']);
    // The probed record, not a worker-clocked guess: its status, its exchange clock, and its body as the row's `raw`.
    expect(closeOrder).toHaveBeenCalledWith(42, 'CANCELED', CANCEL_LEG_MS, probed);
    // The phantom must leave the shared open-orders cache, or every tick keeps seeing it for the remaining TTL and re-emits against it.
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringMatching(/open-orders:BTCUSDT$/),
      'remove',
      '42',
      expect.anything(),
    );
    // The successor landed, so there is nothing left to reconcile.
    expect(enqueueSymbolReconcile).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: true });
  });

  // THE money case. The same gap-down that fires a fused close is what trips the resting stop, so a -2011 here most likely means the stop FILLED. Guessing CANCELED would stamp a real trade with executedQty 0 and the archive (which selects status = 'FILLED') would never see it again; re-placing the MARKET exit behind it would be a SECOND sale of a position that is already flat, fundable from a sibling profile's base on the shared account wallet.
  it('withholds the successor and reconciles when the -2011 probe says the stop filled', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new BinanceApiError(
        { status: 400, code: -2022, msg: 'Order cancel-replace failed.', cancelLegCode: -2011 },
        false,
        'rejected',
      );
    });
    const probed = {
      orderId: 42,
      status: 'FILLED',
      updateTime: CANCEL_LEG_MS,
      executedQty: '0.001',
    };
    const getOrder = vi.fn(async () => probed) as unknown as BinanceRestClient['getOrder'];
    const placeOrder = placeOrderMock(async () => ({
      orderId: 44,
      clientOrderId: 'client-exit',
      status: 'FILLED',
    }));
    const closeOrder = vi.fn(async () => undefined);
    const binance = fakeBinance({ cancelReplaceOrder, placeOrder, getOrder });
    const bindings = buildBindings({ binance, persistence: { closeOrder } });
    const enqueueSymbolReconcile = vi.fn();

    const out = await replaceOrderHandler(
      buildDeps(bindings, fakeRedis(), { enqueueSymbolReconcile }),
      CTX,
      FUSED_CLOSE,
    );

    // Nothing new on the book: the position is already flat.
    expect(placeOrder).not.toHaveBeenCalled();
    // The row records the FILL, so the trade stays visible to realised P/L.
    expect(closeOrder).toHaveBeenCalledWith(42, 'FILLED', CANCEL_LEG_MS, probed);
    // The strategy still believes it holds the base; only the reconciler can take it away, and it must not be adopted inline because this runs inside the chain lock the fill-adopter also takes.
    expect(enqueueSymbolReconcile).toHaveBeenCalledWith({
      profileId: PROFILE,
      symbol: 'BTCUSDT',
      cause: 'cancel-2011-fill',
    });
    expect(out).toMatchObject({ ok: false, retryable: false, phase: 'rejected' });
  });

  // Weight accounting is bookkeeping, not the money path. Every recording here is best-effort for the same reason: a Redis fault must not turn a completed exchange interaction into a reported failure, which would have the tick re-issue it. The probe added its own recording, so it needs its own proof it cannot fail the call.
  it('completes the -2011 repair when recording request weight fails at every step', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new BinanceApiError(
        { status: 400, code: -2022, msg: 'Order cancel-replace failed.', cancelLegCode: -2011 },
        false,
        'rejected',
      );
    });
    const getOrder = vi.fn(async () => ({
      orderId: 42,
      status: 'CANCELED',
      updateTime: CANCEL_LEG_MS,
      executedQty: '0',
    })) as unknown as BinanceRestClient['getOrder'];
    const placeOrder = placeOrderMock(async () => ({
      orderId: 44,
      clientOrderId: 'client-exit',
      status: 'FILLED',
    }));
    const binance = fakeBinance({ cancelReplaceOrder, placeOrder, getOrder });
    const bindings = buildBindings({ binance });
    const redis = fakeRedis();
    // The weight bucket is a plain SET; failing it fails every recording on this path.
    redis.set = vi.fn(async () => {
      throw new Error('redis unavailable');
    }) as unknown as Redis['set'];
    const warn = vi.fn();

    const out = await replaceOrderHandler(
      buildDeps(bindings, redis, { logger: { warn } as unknown as DecisionDeps['logger'] }),
      CTX,
      FUSED_CLOSE,
    );

    expect(getOrder).toHaveBeenCalledTimes(1);
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    expect(out).toEqual({ ok: true });
  });

  // A FILLED status that moved nothing is not a fill. The order is off the book with no position to adopt, so it is the ordinary retirement — treating it as a fill would withhold an exit the profile still needs.
  it('re-places the successor when the -2011 probe says FILLED with a zero executedQty', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new BinanceApiError(
        { status: 400, code: -2022, msg: 'Order cancel-replace failed.', cancelLegCode: -2011 },
        false,
        'rejected',
      );
    });
    const getOrder = vi.fn(async () => ({
      orderId: 42,
      status: 'FILLED',
      updateTime: CANCEL_LEG_MS,
      executedQty: '0',
    })) as unknown as BinanceRestClient['getOrder'];
    const placeOrder = placeOrderMock(async () => ({
      orderId: 44,
      clientOrderId: 'client-exit',
      status: 'FILLED',
    }));
    const binance = fakeBinance({ cancelReplaceOrder, placeOrder, getOrder });
    const bindings = buildBindings({ binance });
    const enqueueSymbolReconcile = vi.fn();

    const out = await replaceOrderHandler(
      buildDeps(bindings, fakeRedis(), { enqueueSymbolReconcile }),
      CTX,
      FUSED_CLOSE,
    );

    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(enqueueSymbolReconcile).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: true });
  });

  // Fail CLOSED. An unanswered probe and a probe that says the order is STILL RESTING are the same posture: we did not learn that it is gone, so nothing may be retired locally and nothing new may go on the book.
  it('falls back to the ordinary -2022 refusal when the -2011 probe does not prove the order gone', async () => {
    for (const getOrder of [
      vi.fn(async () => {
        throw new Error('binance unreachable');
      }),
      vi.fn(async () => ({
        orderId: 42,
        status: 'NEW',
        updateTime: CANCEL_LEG_MS,
        executedQty: '0',
      })),
      // `OpenOrderDto` is a CAST of the parsed body, so a non-string status is reachable and `isTerminalOrderStatus` would call `toUpperCase` on it. Unguarded, this throws out of the handler after Binance has refused the cancel, turning a refusal the tick can act on into a failed tick.
      vi.fn(async () => ({ orderId: 42, status: 7, updateTime: CANCEL_LEG_MS, executedQty: '0' })),
    ] as unknown as BinanceRestClient['getOrder'][]) {
      const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
        throw new BinanceApiError(
          { status: 400, code: -2022, msg: 'Order cancel-replace failed.', cancelLegCode: -2011 },
          false,
          'rejected',
        );
      });
      const placeOrder = placeOrderMock(async () => ({
        orderId: 44,
        clientOrderId: 'client-exit',
        status: 'FILLED',
      }));
      const closeOrder = vi.fn(async () => undefined);
      const binance = fakeBinance({ cancelReplaceOrder, placeOrder, getOrder });
      const bindings = buildBindings({ binance, persistence: { closeOrder } });
      const enqueueSymbolReconcile = vi.fn();

      const out = await replaceOrderHandler(
        buildDeps(bindings, fakeRedis(), { enqueueSymbolReconcile }),
        CTX,
        FUSED_CLOSE,
      );

      expect(placeOrder).not.toHaveBeenCalled();
      expect(closeOrder).not.toHaveBeenCalled();
      expect(enqueueSymbolReconcile).toHaveBeenCalledWith({
        profileId: PROFILE,
        symbol: 'BTCUSDT',
        cause: 'replace-order-failed',
      });
      expect(out).toMatchObject({ ok: false, retryable: true });
    }
  });

  // Binance charges a refused call and reports the running total in its response header, which the REST client folds into `ctx` before it throws, so a probe that fails has still SPENT weight. The failure path returns without another Binance call, so nothing later overwrites the bucket the account governor reads to decide whether the next call may go out. Asserted on the VALUE rather than a call count: the cancelReplace failure above already records 50, so only a recording taken after the probe can carry 137.
  it('records the request weight the -2011 probe spent even when the probe fails', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new BinanceApiError(
        { status: 400, code: -2022, msg: 'Order cancel-replace failed.', cancelLegCode: -2011 },
        false,
        'rejected',
      );
    });
    const getOrder = vi.fn(async () => {
      throw new Error('binance unreachable');
    }) as unknown as BinanceRestClient['getOrder'];
    const weights = [50, 137];
    const binance = fakeBinance({
      cancelReplaceOrder,
      getOrder,
      ctx: () => ({ weightUsed1m: weights.shift() ?? 137, mode: 'live' as const }),
    } as unknown as Partial<BinanceRestClient>);
    const redis = fakeRedis();

    const out = await replaceOrderHandler(
      buildDeps(buildBindings({ binance }), redis),
      CTX,
      FUSED_CLOSE,
    );

    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('binance:weight:'),
      '137',
      'EX',
      120,
    );
    expect(out).toMatchObject({ ok: false, retryable: true });
  });

  // ONE terminal vocabulary, or the flow answers "is this order gone?" two ways eight lines apart. `EXPIRED_IN_MATCH` is what self-trade prevention returns when a sibling profile's BUY crosses our resting protective SELL on the shared account wallet — the order is provably off the book, and a narrower local set would refuse the repair, withhold the exit, and spend a fresh probe on it every tick.
  it('takes the retirement repair when the -2011 probe answers EXPIRED_IN_MATCH', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new BinanceApiError(
        { status: 400, code: -2022, msg: 'Order cancel-replace failed.', cancelLegCode: -2011 },
        false,
        'rejected',
      );
    });
    const probed = {
      orderId: 42,
      status: 'EXPIRED_IN_MATCH',
      updateTime: CANCEL_LEG_MS,
      executedQty: '0',
    };
    const getOrder = vi.fn(async () => probed) as unknown as BinanceRestClient['getOrder'];
    const placeOrder = placeOrderMock(async () => ({
      orderId: 44,
      clientOrderId: 'client-exit',
      status: 'FILLED',
    }));
    const closeOrder = vi.fn(async () => undefined);
    const binance = fakeBinance({ cancelReplaceOrder, placeOrder, getOrder });
    const bindings = buildBindings({ binance, persistence: { closeOrder } });
    const enqueueSymbolReconcile = vi.fn();

    const out = await replaceOrderHandler(
      buildDeps(bindings, fakeRedis(), { enqueueSymbolReconcile }),
      CTX,
      FUSED_CLOSE,
    );

    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(closeOrder).toHaveBeenCalledWith(42, 'EXPIRED_IN_MATCH', CANCEL_LEG_MS, probed);
    // The order moved no base, so there is no position drift to converge.
    expect(enqueueSymbolReconcile).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: true });
  });

  // Binance's documented partial-cancel body: a terminal CANCELED carrying the quantity that DID execute. The successor is still owed — there is base left to sell — but the fill is invisible to the stream, because `fill-adopter` drops every execution report whose order status is not FILLED. So this is the one shape that needs BOTH halves: re-place, and reconcile.
  it('re-places the successor and reconciles when the -2011 probe says a cancelled partial', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new BinanceApiError(
        { status: 400, code: -2022, msg: 'Order cancel-replace failed.', cancelLegCode: -2011 },
        false,
        'rejected',
      );
    });
    const probed = {
      orderId: 42,
      status: 'CANCELED',
      updateTime: CANCEL_LEG_MS,
      executedQty: '0.0004',
    };
    const getOrder = vi.fn(async () => probed) as unknown as BinanceRestClient['getOrder'];
    const placeOrder = placeOrderMock(async () => ({
      orderId: 44,
      clientOrderId: 'client-exit',
      status: 'FILLED',
    }));
    const closeOrder = vi.fn(async () => undefined);
    const binance = fakeBinance({ cancelReplaceOrder, placeOrder, getOrder });
    const bindings = buildBindings({ binance, persistence: { closeOrder } });
    const enqueueSymbolReconcile = vi.fn();

    const out = await replaceOrderHandler(
      buildDeps(bindings, fakeRedis(), { enqueueSymbolReconcile }),
      CTX,
      FUSED_CLOSE,
    );

    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(closeOrder).toHaveBeenCalledWith(42, 'CANCELED', CANCEL_LEG_MS, probed);
    expect(enqueueSymbolReconcile).toHaveBeenCalledWith({
      profileId: PROFILE,
      symbol: 'BTCUSDT',
      cause: 'cancel-2011-fill',
    });
    expect(out).toEqual({ ok: true });
  });

  // The row and the live event must agree. Before the leg could ever read FILLED a constant was harmless; now a hard-coded CANCELED would tell the operator nothing sold at the exact moment their position was sold.
  it('publishes the retired leg’s real status on the orders event', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new BinanceApiError(
        { status: 400, code: -2022, msg: 'Order cancel-replace failed.', cancelLegCode: -2011 },
        false,
        'rejected',
      );
    });
    const getOrder = vi.fn(async () => ({
      orderId: 42,
      status: 'FILLED',
      updateTime: CANCEL_LEG_MS,
      executedQty: '0.001',
    })) as unknown as BinanceRestClient['getOrder'];
    const binance = fakeBinance({ cancelReplaceOrder, getOrder });
    const bindings = buildBindings({ binance });
    const published: string[] = [];
    const redis = fakeRedis();
    redis.multi = vi.fn(() => {
      const pipeline = {
        publish: vi.fn((_channel: string, body: string) => {
          published.push(body);
          return pipeline;
        }),
        xadd: vi.fn(() => pipeline),
        exec: vi.fn(async () => []),
      };
      return pipeline;
    }) as unknown as Redis['multi'];

    await replaceOrderHandler(buildDeps(bindings, redis), CTX, FUSED_CLOSE);

    expect(published).toHaveLength(1);
    expect(JSON.parse(published[0] ?? '{}')).toMatchObject({
      topic: 'orders',
      payload: { orderId: 42, status: 'FILLED' },
    });
  });

  // `dto` is a CAST of the parsed response, so the cancel slot's `status` is whatever Binance actually sent. A key-presence test would hand a non-string straight to `isTerminalOrderStatus`, whose `toUpperCase` throws — outside every try on this path, after the stop is cancelled and the successor placed, and before the successor's row is written.
  it('falls back to a worker-clocked CANCELED when the success body’s cancel status is not a string', async () => {
    for (const status of [7, { code: -2011 }]) {
      const cancelReplaceOrder = cancelReplaceOrderMock(async () =>
        filledSuccessor({ orderId: 42, status, transactTime: CANCEL_LEG_MS }),
      );
      const closeOrder = vi.fn(async () => undefined);
      const binance = fakeBinance({ cancelReplaceOrder });
      const bindings = buildBindings({ binance, persistence: { closeOrder } });

      const out = await replaceOrderHandler(buildDeps(bindings), CTX, FUSED_CLOSE);

      expect(closeOrder).toHaveBeenCalledWith(42, 'CANCELED', CLOCK.nowMs(), undefined);
      expect(out).toEqual({ ok: true });
    }
  });

  // Same rule, the other two bodies: a retirement that moved base owes a reconcile wherever the record came from, because nothing downstream will ever report that fill.
  it('reconciles when the happy path’s own cancel record had partially filled', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => filledSuccessor());
    const binance = fakeBinance({ cancelReplaceOrder });
    const bindings = buildBindings({ binance });
    const enqueueSymbolReconcile = vi.fn();

    const out = await replaceOrderHandler(
      buildDeps(bindings, fakeRedis(), { enqueueSymbolReconcile }),
      CTX,
      FUSED_CLOSE,
    );

    expect(enqueueSymbolReconcile).toHaveBeenCalledWith({
      profileId: PROFILE,
      symbol: 'BTCUSDT',
      cause: 'cancel-2011-fill',
    });
    expect(out).toEqual({ ok: true });
  });

  it('keeps a -2022 with any other cancel-leg code on the refusal path, without probing', async () => {
    // Only -2011 is ambiguous. Any other leg code is a plain refusal of a cancel against an order that is still resting, so re-placing would put a second order on the same base — and spending a weight-charged probe on it would buy nothing.
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new BinanceApiError(
        { status: 400, code: -2022, msg: 'Order cancel-replace failed.', cancelLegCode: -1102 },
        false,
        'rejected',
      );
    });
    const closeOrder = vi.fn(async () => undefined);
    const binance = fakeBinance({ cancelReplaceOrder });
    const bindings = buildBindings({ binance, persistence: { closeOrder } });

    const out = await replaceOrderHandler(buildDeps(bindings), CTX, FUSED_CLOSE);

    expect(binance.placeOrder).not.toHaveBeenCalled();
    expect(binance.getOrder).not.toHaveBeenCalled();
    expect(closeOrder).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: false, retryable: true });
  });

  it('marks the cancelled slot unresolved for -2022', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new BinanceApiError(
        { status: 400, code: -2022, msg: 'Cancel order failed.' },
        false,
        'rejected',
      );
    });
    const binance = fakeBinance({ cancelReplaceOrder });
    const bindings = buildBindings({ binance });
    const cancelLedger = createCancelLedger();
    const markUnresolved = vi.spyOn(cancelLedger, 'markUnresolved');
    const deps = buildDeps(bindings, fakeRedis(), { cancelLedger });

    await replaceOrderHandler(deps, CTX, REPLACE);

    expect(markUnresolved).toHaveBeenCalledWith('BTCUSDT', undefined);
  });

  // -2021, cancel cleared and successor rejected, must retry the successor exactly once with identical params minus cancelOrderId, then persist the successor and evict the cancelled order id on success.
  it('C3 success leg: -2021 then a successful bare placeOrder persists the successor', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new BinanceApiError(
        { status: 409, code: -2021, msg: 'Order cancel-replace partially failed.' },
        false,
        'rejected',
      );
    });
    const placeOrder = placeOrderMock(async () => ({
      orderId: 44,
      clientOrderId: 'client-2',
      status: 'NEW',
    }));
    const binance = fakeBinance({ cancelReplaceOrder, placeOrder });
    const persistOrder = persistOrderMock(async () => undefined);
    const bindings = buildBindings({ binance, persistence: { persistOrder } });
    const redis = fakeRedis();
    const deps = buildDeps(bindings, redis);

    const out = await replaceOrderHandler(deps, CTX, REPLACE);

    expect(placeOrder).toHaveBeenCalledTimes(1);
    const placeParams = placeOrder.mock.calls[0]?.[0];
    expect(placeParams).toMatchObject({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'STOP_LOSS_LIMIT',
      quantity: '0.001',
      newClientOrderId: 'client-2',
    });
    expect(placeParams).not.toHaveProperty('cancelOrderId');
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringMatching(/open-orders:BTCUSDT$/),
      'remove',
      '42',
      expect.anything(),
    );
    expect(persistOrder).toHaveBeenCalledWith(
      expect.objectContaining({ binanceOrderId: 44n }),
      expect.anything(),
    );
    expect(out).toEqual({ ok: true });
  });

  it('continues the -2021 retry when cancelled-leg event emission fails', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new BinanceApiError(
        { status: 409, code: -2021, msg: 'Order cancel-replace partially failed.' },
        false,
        'rejected',
      );
    });
    const placeOrder = placeOrderMock(async () => ({
      orderId: 44,
      clientOrderId: 'client-2',
      status: 'NEW',
    }));
    const binance = fakeBinance({ cancelReplaceOrder, placeOrder });
    const bindings = buildBindings({ binance });
    const redis = fakeRedis();
    (redis.incr as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('redis unavailable'));

    const out = await replaceOrderHandler(buildDeps(bindings, redis), CTX, REPLACE);

    expect(placeOrder).toHaveBeenCalledOnce();
    expect(out).toEqual({ ok: true });
  });

  it('closes the cancelled leg locally before the -2021 retry', async () => {
    const order = <string[]>[];
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      order.push('cancelReplace');
      throw new BinanceApiError(
        { status: 409, code: -2021, msg: 'Order cancel-replace partially failed.' },
        false,
        'rejected',
      );
    });
    const placeOrder = placeOrderMock(async () => {
      order.push('placeOrder');
      return { orderId: 44, clientOrderId: 'client-2', status: 'NEW' };
    });
    const closeOrder = vi.fn(async () => {
      order.push('closeOrder');
    });
    const binance = fakeBinance({ cancelReplaceOrder, placeOrder });
    const bindings = buildBindings({ binance, persistence: { closeOrder } });

    const out = await replaceOrderHandler(buildDeps(bindings), CTX, REPLACE);

    expect(closeOrder).toHaveBeenCalledWith(42, 'CANCELED', CLOCK.nowMs(), undefined);
    expect(order).toEqual(['cancelReplace', 'closeOrder', 'placeOrder']);
    expect(out).toEqual({ ok: true });
  });

  // Under STOP_ON_FAILURE a -2021 means the CANCEL SUCCEEDED, so the error's own cancel leg is Binance's record of the order it just retired — not an error shape. Reading it is the difference between archiving a partially-filled stop with its real proceeds and stamping a worker-clocked CANCELED over the placement-time zero, which nothing repairs later.
  it('closes the -2021 leg from the error’s own cancel record when Binance sent one', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new BinanceApiError(
        {
          status: 409,
          code: -2021,
          msg: 'Order cancel-replace partially failed.',
          cancelLeg: CANCEL_LEG,
        },
        false,
        'rejected',
      );
    });
    const placeOrder = placeOrderMock(async () => ({
      orderId: 44,
      clientOrderId: 'client-2',
      status: 'NEW',
    }));
    const closeOrder = vi.fn(async () => undefined);
    const binance = fakeBinance({ cancelReplaceOrder, placeOrder });
    const bindings = buildBindings({ binance, persistence: { closeOrder } });
    const enqueueSymbolReconcile = vi.fn();

    const out = await replaceOrderHandler(
      buildDeps(bindings, fakeRedis(), { enqueueSymbolReconcile }),
      CTX,
      REPLACE,
    );

    expect(closeOrder).toHaveBeenCalledWith(42, 'CANCELED', CANCEL_LEG_MS, CANCEL_LEG);
    // This leg had partially filled, and no execution report will ever carry that fill, so the successor landing is not the end of the repair.
    expect(enqueueSymbolReconcile).toHaveBeenCalledWith({
      profileId: PROFILE,
      symbol: 'BTCUSDT',
      cause: 'cancel-2011-fill',
    });
    expect(out).toEqual({ ok: true });
  });

  // A close is where the duplicate-MARKET guard must forget this symbol's entry records. Entry clientOrderIds are stable per (profile, symbol, level), and a grid promotion or pyramid add recorded WHILE the stop rested would otherwise suppress a legitimate re-entry at that level for the rest of the 60s window. Before the exit and its stop-retraction were fused, the exit was a `place-order` SELL and cleared them.
  it('clears the symbol’s placement-dedup records for a terminal MARKET SELL close', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => filledSuccessor());
    const binance = fakeBinance({ cancelReplaceOrder });
    const bindings = buildBindings({ binance });
    const placementDedup = {
      seenRecently: vi.fn(async () => false),
      record: vi.fn(async () => undefined),
      forgetSymbol: vi.fn(async () => undefined),
    };
    const deps = buildDeps(bindings, fakeRedis(), {
      placementDedup,
    } as unknown as Partial<DecisionDeps>);

    const out = await replaceOrderHandler(deps, CTX, FUSED_CLOSE);

    expect(placementDedup.forgetSymbol).toHaveBeenCalledWith(`${ACCOUNT}:BTCUSDT`, CLOCK.nowMs());
    expect(out).toEqual({ ok: true });
  });

  // Every manual SELL is routed through the same fusion, and the operator gets a LIMIT whenever they named a price. That close retires the position exactly as a MARKET one does, so it must clear too — before this fusion existed it was a plain `place-order` SELL, which clears on side alone.
  it('clears the symbol’s placement-dedup records for a fused manual LIMIT SELL close', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => filledSuccessor());
    const binance = fakeBinance({ cancelReplaceOrder });
    const bindings = buildBindings({ binance });
    const placementDedup = {
      seenRecently: vi.fn(async () => false),
      record: vi.fn(async () => undefined),
      forgetSymbol: vi.fn(async () => undefined),
    };
    const deps = buildDeps(bindings, fakeRedis(), {
      placementDedup,
    } as unknown as Partial<DecisionDeps>);

    const out = await replaceOrderHandler(deps, CTX, MANUAL_LIMIT_CLOSE);

    expect(placementDedup.forgetSymbol).toHaveBeenCalledWith(`${ACCOUNT}:BTCUSDT`, CLOCK.nowMs());
    expect(out).toEqual({ ok: true });
  });

  // A re-price retires nothing and closes nothing, so it must NOT clear. Clearing on every re-arm would drop exactly the add-on BUY records the guard exists to hold, which is when a duplicate grid add would stop being suppressed. Both shapes, because trailing-trade re-arms the priced form and momentum the exchange-native one.
  it('leaves the placement-dedup records alone for a re-armed protective stop', async () => {
    for (const params of [
      REPLACE.params,
      { type: 'STOP_LOSS' as const, quantity: '0.001', trailingDelta: 250 },
    ]) {
      const cancelReplaceOrder = cancelReplaceOrderMock(
        async () =>
          ({
            cancelResult: 'SUCCESS' as const,
            newOrderResult: 'SUCCESS' as const,
            cancelResponse: CANCEL_LEG,
            newOrderResponse: { orderId: 43, clientOrderId: 'client-2', status: 'NEW' },
          }) as Awaited<ReturnType<BinanceRestClient['cancelReplaceOrder']>>,
      );
      const binance = fakeBinance({ cancelReplaceOrder });
      const bindings = buildBindings({ binance });
      const placementDedup = {
        seenRecently: vi.fn(async () => false),
        record: vi.fn(async () => undefined),
        forgetSymbol: vi.fn(async () => undefined),
      };
      const deps = buildDeps(bindings, fakeRedis(), {
        placementDedup,
      } as unknown as Partial<DecisionDeps>);

      const out = await replaceOrderHandler(deps, CTX, { ...REPLACE, params });

      expect(placementDedup.forgetSymbol).not.toHaveBeenCalled();
      expect(out).toEqual({ ok: true });
    }
  });

  // The successor cannot close the cancelled row for a fused exit: a terminal MARKET never reaches the live-slot upsert at all, and its intent differs from the cancelled stop's. Without an explicit close keyed on cancelOrderId the retired stop stays open locally forever.
  it('closes the cancelled leg locally on the happy path, before persisting a terminal successor', async () => {
    const order = <string[]>[];
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => filledSuccessor());
    const closeOrder = vi.fn(async () => {
      order.push('closeOrder');
    });
    const persistOrder = persistOrderMock(async () => {
      order.push('persistOrder');
    });
    const binance = fakeBinance({ cancelReplaceOrder });
    const bindings = buildBindings({ binance, persistence: { closeOrder, persistOrder } });

    const out = await replaceOrderHandler(buildDeps(bindings), CTX, FUSED_CLOSE);

    expect(binance.placeOrder).not.toHaveBeenCalled();
    expect(closeOrder).toHaveBeenCalledTimes(1);
    // Binance's record verbatim: its status, its EXCHANGE clock, and its body as the row's fresh `raw`. The clock and the `executedQty` in that body are the two things a worker-stamped fallback would lose, and nothing repairs them later — `resolveOrderSlot`'s remaining quantity and the symbol page would keep reading the placement-time zero.
    expect(closeOrder).toHaveBeenCalledWith(42, 'CANCELED', CANCEL_LEG_MS, CANCEL_LEG);
    expect(order).toEqual(['closeOrder', 'persistOrder']);
    expect(out).toEqual({ ok: true });
  });

  it('falls back to a worker-clocked CANCELED when the success body carries no cancel record', async () => {
    // The union admits an error shape and null in the cancel slot. Neither carries a status, so the row must still close rather than be skipped, and its placement-time `raw` must be left intact rather than overwritten by a body that describes no order.
    for (const cancelResponse of [{ code: -2011, msg: 'Unknown order sent.' }, null, undefined]) {
      // Built inline rather than through `filledSuccessor`, whose default parameter would swap a passed `undefined` back for a real cancel record — and `undefined` is the whole point of the third case: it is what a body with no `cancelResponse` key at all reads as, and reading `.status` straight off it throws.
      const cancelReplaceOrder = cancelReplaceOrderMock(
        async () =>
          ({
            cancelResult: 'SUCCESS' as const,
            newOrderResult: 'SUCCESS' as const,
            cancelResponse,
            newOrderResponse: { orderId: 43, clientOrderId: 'client-exit', status: 'FILLED' },
          }) as Awaited<ReturnType<BinanceRestClient['cancelReplaceOrder']>>,
      );
      const closeOrder = vi.fn(async () => undefined);
      const binance = fakeBinance({ cancelReplaceOrder });
      const bindings = buildBindings({ binance, persistence: { closeOrder } });

      const out = await replaceOrderHandler(buildDeps(bindings), CTX, FUSED_CLOSE);

      expect(closeOrder).toHaveBeenCalledWith(42, 'CANCELED', CLOCK.nowMs(), undefined);
      expect(out).toEqual({ ok: true });
    }
  });

  // A DEFENSIVE read, not a shape Binance is expected to send on this leg: the cancel response of an order it actually retired always reports a terminal status. The guard exists because `closeOrder` stamps `closed_at` unconditionally and the repo invariant is that only a terminal row carries one — a status that says the order is still on the book must not close it.
  it('refuses to close the row under a non-terminal cancel status, keeping the body as raw', async () => {
    const stillResting = { orderId: 42, status: 'PARTIALLY_FILLED', transactTime: CANCEL_LEG_MS };
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => filledSuccessor(stillResting));
    const closeOrder = vi.fn(async () => undefined);
    const binance = fakeBinance({ cancelReplaceOrder });
    const bindings = buildBindings({ binance, persistence: { closeOrder } });

    const out = await replaceOrderHandler(buildDeps(bindings), CTX, FUSED_CLOSE);

    // Neither the status nor the exchange clock is adopted — but the body still lands as `raw`, because its `executedQty` is truthful whatever the status says.
    expect(closeOrder).toHaveBeenCalledWith(42, 'CANCELED', CLOCK.nowMs(), stillResting);
    expect(out).toEqual({ ok: true });
  });

  // The exchange has already retired the stop and filled the exit, so a local bookkeeping failure is never a reason to report the money path as failed and have the tick re-run it. It is not a log line either: nothing repairs the orphan in-process, since `symbol-reconcile` converges position and not order rows, so the row keeps reading as resting to `resolveOrderSlot`, the symbol page and the exposure count until `reapStaleOrders` runs at the next boot. Same class as a placement whose row never persisted, so the same escalation, asserted on the durable half as well as the alert.
  it('escalates and still succeeds when closing the cancelled leg locally fails', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => filledSuccessor());
    const closeOrder = vi.fn(async () => {
      throw new Error('postgres unavailable');
    });
    const recordBookkeepingFailure = vi.fn(async () => undefined);
    const binance = fakeBinance({ cancelReplaceOrder });
    const bindings = buildBindings({
      binance,
      persistence: { closeOrder, recordBookkeepingFailure },
    });
    const error = vi.fn();
    const deps = buildDeps(bindings, fakeRedis(), {
      logger: { warn: vi.fn(), error } as unknown as DecisionDeps['logger'],
    });

    const out = await replaceOrderHandler(deps, CTX, FUSED_CLOSE);

    expect(closeOrder).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    expect(recordBookkeepingFailure).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      orderId: 42,
      err: 'postgres unavailable',
    });
    expect(out).toEqual({ ok: true });
  });

  // Under STOP_ON_FAILURE a refused cancel is documented to answer 400/-2022, so this is a shape no documented response produces. It is checked because `dto` is a cast of the parsed body, exactly the reasoning the two type-tests beside it rest on, and this is the field that decides whether a row may be stamped closed: retire the local record of an order still resting and the strategy sees no protective stop, re-arms, and two stops sit live against the same base. The reconcile the successor path enqueues cannot undo it, because it converges position and never re-opens an order row.
  it('refuses a 200 whose cancel leg did not succeed, leaving the row open', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => ({
      ...filledSuccessor(),
      cancelResult: 'FAILURE',
      newOrderResult: 'NOT_ATTEMPTED',
    }));
    const closeOrder = vi.fn(async () => undefined);
    const binance = fakeBinance({ cancelReplaceOrder });
    const bindings = buildBindings({ binance, persistence: { closeOrder } });
    const enqueueSymbolReconcile = vi.fn();

    const out = await replaceOrderHandler(
      buildDeps(bindings, fakeRedis(), { enqueueSymbolReconcile }),
      CTX,
      FUSED_CLOSE,
    );

    expect(closeOrder).not.toHaveBeenCalled();
    expect(enqueueSymbolReconcile).toHaveBeenCalledWith({
      profileId: PROFILE,
      symbol: 'BTCUSDT',
      cause: 'replace-order-failed',
    });
    expect(out).toMatchObject({ ok: false, retryable: true, phase: 'ambiguous' });
  });

  // When the -2021 successor retry also fails, the position is left naked. That must surface as a distinctly-worded, non-silent failure with a reconcile enqueued and a warn log, not a generic classified error.
  it('C3 failure leg: -2021 then a failed placeOrder reports a naked position', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new BinanceApiError(
        { status: 409, code: -2021, msg: 'Order cancel-replace partially failed.' },
        false,
        'rejected',
      );
    });
    const placeOrder = placeOrderMock(async () => {
      throw new BinanceApiError(
        {
          status: 400,
          code: -2010,
          msg: 'Account has insufficient balance for requested action.',
        },
        false,
        'rejected',
      );
    });
    const binance = fakeBinance({ cancelReplaceOrder, placeOrder });
    const bindings = buildBindings({ binance });
    const enqueueSymbolReconcile = vi.fn();
    const warn = vi.fn();
    const deps = buildDeps(bindings, fakeRedis(), {
      enqueueSymbolReconcile,
      logger: { warn } as unknown as DecisionDeps['logger'],
    });

    const out = await replaceOrderHandler(deps, CTX, REPLACE);

    expect(enqueueSymbolReconcile).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'replace-order-failed' }),
    );
    expect(warn).toHaveBeenCalled();
    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.reason.startsWith('cancelReplace: naked')).toBe(true);
  });

  // An ambiguous transport or 5xx failure must not be treated as a clean refusal. It must stay retryable and still trigger the reconcile.
  it('ambiguous phase: an unreadable failure enqueues a reconcile and stays retryable', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new BinanceApiError({ status: 503, code: 0, msg: '' }, true, 'ambiguous');
    });
    const binance = fakeBinance({ cancelReplaceOrder });
    const bindings = buildBindings({ binance });
    const enqueueSymbolReconcile = vi.fn();
    const deps = buildDeps(bindings, fakeRedis(), { enqueueSymbolReconcile });

    const out = await replaceOrderHandler(deps, CTX, REPLACE);

    expect(enqueueSymbolReconcile).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'replace-order-failed' }),
    );
    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.retryable).toBe(true);
  });

  it('ambiguous BinanceApiError marks the cancelled slot unresolved', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new BinanceApiError({ status: 503, code: 0, msg: '' }, true, 'ambiguous');
    });
    const binance = fakeBinance({ cancelReplaceOrder });
    const bindings = buildBindings({ binance });
    const cancelLedger = createCancelLedger();
    const markUnresolved = vi.spyOn(cancelLedger, 'markUnresolved');
    const deps = buildDeps(bindings, fakeRedis(), { cancelLedger });

    await replaceOrderHandler(deps, CTX, REPLACE);

    expect(markUnresolved).toHaveBeenCalledWith('BTCUSDT', undefined);
  });

  // A lost response is the only failure that can retire the order at Binance while the local view stays open, so the three cases below pin what the handler must learn from the exchange rather than record as unknown. They discriminate the two probes by their key: the successor is asked for by `origClientOrderId`, the retired leg by `orderId`.
  describe('a lost cancelReplace response', () => {
    const mkClock = (start: number) => {
      let now = start;
      return { nowMs: () => now, advance: (ms: number) => (now += ms) };
    };
    const SENT_AT = 1_700_000_000_000;

    const timedDeps = (
      bindings: ProfileExecutorBindings,
      clock: ReturnType<typeof mkClock>,
      overrides: Partial<DecisionDeps> = {},
    ): DecisionDeps => ({
      ...buildDeps(bindings, fakeRedis(), overrides),
      clock,
      sleep: async (ms: number) => {
        clock.advance(ms);
      },
    });

    const droppedSocket = (clock: ReturnType<typeof mkClock>) =>
      cancelReplaceOrderMock(async () => {
        clock.advance(300);
        throw new Error('socket hang up');
      });

    it('records the successor Binance kept and closes the leg it retired', async () => {
      const clock = mkClock(SENT_AT);
      const persistTrackingOrder = vi.fn(async () => undefined);
      const closeOrder = vi.fn(async () => undefined);
      const getOrder = vi.fn(async (params: { origClientOrderId?: string; orderId?: number }) =>
        params.origClientOrderId !== undefined
          ? {
              symbol: 'BTCUSDT',
              orderId: 43,
              clientOrderId: 'client-2',
              side: 'SELL',
              type: 'STOP_LOSS_LIMIT',
              price: '94.5',
              origQty: '0.001',
              executedQty: '0',
              status: 'NEW',
              stopPrice: '95',
              // Created after the request was signed, which is what proves it is THIS attempt's order rather than a namesake from an earlier re-arm.
              time: SENT_AT + 600,
              updateTime: SENT_AT + 600,
            }
          : { ...CANCEL_LEG, updateTime: CANCEL_LEG_MS },
      ) as unknown as BinanceRestClient['getOrder'];
      const binance = fakeBinance({ cancelReplaceOrder: droppedSocket(clock), getOrder });
      const bindings = buildBindings({
        binance,
        persistence: {
          persistTrackingOrder:
            persistTrackingOrder as unknown as ProfilePersistence['persistTrackingOrder'],
          closeOrder,
        },
      });

      const out = await replaceOrderHandler(timedDeps(bindings, clock), CTX, REPLACE);

      // `accepted` is what forbids re-issuing a replacement whose successor is already live.
      expect(out).toMatchObject({ ok: false, retryable: false, phase: 'accepted' });
      expect(persistTrackingOrder).toHaveBeenCalledWith(
        expect.objectContaining({ binanceOrderId: 43n, status: 'NEW' }),
      );
      // The retired row is closed from the exchange's own record, carrying the partial it had executed, or `resolveOrderSlot` and open exposure keep counting an order that is gone.
      expect(closeOrder).toHaveBeenCalledWith(
        42,
        'CANCELED',
        CANCEL_LEG_MS,
        expect.objectContaining({ executedQty: '0.0004' }),
      );
    });

    it('leaves the retired row open when the request provably never landed', async () => {
      const clock = mkClock(SENT_AT);
      const closeOrder = vi.fn(async () => undefined);
      const getOrder = vi.fn(async (params: { origClientOrderId?: string; orderId?: number }) => {
        if (params.origClientOrderId !== undefined) {
          throw new BinanceApiError(
            { status: 400, code: -2013, msg: 'Order does not exist.' },
            false,
            'rejected',
          );
        }
        return { ...CANCEL_LEG, status: 'NEW', executedQty: '0' };
      }) as unknown as BinanceRestClient['getOrder'];
      const binance = fakeBinance({ cancelReplaceOrder: droppedSocket(clock), getOrder });
      const bindings = buildBindings({ binance, persistence: { closeOrder } });

      const out = await replaceOrderHandler(timedDeps(bindings, clock), CTX, REPLACE);

      // Nothing reached the matching engine, so the state must stay un-advanced and the next tick re-derive.
      expect(out).toMatchObject({ ok: false, retryable: true, phase: 'rejected' });
      expect(closeOrder).not.toHaveBeenCalled();
    });

    it('marks the slot unresolved and leaves the row open when neither probe can answer', async () => {
      const clock = mkClock(SENT_AT);
      const closeOrder = vi.fn(async () => undefined);
      const getOrder = vi.fn(async () => {
        throw new Error('binance unreachable');
      }) as unknown as BinanceRestClient['getOrder'];
      const binance = fakeBinance({ cancelReplaceOrder: droppedSocket(clock), getOrder });
      const resolveOrderSlot = vi.fn(async () => null);
      const bindings = buildBindings({
        binance,
        persistence: { resolveOrderSlot, closeOrder },
      });
      const cancelLedger = createCancelLedger();
      const markUnresolved = vi.spyOn(cancelLedger, 'markUnresolved');
      const enqueueSymbolReconcile = vi.fn();

      const out = await replaceOrderHandler(
        timedDeps(bindings, clock, { cancelLedger, enqueueSymbolReconcile }),
        CTX,
        REPLACE,
      );

      expect(out).toMatchObject({ ok: false, retryable: true, phase: 'ambiguous' });
      expect(resolveOrderSlot).toHaveBeenCalledWith(42);
      expect(markUnresolved).toHaveBeenCalledWith('BTCUSDT', undefined);
      expect(enqueueSymbolReconcile).toHaveBeenCalledWith(
        expect.objectContaining({ cause: 'replace-order-failed' }),
      );
      // Fail closed in both halves: no successor row invented, and no row closed for an order the probe could not prove gone.
      expect(closeOrder).not.toHaveBeenCalled();
      expect(binance.placeOrder).not.toHaveBeenCalled();
    });
  });

  it('returns the Binance cause needed to count a structural replacement refusal', async () => {
    const cause = new BinanceApiError(
      { status: 400, code: -1013, msg: 'Filter failure: LOT_SIZE' },
      false,
      'rejected',
    );
    const binance = fakeBinance({
      cancelReplaceOrder: cancelReplaceOrderMock(async () => {
        throw cause;
      }),
    });

    const out = await replaceOrderHandler(buildDeps(buildBindings({ binance })), CTX, REPLACE);

    expect(out).toMatchObject({ ok: false, retryable: false, phase: 'rejected', cause });
    const outcome = { kind: 'result' as const, decision: REPLACE, result: out };
    const one = transitionOrderRefusal(null, outcome, CLOCK.nowMs());
    const two = transitionOrderRefusal(one.state, outcome, CLOCK.nowMs() + 1);
    expect(transitionOrderRefusal(two.state, outcome, CLOCK.nowMs() + 2)).toMatchObject({
      state: { count: 3 },
      event: 'tripped',
    });
  });

  it('treats an initial ORDERS-budget refusal as pre-call without reconciliation or cache mutation', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new OrderBudgetUnavailableError(10_000, 61_000);
    });
    const binance = fakeBinance({ cancelReplaceOrder });
    const resolveOrderSlot = vi.fn(async () => null);
    const bindings = buildBindings({ binance, persistence: { resolveOrderSlot } });
    const redis = fakeRedis();
    const enqueueSymbolReconcile = vi.fn();
    const deps = buildDeps(bindings, redis, { enqueueSymbolReconcile });

    const out = await replaceOrderHandler(deps, CTX, {
      ...REPLACE,
      intent: { ...REPLACE.intent, deferrable: true },
    });

    expect(out).toEqual({
      ok: false,
      retryable: true,
      phase: 'pre-call',
      deferred: true,
      reason: 'order-budget-exhausted window=10000ms wait=61000ms',
    });
    expect(resolveOrderSlot).not.toHaveBeenCalled();
    expect(enqueueSymbolReconcile).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('reports a naked pre-call refusal when the -2021 retry loses the ORDERS-budget race', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new BinanceApiError(
        { status: 409, code: -2021, msg: 'Order cancel-replace partially failed.' },
        false,
        'rejected',
      );
    });
    const placeOrder = placeOrderMock(async () => {
      throw new OrderBudgetUnavailableError(86_400_000, 90_000);
    });
    const binance = fakeBinance({ cancelReplaceOrder, placeOrder });
    const enqueueSymbolReconcile = vi.fn();

    const out = await replaceOrderHandler(
      buildDeps(buildBindings({ binance }), fakeRedis(), { enqueueSymbolReconcile }),
      CTX,
      { ...REPLACE, intent: { ...REPLACE.intent, deferrable: true } },
    );

    expect(out).toEqual({
      ok: false,
      retryable: true,
      phase: 'pre-call',
      reason: 'cancelReplace: naked after -2021, order budget exhausted window=86400000ms',
    });
    expect(enqueueSymbolReconcile).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'replace-order-failed' }),
    );
  });

  it('resolves a transport throw from the naked -2021 retry instead of letting it escape', async () => {
    const cause = new Error('socket reset after retry');
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new BinanceApiError(
        { status: 409, code: -2021, msg: 'Order cancel-replace partially failed.' },
        false,
        'rejected',
      );
    });
    const placeOrder = placeOrderMock(async () => {
      throw cause;
    });
    const getOrder = vi.fn(
      async () =>
        ({
          symbol: 'BTCUSDT',
          orderId: 44,
          clientOrderId: 'client-2',
          side: 'SELL',
          type: 'STOP_LOSS_LIMIT',
          price: '94.5',
          origQty: '0.001',
          executedQty: '0',
          status: 'NEW',
          stopPrice: '95',
          time: CLOCK.nowMs(),
          updateTime: CLOCK.nowMs(),
          cummulativeQuoteQty: '0',
        }) as never,
    );
    const binance = fakeBinance({ cancelReplaceOrder, placeOrder, getOrder });
    const persistTrackingOrder = vi.fn(async () => undefined);
    const bindings = buildBindings({ binance, persistence: { persistTrackingOrder } });

    const out = await replaceOrderHandler(buildDeps(bindings), CTX, REPLACE);

    expect(out).toMatchObject({ ok: false, retryable: false, phase: 'accepted', cause });
    expect(getOrder).toHaveBeenCalledWith({ symbol: 'BTCUSDT', origClientOrderId: 'client-2' });
    expect(persistTrackingOrder).toHaveBeenCalledWith(
      expect.objectContaining({ binanceOrderId: 44n, clientOrderId: 'client-2' }),
    );
  });

  it('does not reclassify a successful wire call when post-call weight recording fails', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(
      async () =>
        ({
          cancelResult: 'SUCCESS',
          newOrderResult: 'SUCCESS',
          cancelResponse: { orderId: 42, status: 'CANCELED' },
          newOrderResponse: { orderId: 43, clientOrderId: 'client-2', status: 'NEW' },
        }) as Awaited<ReturnType<BinanceRestClient['cancelReplaceOrder']>>,
    );
    const binance = fakeBinance({ cancelReplaceOrder });
    const resolveOrderSlot = vi.fn(async () => null);
    const persistOrder = persistOrderMock(async () => undefined);
    const bindings = buildBindings({
      binance,
      persistence: { persistOrder, resolveOrderSlot },
    });
    const redis = fakeRedis();
    (redis.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('redis unavailable'));
    const enqueueSymbolReconcile = vi.fn();
    const warn = vi.fn();
    const deps = buildDeps(bindings, redis, {
      enqueueSymbolReconcile,
      logger: { warn } as unknown as DecisionDeps['logger'],
    });

    const out = await replaceOrderHandler(deps, CTX, REPLACE);

    expect(cancelReplaceOrder).toHaveBeenCalledOnce();
    expect(persistOrder).toHaveBeenCalledWith(
      expect.objectContaining({ binanceOrderId: 43n }),
      expect.anything(),
    );
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringMatching(/open-orders:BTCUSDT$/),
      'remove',
      '42',
      expect.anything(),
    );
    expect(out).toEqual({ ok: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { profileId: PROFILE, err: expect.objectContaining({ message: 'redis unavailable' }) },
      'replace-order: could not record request weight after successful cancelReplace',
    );
    expect(resolveOrderSlot).not.toHaveBeenCalled();
    expect(enqueueSymbolReconcile).not.toHaveBeenCalled();
  });

  it('refuses a deferrable replacement at the request-weight limit before stamping or sending', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new Error('must not send');
    });
    const binance = fakeBinance({ cancelReplaceOrder });
    const bindings = buildBindings({ binance, weightLimit1m: 100 });
    const redis = fakeRedis();
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce('150');
    const placementOwner = { register: vi.fn(), ownerOf: vi.fn() };

    const out = await replaceOrderHandler(buildDeps(bindings, redis, { placementOwner }), CTX, {
      ...REPLACE,
      intent: { ...REPLACE.intent, deferrable: true },
    });

    expect(out).toEqual({
      ok: false,
      retryable: true,
      phase: 'pre-call',
      deferred: true,
      reason: 'weight-limit-throttle weight=150 limit=100',
    });
    expect(placementOwner.register).not.toHaveBeenCalled();
    expect(cancelReplaceOrder).not.toHaveBeenCalled();
  });

  it('uses the shared emergency notification for a classified replacement failure', async () => {
    const cause = new BinanceApiError(
      { status: 400, code: -1102, msg: 'mandatory parameter missing' },
      false,
      'rejected',
    );
    const binance = fakeBinance({
      cancelReplaceOrder: cancelReplaceOrderMock(async () => {
        throw cause;
      }),
    });
    const recordNotifierGap = vi.fn(async () => undefined);
    const bindings = buildBindings({
      binance,
      persistence: { listEnabledNotifiers: vi.fn(async () => []), recordNotifierGap },
    });

    const out = await replaceOrderHandler(buildDeps(bindings), CTX, REPLACE);

    expect(out).toMatchObject({ ok: false, cause });
    expect(recordNotifierGap).toHaveBeenCalledWith({
      topic: 'binance-emergency',
      symbol: 'BTCUSDT',
    });
  });

  it('does not report success when cancelReplace throws the duplicate-order classifier code', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new BinanceApiError(
        { status: 400, code: -2026, msg: 'Order cancel-replace failed.' },
        false,
        'rejected',
      );
    });
    const binance = fakeBinance({ cancelReplaceOrder });
    const enqueueSymbolReconcile = vi.fn();

    const out = await replaceOrderHandler(
      buildDeps(buildBindings({ binance }), fakeRedis(), { enqueueSymbolReconcile }),
      CTX,
      REPLACE,
    );

    expect(out).toEqual({
      ok: false,
      retryable: false,
      phase: 'accepted',
      reason: 'cancelReplace: classified ok without a successor body',
    });
    expect(enqueueSymbolReconcile).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'replace-order-failed' }),
    );
  });

  it('does not report success when the naked -2021 retry gets the duplicate-order classifier code', async () => {
    const cancelReplaceOrder = cancelReplaceOrderMock(async () => {
      throw new BinanceApiError(
        { status: 409, code: -2021, msg: 'Order cancel-replace partially failed.' },
        false,
        'rejected',
      );
    });
    const placeOrder = placeOrderMock(async () => {
      throw new BinanceApiError(
        { status: 400, code: -2026, msg: 'Order already exists.' },
        false,
        'rejected',
      );
    });
    const binance = fakeBinance({ cancelReplaceOrder, placeOrder });
    const enqueueSymbolReconcile = vi.fn();

    const out = await replaceOrderHandler(
      buildDeps(buildBindings({ binance }), fakeRedis(), { enqueueSymbolReconcile }),
      CTX,
      REPLACE,
    );

    expect(out).toEqual({
      ok: false,
      retryable: false,
      phase: 'accepted',
      reason: 'cancelReplace: naked after -2021, re-place reported an existing order',
    });
    expect(enqueueSymbolReconcile).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'replace-order-failed' }),
    );
  });
});
