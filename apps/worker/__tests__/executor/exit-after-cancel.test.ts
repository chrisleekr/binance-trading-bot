// THE regression test for the funding pre-flight.
//
// A momentum exit is ONE batch of two decisions: [cancel our resting protective
// stop, place the MARKET SELL that flattens the position]. Our own resting
// STOP_LOSS_LIMIT LOCKS the base on Binance, so the cached wallet snapshot — which
// is only refreshed asynchronously off the user stream — reports free = 0 for the
// entire position while that stop rests. A funding pre-flight that judged the SELL
// against that snapshot would call the EXIT unfundable and never send it: the
// position would ride out the drop unsold, and the operator's force-sell override
// would be settled as `rejected` rather than re-armed.
//
// The cancel that runs microseconds earlier in the same batch is what makes the
// base free. The ledger carries that fact to the place.

import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import type { BinanceRestClient } from '@app/binance';
import type { NotifyProviderRegistry } from '@app/notify';
import type { Decision, ExecutorContext, StrategyRegistry } from '@app/strategy-core';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';

import {
  createLiveExecutor,
  type ProfileExecutorBindings,
} from '../../src/executor/live-executor.js';
import { buildAccountInfoKey } from '../../src/executor/redis-namespace.js';
import type { ProfilePersistence } from '../../src/profile-bindings/persistence.js';

const USER = asUserId('00000000-0000-0000-0000-0000000000aa');
const PROFILE = asProfileId('00000000-0000-0000-0000-0000000000bb');
const ACCOUNT = asAccountId('00000000-0000-0000-0000-0000000000cc');
const CTX: ExecutorContext = { userId: USER, profileId: PROFILE, clock: { nowMs: () => 0 } };

// The position, entirely locked by our own resting stop: free 0, locked 189.87.
const ACCOUNT_INFO = JSON.stringify({
  balances: {
    ENA: { free: '0.00000000', locked: '189.87000000' },
    USDT: { free: '25.00000000', locked: '0.00000000' },
  },
});

// Trailing-trade's grid buy runs the SAME cancel-then-place shape on the QUOTE side:
// it cancels its stale resting BUYs and places the replacement in one decision array.
// A resting BUY locks the cash it would spend, so the cached snapshot reports the
// quote as spent right up until the cancel lands.
const CANCEL_OUR_BUY: Decision = {
  type: 'cancel-order',
  orderId: 4243,
  reason: 'grid-buy-superseded',
  symbol: 'ENAUSDT',
};
const GRID_BUY: Decision = {
  type: 'place-order',
  intent: { symbol: 'ENAUSDT', side: 'BUY', reason: 'grid-buy', clientOrderId: 'tt-abc-b' },
  params: { type: 'LIMIT', quantity: '300', price: '0.30', timeInForce: 'GTC' },
};

const CANCEL_OUR_STOP: Decision = {
  type: 'cancel-order',
  orderId: 4242,
  reason: 'momentum-protective-stop-superseded',
  symbol: 'ENAUSDT',
};
const EXIT_SELL: Decision = {
  type: 'place-order',
  intent: { symbol: 'ENAUSDT', side: 'SELL', reason: 'exit', clientOrderId: 'mo-abc-x' },
  params: { type: 'MARKET', quantity: '189.87' },
};

const fakeRedis = (): Redis =>
  ({
    set: vi.fn(async () => 'OK'),
    get: vi.fn(async (key: string) =>
      key === buildAccountInfoKey(ACCOUNT, PROFILE) ? ACCOUNT_INFO : null,
    ),
    del: vi.fn(async () => 0),
    incr: vi.fn(async () => 1),
    sadd: vi.fn(async () => 1),
    sismember: vi.fn(async () => 0),
    pexpire: vi.fn(async () => 1),
    multi: vi.fn(() => {
      const pipeline = {
        publish: vi.fn(() => pipeline),
        xadd: vi.fn(() => pipeline),
        sadd: vi.fn(() => pipeline),
        pexpire: vi.fn(() => pipeline),
        exec: vi.fn(async () => []),
      };
      return pipeline;
    }),
  }) as unknown as Redis;

