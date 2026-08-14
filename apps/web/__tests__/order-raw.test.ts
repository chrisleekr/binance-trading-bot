import { describe, expect, it } from 'vitest';

import { orderDisplayPrice, orderQty } from '../src/features/symbol/lib/order-raw.js';

import type { OrderResponse } from '@app/contracts';

const base: OrderResponse = {
  id: '00000000-0000-4000-8000-000000000001',
  symbol: 'BTCUSDT',
  side: 'BUY',
  intent: 'grid-buy',
  binanceOrderId: '1',
  clientOrderId: 'cli-1',
  status: 'FILLED',
  currentGridTradeIndex: 0,
  raw: {},
  createdAt: '2026-05-18T10:00:00.000Z',
  updatedAt: '2026-05-18T10:00:00.000Z',
  closedAt: null,
};

describe('raw-payload narrowing', () => {
  it('reads origQty and price from the raw payload', () => {
    const o = { ...base, raw: { origQty: '0.5', price: '68000' } };
    expect(orderQty(o)).toBe('0.5');
    expect(orderDisplayPrice(o)).toBe('68,000.00');
  });

  it('falls back to an em-dash when the field is absent', () => {
    expect(orderQty({ ...base, raw: { price: '68000' } })).toBe('—');
    expect(orderDisplayPrice({ ...base, raw: { origQty: '0.5' } })).toBe('—');
  });

  it('falls back to an em-dash when raw is not an object', () => {
    expect(orderQty({ ...base, raw: null })).toBe('—');
    expect(orderDisplayPrice({ ...base, raw: 'unexpected' })).toBe('—');
  });

  it('falls back to an em-dash when a field is the wrong type', () => {
    // A non-string origQty/price must not leak through the string contract.
    expect(orderQty({ ...base, raw: { origQty: 123 } })).toBe('—');
    expect(orderDisplayPrice({ ...base, raw: { price: 68000 } })).toBe('—');
  });
});

describe('orderDisplayPrice', () => {
  it('renders the limit price for LIMIT orders', () => {
    const o = { ...base, raw: { type: 'LIMIT', price: '68000', origQty: '0.5' } };
    expect(orderDisplayPrice(o)).toBe('68,000.00');
  });

  it('renders MKT @ avg for a filled MARKET order with executed + cummulative quote', () => {
    const o = {
      ...base,
      status: 'FILLED',
      raw: {
        type: 'MARKET',
        price: '0',
        executedQty: '0.5',
        cummulativeQuoteQty: '34000',
      },
    };
    // 34000 / 0.5 = 68000 → formatPrice() emits `68,000.00` (>=1 carries 2dp).
    expect(orderDisplayPrice(o)).toBe('MKT @ 68,000.00');
  });

  it('renders bare MKT for a MARKET order without usable fill totals', () => {
    expect(orderDisplayPrice({ ...base, raw: { type: 'MARKET', price: '0' } })).toBe('MKT');
    expect(
      orderDisplayPrice({
        ...base,
        raw: { type: 'MARKET', price: '0', executedQty: '0', cummulativeQuoteQty: '0' },
      }),
    ).toBe('MKT');
    expect(
      orderDisplayPrice({
        ...base,
        raw: { type: 'MARKET', price: '0', executedQty: '0.5', cummulativeQuoteQty: '0' },
      }),
    ).toBe('MKT');
  });

  it('renders an em-dash when raw is not an object', () => {
    expect(orderDisplayPrice({ ...base, raw: null })).toBe('—');
  });

  it('renders an em-dash for a LIMIT order missing the price field', () => {
    expect(orderDisplayPrice({ ...base, raw: { type: 'LIMIT', origQty: '0.5' } })).toBe('—');
  });

  it('still renders MKT @ avg for a PARTIALLY_FILLED MARKET order', () => {
    const o = {
      ...base,
      status: 'PARTIALLY_FILLED',
      raw: {
        type: 'MARKET',
        price: '0',
        executedQty: '0.25',
        cummulativeQuoteQty: '17000',
      },
    };
    expect(orderDisplayPrice(o)).toBe('MKT @ 68,000.00');
  });

  it('labels an exchange-native trailing stop instead of printing its zero price', () => {
    // A STOP_LOSS placed with a trailingDelta carries no limit leg, so Binance
    // reports `price: "0"`. Rendering that tells the operator their protective
    // stop sits at a price of nothing.
    const o = { ...base, raw: { type: 'STOP_LOSS', price: '0', origQty: '0.5' } };
    expect(orderDisplayPrice(o)).toBe('TRAIL');
  });

  it('handles sub-1 dust prices (e.g. SHIB) without dropping to bare MKT', () => {
    // 2.8 / 100_000 = 2.8e-5 — sub-1 path uses up to 8 fraction digits.
    const o = {
      ...base,
      status: 'FILLED',
      raw: {
        type: 'MARKET',
        price: '0',
        executedQty: '100000',
        cummulativeQuoteQty: '2.8',
      },
    };
    expect(orderDisplayPrice(o)).toBe('MKT @ 0.000028');
  });
});
