import { describe, expect, it } from 'vitest';
import type { SymbolFilters } from '@app/strategy-core';
import type { ManualOrderRequest } from '@app/contracts';

import {
  computeFirstBuyQuantity,
  computeManualOrderQuantity,
  computeSellQuantity,
} from '../src/quantity.js';

// Loose filters so only the min-purchase floor (not Binance lot/notional
// filters) decides the outcome under test.
const FILTERS: SymbolFilters = {
  minNotional: '5',
  tickSize: '0.01',
  stepSize: '0.001',
  minQty: '0.001',
  maxQty: '1000000',
  minPrice: '0',
  maxPrice: '1000000',
};

/** Assert a quantity result and return its numeric value. */
const qty = (result: ReturnType<typeof computeFirstBuyQuantity>): number => {
  expect(result).toHaveProperty('quantity');
  return Number((result as { quantity: string }).quantity);
};

describe('computeFirstBuyQuantity — minPurchaseAmount floor', () => {
  it('ignores the floor when omitted (single-buy / no-floor grid)', () => {
    expect(qty(computeFirstBuyQuantity('100', '100', FILTERS))).toBe(1);
  });

  it('treats an empty floor as no floor', () => {
    expect(qty(computeFirstBuyQuantity('100', '100', FILTERS, ''))).toBe(1);
  });

  it('returns the quantity when the budget notional meets the floor', () => {
    expect(qty(computeFirstBuyQuantity('100', '100', FILTERS, '50'))).toBe(1);
  });

  it('skips with min-purchase when the budget cannot meet the floor', () => {
    expect(computeFirstBuyQuantity('100', '100', FILTERS, '150')).toEqual({
      skip: 'min-purchase',
    });
  });

  it("treats '0' floor as disabled", () => {
    expect(qty(computeFirstBuyQuantity('100', '100', FILTERS, '0'))).toBe(1);
  });

  it('skips with invalid-filters on a malformed floor', () => {
    expect(computeFirstBuyQuantity('100', '100', FILTERS, 'abc')).toEqual({
      skip: 'invalid-filters',
    });
  });

  it('skips with invalid-filters on a malformed price/budget wire value', () => {
    // A bad snapshot price must skip, not throw (documented skip-not-throw).
    expect(computeFirstBuyQuantity('100', 'oops', FILTERS)).toEqual({ skip: 'invalid-filters' });
    expect(computeFirstBuyQuantity('oops', '100', FILTERS)).toEqual({ skip: 'invalid-filters' });
  });

  it('skips with invalid-filters when the price is non-positive', () => {
    expect(computeFirstBuyQuantity('100', '0', FILTERS)).toEqual({ skip: 'invalid-filters' });
  });
});

// A filter set that parseFilters rejects (negative step) so the parsed===null
// guards are exercised on the manual-order and sell paths.
const BAD_FILTERS: SymbolFilters = { ...FILTERS, stepSize: '-1' };

// `ManualOrderRequest` is schema-validated at the API boundary, but the worker
// passes the payload to this helper without re-parsing, so a malformed wire
// value can reach it. The casts below model that unvalidated arrival.
const asPayload = (p: unknown): ManualOrderRequest => p as ManualOrderRequest;

describe('computeManualOrderQuantity', () => {
  it('rejects an unsupported order type', () => {
    expect(
      computeManualOrderQuantity(
        asPayload({ side: 'BUY', type: 'STOP_LOSS_LIMIT', quantity: '1' }),
        '100',
        FILTERS,
      ),
    ).toEqual({ skip: 'unsupported-type' });
  });

  it('requires a price for a LIMIT order', () => {
    expect(
      computeManualOrderQuantity(
        asPayload({ side: 'BUY', type: 'LIMIT', quantity: '1' }),
        '100',
        FILTERS,
      ),
    ).toEqual({ skip: 'missing-price' });
    expect(
      computeManualOrderQuantity(
        asPayload({ side: 'BUY', type: 'LIMIT', quantity: '1', price: '  ' }),
        '100',
        FILTERS,
      ),
    ).toEqual({ skip: 'missing-price' });
  });

  it('skips with invalid-filters on a malformed LIMIT price', () => {
    expect(
      computeManualOrderQuantity(
        asPayload({ side: 'BUY', type: 'LIMIT', quantity: '1', price: 'abc' }),
        '100',
        FILTERS,
      ),
    ).toEqual({ skip: 'invalid-filters' });
  });

  it('skips with invalid-filters on a malformed explicit quantity', () => {
    expect(
      computeManualOrderQuantity(
        asPayload({ side: 'BUY', type: 'MARKET', quantity: 'abc' }),
        '100',
        FILTERS,
      ),
    ).toEqual({ skip: 'invalid-filters' });
  });

  it('skips with invalid-filters on a malformed quoteAmount', () => {
    expect(
      computeManualOrderQuantity(
        asPayload({ side: 'BUY', type: 'MARKET', quoteAmount: 'abc' }),
        '100',
        FILTERS,
      ),
    ).toEqual({ skip: 'invalid-filters' });
  });

  it('skips with missing-amount when neither quantity nor quoteAmount is set', () => {
    expect(
      computeManualOrderQuantity(asPayload({ side: 'BUY', type: 'MARKET' }), '100', FILTERS),
    ).toEqual({ skip: 'missing-amount' });
  });

  it('skips with invalid-filters when the reference price is non-positive', () => {
    expect(
      computeManualOrderQuantity(
        asPayload({ side: 'BUY', type: 'MARKET', quantity: '1' }),
        '0',
        FILTERS,
      ),
    ).toEqual({ skip: 'invalid-filters' });
  });

  it('skips with invalid-filters when the symbol filters are unparseable', () => {
    expect(
      computeManualOrderQuantity(
        asPayload({ side: 'BUY', type: 'MARKET', quantity: '1' }),
        '100',
        BAD_FILTERS,
      ),
    ).toEqual({ skip: 'invalid-filters' });
  });

  it('derives quantity from quoteAmount at the market price', () => {
    const result = computeManualOrderQuantity(
      asPayload({ side: 'BUY', type: 'MARKET', quoteAmount: '100' }),
      '100',
      FILTERS,
    );
    expect(Number((result as { quantity: string }).quantity)).toBe(1);
  });
});

describe('computeSellQuantity', () => {
  it('skips with invalid-filters on a malformed balance/price wire value', () => {
    expect(computeSellQuantity('oops', '100', FILTERS)).toEqual({ skip: 'invalid-filters' });
  });

  it('skips with no-balance when the free balance is zero', () => {
    expect(computeSellQuantity('0', '100', FILTERS)).toEqual({ skip: 'no-balance' });
  });

  it('skips with invalid-filters when the price is non-positive', () => {
    expect(computeSellQuantity('1', '0', FILTERS)).toEqual({ skip: 'invalid-filters' });
  });

  it('returns a step-rounded sell quantity from the free balance', () => {
    const result = computeSellQuantity('2.5', '100', FILTERS);
    expect(Number((result as { quantity: string }).quantity)).toBe(2.5);
  });
});