const buildBindings = (
  binance: BinanceRestClient,
  persistence: Partial<ProfilePersistence> = {},
): ProfileExecutorBindings =>
  ({
    mode: 'live',
    binance,
    weightLimit1m: 1200,
    quoteAsset: 'USDT',
    persistence: {
      persistOrder: vi.fn(async () => undefined),
      persistTrackingOrder: vi.fn(async () => undefined),
      closeOrder: vi.fn(async () => undefined),
      recordBookkeepingFailure: vi.fn(async () => undefined),
      listEnabledNotifiers: vi.fn(async () => []),
      recordNotifierGap: vi.fn(async () => undefined),
      // The row of the stop we are cancelling: a SELL still holding the whole
      // position. This is what the release credit is computed from.
      resolveOrderSlot: vi.fn(async () => ({
        symbol: 'ENAUSDT',
        intent: 'protective-stop',
        side: 'SELL',
        remainingQty: '189.87',
      })),
      ...persistence,
    },
  }) as unknown as ProfileExecutorBindings;

const buildExecutor = (bindings: ProfileExecutorBindings, redis: Redis) =>
  createLiveExecutor({
    redis,
    notifyRegistry: { get: () => undefined, list: () => [] } as unknown as NotifyProviderRegistry,
    strategies: {} as unknown as StrategyRegistry,
    logger: pino({ level: 'silent' }),
    resolveProfile: async () => bindings,
    notifierGapThrottle: { allow: async () => true },
  });

const fakeBinance = (over: Partial<BinanceRestClient> = {}): BinanceRestClient =>
  ({
    placeOrder: vi.fn(async () => ({ orderId: 77, clientOrderId: 'mo-abc-x', status: 'FILLED' })),
    cancelOrder: vi.fn(async () => ({
      orderId: 4242,
      status: 'CANCELED',
      transactTime: 1_700_000_000_000,
    })),
    ctx: () => ({ weightUsed1m: 10, mode: 'live' as const }),
    ...over,
  }) as unknown as BinanceRestClient;

