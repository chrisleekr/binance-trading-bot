// The digest is what an operator reads to answer "why that price, why that
// size, why nothing at all". Every assertion here is about a fact that would be
// missing or wrong at exactly the moment someone needs it.

import { describe, expect, it } from 'vitest';

import { Decimal } from '@app/money';

import { tickInputDigest } from '../../src/tick/tick-input-digest.js';

import type { TickInput } from '@app/strategy-core';

type AnyTickInput = TickInput<unknown, unknown, Readonly<Record<string, unknown>>>;

const balance = (free: string, locked: string) => ({
  asset: 'x',
  free: new Decimal(free),
  locked: new Decimal(locked),
});

const makeInput = (overrides: Record<string, unknown> = {}): AnyTickInput =>
  ({
    market: {
      currentPrice: '27000.10',
      symbolInfo: { baseAsset: 'BTC', quoteAsset: 'USDT' },
    },
    account: {
      readable: true,
      balances: {
        BTC: balance('0.5', '0.1'),
        USDT: balance('1200.25', '0'),
        // A wallet holds every asset the operator owns; the digest is paid for
        // on every tick, so carrying them all is the cost this shape avoids.
        ETH: balance('9', '9'),
      },
    },
    openOrders: [],
    limits: { headroomBps: 8_400 },
    ...overrides,
  }) as unknown as AnyTickInput;

describe('tickInputDigest', () => {
  it('carries only the two assets this symbol trades', () => {
    const digest = tickInputDigest(makeInput());

    expect(Object.keys(digest.balances)).toEqual(['BTC', 'USDT']);
    expect(digest.balances['BTC']).toEqual({ free: '0.5', locked: '0.1' });
    expect(digest.balances['USDT']).toEqual({ free: '1200.25', locked: '0' });
  });

  it('records a null balance rather than throwing when the wallet has no row', () => {
    // Binance omits zero balances, so a symbol whose base has never been held
    // has no row at all. Throwing here would kill the tick over telemetry.
    const digest = tickInputDigest(
      makeInput({ account: { readable: true, balances: { USDT: balance('10', '0') } } }),
    );

    expect(digest.balances['BTC']).toBeNull();
    expect(digest.balances['USDT']).toEqual({ free: '10', locked: '0' });
  });

  it('carries accountReadable:false, which is the only thing separating fail-closed from idle', () => {
    const digest = tickInputDigest(makeInput({ account: { readable: false, balances: {} } }));

    expect(digest.accountReadable).toBe(false);
    expect(digest.balances).toEqual({ BTC: null, USDT: null });
  });

  it('reduces open orders to the fields a cancel-replace turns on', () => {
    const digest = tickInputDigest(
      makeInput({
        openOrders: [
          {
            orderId: 41,
            clientOrderId: 'tt-buy-1',
            side: 'BUY',
            status: 'NEW',
            price: '26900.00',
            origQty: '0.01',
            executedQty: '0',
            // Present on the real row and deliberately not carried: the digest
            // is paid for on every tick in Redis memory.
            icebergQty: '0',
            time: 1,
          },
        ],
      }),
    );

    expect(digest.openOrders).toEqual([
      {
        orderId: 41,
        clientOrderId: 'tt-buy-1',
        side: 'BUY',
        status: 'NEW',
        price: '26900.00',
        origQty: '0.01',
        executedQty: '0',
      },
    ]);
  });

  it('carries the price and the request-weight headroom the decision was taken under', () => {
    const digest = tickInputDigest(makeInput());

    expect(digest.price).toBe('27000.10');
    expect(digest.headroomBps).toBe(8_400);
  });
});
