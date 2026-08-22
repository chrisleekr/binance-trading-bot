// The router is the only component that sees an order's PARTIALLY_FILLED
// reports: the fill-adopter returns early on anything but FILLED. Since
// Binance reports commission per trade and qty cumulatively, the order's total
// fee has to be accumulated here and handed to the adopter on the terminal
// report, or a multi-trade BUY under-nets its base-asset fee.

import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import type { FillAdopter } from 'executor/fill-adopter.js';
import type { ProfileManager } from 'profile-manager/profile-manager.js';
import type { TickJobData } from 'queues/job-payloads.js';

import { createEventRouter } from '../../src/event-router/event-router.js';

const noopLogger = pino({ level: 'silent' });

const USER_ID = asUserId('u1');
const ACCOUNT_ID = asAccountId('a1');
const PROFILE_ID = asProfileId('p1');
// A second profile on the SAME account. Binance issues one user-data stream per
// account, so both profiles are routed every execution report.
const SIBLING_PROFILE_ID = asProfileId('p2');
const SYMBOL = 'TSTUSDT';

const makeProfileManager = (): ProfileManager =>
  ({
    start: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    setSymbols: vi.fn(),
    profilesUsing: () => [],
    symbolsFor: () => [SYMBOL],
    userOf: () => USER_ID,
    operatorOf: () => USER_ID,
    accountOf: () => ACCOUNT_ID,
    shutdown: vi.fn(),
  }) as unknown as ProfileManager;

const makeRouter = () => {
  const adopt = vi.fn<FillAdopter['adopt']>(async () => undefined);
  const tickQueue = { add: vi.fn(async () => ({ id: 'j' })) } as unknown as Queue<TickJobData>;
  const redis = {
    set: vi.fn(async () => 'OK'),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 1),
    eval: vi.fn(async () => null),
  };
  const router = createEventRouter({
    tickQueue,
    redis: redis as unknown as Redis,
    profileManager: makeProfileManager(),
    indicatorComputer: { recompute: vi.fn() },
    fillAdopter: { adopt, reconcileDetachedFill: vi.fn() } as unknown as FillAdopter,
    backfillFills: vi.fn(async () => undefined),
    mergeAccount: vi.fn(async () => undefined),
    classifyOrder: vi.fn(async () => 'own' as const),
    logger: noopLogger,
    clock: { nowMs: () => 1 },
  });
  return { router, adopt, redis };
};

const report = (over: Record<string, unknown>) => ({
  kind: 'execution-report' as const,
  userId: USER_ID,
  profileId: PROFILE_ID,
  symbol: SYMBOL,
  orderId: 925411723,
  clientOrderId: 'tt-buy',
  side: 'BUY' as const,
  executionType: 'TRADE',
  priceLastFilled: '0.014970',
  qtyLastFilled: '0',
  cumQty: '0',
  cumQuoteQty: '0',
  commission: '0',
  commissionAsset: 'TST',
  tradeId: 0,
  orderStatus: 'PARTIALLY_FILLED',
  eventTimeMs: 0,
  ...over,
});

/** The single argument the adopter was called with. */
const adoptArg = (adopt: ReturnType<typeof makeRouter>['adopt']) =>
  adopt.mock.calls[0]?.[0] as unknown as Record<string, unknown> | undefined;

