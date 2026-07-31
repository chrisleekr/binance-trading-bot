import { describe, expect, it } from 'vitest';

import {
  ManualOrderAllRequest,
  ManualOrderRequest,
  ManualOverridePayload,
} from '../src/manual-orders.js';

describe('ManualOrderAllRequest', () => {
  it('accepts a marketQuantity-only bulk request', () => {
    const r = ManualOrderAllRequest.safeParse({
      quote: 'USDT',
      side: 'sell',
      marketQuantity: '0.5',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a quoteAmount-only bulk request', () => {
    const r = ManualOrderAllRequest.safeParse({ quote: 'USDT', side: 'buy', quoteAmount: '50' });
    expect(r.success).toBe(true);
  });

  it('rejects a bulk request with neither amount (would drop every per-symbol order)', () => {
    const r = ManualOrderAllRequest.safeParse({ quote: 'USDT', side: 'sell' });
    expect(r.success).toBe(false);
  });

  it('rejects a bulk request with both amounts (ambiguous)', () => {
    const r = ManualOrderAllRequest.safeParse({
      quote: 'USDT',
      side: 'sell',
      marketQuantity: '0.5',
      quoteAmount: '50',
    });
    expect(r.success).toBe(false);
  });
});

describe('ManualOrderRequest', () => {
  it('accepts a MARKET BUY with quoteAmount', () => {
    const r = ManualOrderRequest.safeParse({
      side: 'BUY',
      type: 'MARKET',
      quoteAmount: '15',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a MARKET BUY with quantity', () => {
    const r = ManualOrderRequest.safeParse({
      side: 'BUY',
      type: 'MARKET',
      quantity: '0.001',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a MARKET SELL with quoteAmount', () => {
    const r = ManualOrderRequest.safeParse({
      side: 'SELL',
      type: 'MARKET',
      quoteAmount: '15',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a MARKET SELL with quantity', () => {
    const r = ManualOrderRequest.safeParse({
      side: 'SELL',
      type: 'MARKET',
      quantity: '0.00019',
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown fields like `amount` and `sizeBy` instead of silently stripping them', () => {
    const r = ManualOrderRequest.safeParse({
      side: 'SELL',
      type: 'MARKET',
      sizeBy: 'qty',
      amount: '0.00019',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error)).toContain('sizeBy');
    }
  });

  it('rejects a body that supplies neither quantity nor quoteAmount', () => {
    const r = ManualOrderRequest.safeParse({
      side: 'BUY',
      type: 'MARKET',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error)).toContain('one of');
    }
  });

  it('rejects a body that supplies BOTH quantity and quoteAmount (ambiguous sizing)', () => {
    const r = ManualOrderRequest.safeParse({
      side: 'BUY',
      type: 'MARKET',
      quantity: '0.001',
      quoteAmount: '15',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error)).toContain('mutually exclusive');
    }
  });

  it('rejects a non-positive amount (zod-level guard before refine fires)', () => {
    const r = ManualOrderRequest.safeParse({
      side: 'BUY',
      type: 'MARKET',
      quoteAmount: '0',
    });
    expect(r.success).toBe(false);
  });

  it('accepts a LIMIT order with explicit price', () => {
    const r = ManualOrderRequest.safeParse({
      side: 'BUY',
      type: 'LIMIT',
      quantity: '0.001',
      price: '50000',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a LIMIT order with no price (would 202 then fail at Binance)', () => {
    const r = ManualOrderRequest.safeParse({
      side: 'BUY',
      type: 'LIMIT',
      quoteAmount: '10',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error)).toContain('price` is required');
    }
  });

  it('does not require price for a MARKET order', () => {
    const r = ManualOrderRequest.safeParse({
      side: 'SELL',
      type: 'MARKET',
      quantity: '0.001',
    });
    expect(r.success).toBe(true);
  });

  it.each(['STOP_LOSS_LIMIT', 'TAKE_PROFIT_LIMIT'])(
    'rejects %s, an order type this API cannot fulfil end-to-end',
    (type) => {
      const r = ManualOrderRequest.safeParse({
        side: 'SELL',
        type,
        quantity: '0.0001',
        price: '50000',
      });
      expect(r.success).toBe(false);
    },
  );

  it('round-trips inside ManualOverridePayload (discriminatedUnion still parses the strict+refined payload)', () => {
    const wire = {
      kind: 'manual-order',
      overrideActionId: '00000000-0000-4000-8000-000000000001',
      payload: { side: 'SELL', type: 'MARKET', quantity: '0.001' },
    };
    const r = ManualOverridePayload.safeParse(wire);
    expect(r.success).toBe(true);
    if (r.success && r.data.kind === 'manual-order') {
      expect(r.data.payload.quantity).toBe('0.001');
      expect(r.data.payload.side).toBe('SELL');
    }
  });

  it('defaults type to MARKET when omitted', () => {
    const r = ManualOrderRequest.safeParse({
      side: 'BUY',
      quoteAmount: '15',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.type).toBe('MARKET');
    }
  });
});
