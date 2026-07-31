import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type { OrderIntent, OrderParams } from '@app/strategy-core';
import { IdealFillModel } from '../src/ideal-fill.js';
import { SYMBOL, SYMBOL_INFO } from './_fixtures.js';

const buy: OrderIntent = { symbol: SYMBOL, side: 'BUY', reason: 'grid-buy', clientOrderId: 'b' };
const sell: OrderIntent = { symbol: SYMBOL, side: 'SELL', reason: 'grid-sell', clientOrderId: 's' };
const limit = (price: string, quantity: string): OrderParams => ({
  type: 'LIMIT',
  price,
  quantity,
});

// IdealFillModel.fill() always fills or rejects at placement, so the executor
// never rests one of its orders and thus never calls reserve(). Pin the contract
// directly: a SELL reserves base qty, a BUY reserves price*qty of quote (zero
// fee), matching the FillModel.reserve JSDoc's "consistent value" requirement.
describe('IdealFillModel.reserve', () => {
  it('reserves the base quantity for a SELL', () => {
    const r = new IdealFillModel().reserve({
      intent: sell,
      params: limit('100', '2'),
      symbolInfo: SYMBOL_INFO,
    });
    expect(r.asset).toBe(SYMBOL_INFO.baseAsset);
    expect(r.amount).toEqual(new Decimal('2'));
  });

  it('reserves price*qty of quote for a BUY (zero fee)', () => {
    const r = new IdealFillModel().reserve({
      intent: buy,
      params: limit('100', '2'),
      symbolInfo: SYMBOL_INFO,
    });
    expect(r.asset).toBe(SYMBOL_INFO.quoteAsset);
    expect(r.amount).toEqual(new Decimal('200'));
  });
});