describe('event-router: order commission accumulation', () => {
  it("hands the adopter the SUM of an order's per-trade commissions on the terminal report", async () => {
    const { router, adopt } = makeRouter();

    await router.onUserEvent(
      report({ tradeId: 1, cumQty: '600', cumQuoteQty: '8.9820', commission: '0.6' }),
    );
    await router.onUserEvent(
      report({ tradeId: 2, cumQty: '1200', cumQuoteQty: '17.9640', commission: '0.6' }),
    );
    await router.onUserEvent(
      report({
        tradeId: 3,
        orderStatus: 'FILLED',
        cumQty: '1682.30',
        cumQuoteQty: '25.18403100',
        commission: '0.4823',
      }),
    );

    // Only the terminal report reaches the adopter, and it must carry the whole
    // order's fee (0.6 + 0.6 + 0.4823), not just the last trade's 0.4823.
    expect(adopt).toHaveBeenCalledTimes(3);
    const terminal = adopt.mock.calls[2]?.[0] as unknown as Record<string, unknown>;
    expect(terminal['commissions']).toEqual({ TST: '1.6823' });
    // Partials carry no order total; the adopter skips them anyway.
    expect(adoptArg(adopt)?.['commissions']).toBeUndefined();
  });

  it('does not double-subtract when Binance replays an already-seen partial', async () => {
    const { router, adopt } = makeRouter();

    const partial = report({ tradeId: 1, cumQty: '600', cumQuoteQty: '8.9820', commission: '0.6' });
    await router.onUserEvent(partial);
    // Reconnect replay of the same partial: same trade id, same fee.
    await router.onUserEvent(partial);
    await router.onUserEvent(
      report({
        tradeId: 2,
        orderStatus: 'FILLED',
        cumQty: '1682.30',
        cumQuoteQty: '25.18403100',
        commission: '1.0823',
      }),
    );

    const terminal = adopt.mock.calls[2]?.[0] as unknown as Record<string, unknown>;
    expect(terminal['commissions']).toEqual({ TST: '1.6823' });
  });

  it('hands every per-asset subtotal to the adopter for a mixed-fee order', async () => {
    const { router, adopt } = makeRouter();

    await router.onUserEvent(report({ tradeId: 1, commission: '0.00004', commissionAsset: 'BNB' }));
    await router.onUserEvent(
      report({
        tradeId: 2,
        orderStatus: 'FILLED',
        cumQty: '1682.30',
        cumQuoteQty: '25.18403100',
        commission: '0.9323',
        commissionAsset: 'TST',
      }),
    );

    const terminal = adopt.mock.calls[1]?.[0] as unknown as Record<string, unknown>;
    expect(terminal['commissions']).toEqual({ BNB: '0.00004', TST: '0.9323' });
  });

  it('does not expose a valid partial subtotal after a malformed fee report', async () => {
    const { router, adopt } = makeRouter();

    await router.onUserEvent(report({ tradeId: 1, commission: '0.5' }));
    await router.onUserEvent(
      report({
        tradeId: 2,
        orderStatus: 'FILLED',
        commission: 'NaN',
      }),
    );

    const terminal = adopt.mock.calls[1]?.[0] as unknown as Record<string, unknown>;
    expect(terminal['commissions']).toBeUndefined();
    expect(terminal['commission']).toBeUndefined();
  });

  it("carries a single-trade order's fee (its only TRADE report IS the terminal one)", async () => {
    const { router, adopt } = makeRouter();

    await router.onUserEvent(
      report({
        tradeId: 7,
        orderStatus: 'FILLED',
        cumQty: '1682.30',
        cumQuoteQty: '25.18403100',
        commission: '1.6823',
      }),
    );

    const terminal = adoptArg(adopt);
    expect(terminal?.['commissions']).toEqual({ TST: '1.6823' });
  });

  it('reports no fee when a CANCELED order left no trades', async () => {
    const { router, adopt } = makeRouter();

    await router.onUserEvent(
      report({ tradeId: -1, executionType: 'CANCELED', orderStatus: 'CANCELED', commission: '0' }),
    );

    expect(adoptArg(adopt)?.['commissions']).toBeUndefined();
  });

  it("does not leak one order's fee into the next order on the same symbol", async () => {
    const { router, adopt } = makeRouter();

    await router.onUserEvent(
      report({ tradeId: 1, orderStatus: 'FILLED', cumQty: '600', commission: '0.6' }),
    );
    await router.onUserEvent(
      report({ orderId: 925411724, tradeId: 2, orderStatus: 'FILLED', commission: '0.25' }),
    );

    expect((adopt.mock.calls[1]?.[0] as unknown as Record<string, unknown>)['commissions']).toEqual(
      { TST: '0.25' },
    );
  });

  it('gives every profile on the account the fee when one report fans out to all of them', async () => {
    const { router, adopt } = makeRouter();

    // Until an `orders` row commits, the ownership gate answers `own` for every
    // profile, so each one routes the same terminal report. A destructive read
    // would drain the fee into whichever profile ran first and leave the profile
    // that actually holds the position folding a gross quantity.
    const terminal = report({
      tradeId: 9,
      orderStatus: 'FILLED',
      cumQty: '1682.30',
      cumQuoteQty: '25.18403100',
      commission: '1.6823',
    });
    await router.onUserEvent(terminal);
    await router.onUserEvent({ ...terminal, profileId: SIBLING_PROFILE_ID });

    expect(adopt).toHaveBeenCalledTimes(2);
    for (const call of adopt.mock.calls) {
      const arg = call[0] as unknown as Record<string, unknown>;
      expect(arg['commissions']).toEqual({ TST: '1.6823' });
    }
  });

  it('folds every partial when they arrive out of trade-id order', async () => {
    const { router, adopt } = makeRouter();

    // The user-stream pool dispatches handlers without awaiting and the router
    // awaits twice before folding, so frame order is not delivery order here.
    await router.onUserEvent(
      report({ tradeId: 3, cumQty: '1200', cumQuoteQty: '17.9640', commission: '0.6' }),
    );
    await router.onUserEvent(
      report({ tradeId: 1, cumQty: '600', cumQuoteQty: '8.9820', commission: '0.6' }),
    );
    await router.onUserEvent(
      report({
        tradeId: 5,
        orderStatus: 'FILLED',
        cumQty: '1682.30',
        cumQuoteQty: '25.18403100',
        commission: '0.4823',
      }),
    );

    const terminal = adopt.mock.calls[2]?.[0] as unknown as Record<string, unknown>;
    expect(terminal['commissions']).toEqual({ TST: '1.6823' });
  });

  it('drops the order from the open-orders cache on the STP terminator EXPIRED_IN_MATCH', async () => {
    const { router, redis } = makeRouter();

    // Self-Trade Prevention terminates the order without a fill. N profiles
    // share one wallet, so a resting buy can match a sibling's sell; treating
    // this as non-terminal left the order in the cached list forever.
    //
    // The wire pairing is `x = TRADE_PREVENTION` with `X = EXPIRED_IN_MATCH`:
    // `EXPIRED_IN_MATCH` is an order STATUS and never an execution type, and
    // the commission accumulator branches on the execution type, so the wrong
    // fixture would teach it a value Binance never sends.
    await router.onUserEvent(
      report({
        tradeId: -1,
        executionType: 'TRADE_PREVENTION',
        orderStatus: 'EXPIRED_IN_MATCH',
        commission: '0',
      }),
    );

    // `removeOpenOrder` drives the cache mutation through a Lua script; the
    // `remove` op is what distinguishes it from a partial-fill patch.
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.any(String),
      'remove',
      '925411723',
      expect.any(String),
    );
  });
});