describe('applyAll — an exit whose base is locked by the stop it just cancelled', () => {
  it('sends the SELL: the cancel in the same batch released the base', async () => {
    const binance = fakeBinance();
    const redis = fakeRedis();

    const applied = await buildExecutor(buildBindings(binance), redis).applyAll(CTX, ACCOUNT, [
      CANCEL_OUR_STOP,
      EXIT_SELL,
    ]);

    // The money assertion. A stale snapshot must never veto the exit.
    expect(binance.placeOrder).toHaveBeenCalledOnce();
    expect(applied.every((a) => a.result.ok)).toBe(true);
  });

  it('still refuses the SELL when NO cancel released the base (the storm case survives)', async () => {
    // Same wallet, but the batch carries only the placement: the base is locked by
    // an order we did not cancel (the adopted orphan stop), so the SELL cannot fill
    // however many times we send it.
    const binance = fakeBinance();
    const applied = await buildExecutor(buildBindings(binance), fakeRedis()).applyAll(
      CTX,
      ACCOUNT,
      [EXIT_SELL],
    );

    expect(binance.placeOrder).not.toHaveBeenCalled();
    expect(applied[0]?.result).toMatchObject({ ok: false, retryable: false, phase: 'pre-call' });
  });

  it('a cancel whose released size is unknown declines to judge, rather than veto the exit', async () => {
    // The cancelled order's local row carries an ACK-shape `raw` with no
    // quantities. Something WAS released; we just cannot size it. Refusing here
    // would be the same lost exit, so the check stands down.
    const binance = fakeBinance();
    const bindings = buildBindings(binance, {
      resolveOrderSlot: vi.fn(async () => ({
        symbol: 'ENAUSDT',
        intent: 'protective-stop',
        side: 'SELL',
        remainingQty: null,
      })) as unknown as ProfilePersistence['resolveOrderSlot'],
    });

    await buildExecutor(bindings, fakeRedis()).applyAll(CTX, ACCOUNT, [CANCEL_OUR_STOP, EXIT_SELL]);

    expect(binance.placeOrder).toHaveBeenCalledOnce();
  });

  it('a FAILED cancel releases nothing — and the chain-break keeps the SELL off the wire anyway', async () => {
    const binance = fakeBinance({
      cancelOrder: vi.fn(async () => {
        throw new Error('binance unreachable');
      }),
    } as unknown as Partial<BinanceRestClient>);

    const applied = await buildExecutor(buildBindings(binance), fakeRedis()).applyAll(
      CTX,
      ACCOUNT,
      [CANCEL_OUR_STOP, EXIT_SELL],
    );

    expect(binance.placeOrder).not.toHaveBeenCalled();
    expect(applied[0]?.result.ok).toBe(false);
  });

  it('sends the grid BUY: the cancelled BUY in the same batch released the quote', async () => {
    // 300 x 0.30 = 90 USDT needed; the snapshot says 25 free because the resting BUY
    // we just cancelled was holding the rest. Judging against it would drop the grid
    // entry AND fire an unfundable alert — which, throttled per (profile, symbol) for
    // an hour, would then SUPPRESS a genuine base-side alert.
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => ({ orderId: 88, clientOrderId: 'tt-abc-b', status: 'NEW' })),
      cancelOrder: vi.fn(async () => ({
        orderId: 4243,
        status: 'CANCELED',
        transactTime: 1_700_000_000_000,
      })),
    } as unknown as Partial<BinanceRestClient>);
    const bindings = buildBindings(binance, {
      // The cancelled order's row: a resting BUY of 250 @ 0.30 ⇒ 75 USDT handed back.
      resolveOrderSlot: vi.fn(async () => ({
        symbol: 'ENAUSDT',
        intent: 'grid-buy',
        side: 'BUY',
        remainingQty: '250',
        price: '0.30',
      })) as unknown as ProfilePersistence['resolveOrderSlot'],
    });

    await buildExecutor(bindings, fakeRedis()).applyAll(CTX, ACCOUNT, [CANCEL_OUR_BUY, GRID_BUY]);

    expect(binance.placeOrder).toHaveBeenCalledOnce();
  });

  it('a cancelled BUY with no readable price releases an UNKNOWN amount of quote, not zero', async () => {
    // Crediting a silent zero would veto a fundable order; declining to judge lets
    // Binance — the authority — answer.
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => ({ orderId: 89, clientOrderId: 'tt-abc-b', status: 'NEW' })),
      cancelOrder: vi.fn(async () => ({
        orderId: 4243,
        status: 'CANCELED',
        transactTime: 1_700_000_000_000,
      })),
    } as unknown as Partial<BinanceRestClient>);
    const bindings = buildBindings(binance, {
      resolveOrderSlot: vi.fn(async () => ({
        symbol: 'ENAUSDT',
        intent: 'grid-buy',
        side: 'BUY',
        remainingQty: '250',
        price: null,
      })) as unknown as ProfilePersistence['resolveOrderSlot'],
    });

    await buildExecutor(bindings, fakeRedis()).applyAll(CTX, ACCOUNT, [CANCEL_OUR_BUY, GRID_BUY]);

    expect(binance.placeOrder).toHaveBeenCalledOnce();
  });

  it('a BUY the wallet genuinely cannot fund is still refused when nothing was cancelled', async () => {
    const binance = fakeBinance();
    const applied = await buildExecutor(buildBindings(binance), fakeRedis()).applyAll(
      CTX,
      ACCOUNT,
      [GRID_BUY],
    );

    expect(binance.placeOrder).not.toHaveBeenCalled();
    expect(applied[0]?.result).toMatchObject({ ok: false, phase: 'pre-call' });
  });

  it('a cancel whose local row is unreadable poisons BOTH assets, so neither side is misjudged', async () => {
    // We know something came back; we do not know WHICH asset. Defaulting to the base
    // would leave a cancelled BUY's quote uncredited and veto the replacement BUY that
    // rides in the same batch. Declining to judge either asset is the honest reading.
    const binance = fakeBinance({
      placeOrder: vi.fn(async () => ({ orderId: 90, clientOrderId: 'tt-abc-b', status: 'NEW' })),
      cancelOrder: vi.fn(async () => ({
        orderId: 4243,
        status: 'CANCELED',
        transactTime: 1_700_000_000_000,
      })),
    } as unknown as Partial<BinanceRestClient>);
    const bindings = buildBindings(binance, {
      // No local row for the cancelled order (placed but never persisted).
      resolveOrderSlot: vi.fn(
        async () => null,
      ) as unknown as ProfilePersistence['resolveOrderSlot'],
    });

    await buildExecutor(bindings, fakeRedis()).applyAll(CTX, ACCOUNT, [CANCEL_OUR_BUY, GRID_BUY]);

    // The quote (90 USDT needed, 25 shown free) is unjudgeable, so the order goes.
    expect(binance.placeOrder).toHaveBeenCalledOnce();
  });
});
