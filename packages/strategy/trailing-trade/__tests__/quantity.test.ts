import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import { applyEntryStopFloor, minSellableQuantityAtStop, parseFilters } from '@app/strategy-core';
import type { EntryStopFloor, SymbolFilters } from '@app/strategy-core';
import type { ManualOrderRequest } from '@app/contracts';

import {
  computeFirstBuyQuantity,
  computeManualOrderQuantity,
  computeSellQuantity,
  ttEntryStopFloor,
} from '../src/quantity.js';
import { defaultTTConfig, type TTConfig } from '../src/schema.js';

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

const ZEC_FILTERS: SymbolFilters = {
  ...FILTERS,
  minNotional: '0.0001',
  tickSize: '0.000001',
  stepSize: '0.001',
  minQty: '0.001',
};

const STOP_FLOOR: EntryStopFloor = {
  distanceFraction: new Decimal('0.1'),
  limitOffset: new Decimal('0.98'),
};

const withStopLoss = (stopLossPercentage: string): TTConfig => {
  const base = defaultTTConfig();
  return {
    ...base,
    sell: { ...base.sell, stopLossPercentage },
  };
};

/** Assert a quantity result and return its numeric value. */
const qty = (result: ReturnType<typeof computeFirstBuyQuantity>): number => {
  expect(result).toHaveProperty('quantity');
  return Number((result as { quantity: string }).quantity);
};

describe('computeFirstBuyQuantity — minPurchaseAmount floor', () => {
  it('ignores the floor when omitted (single-buy / no-floor grid)', () => {
    expect(qty(computeFirstBuyQuantity('100', '100', FILTERS, '', null))).toBe(1);
  });

  it('treats an empty floor as no floor', () => {
    expect(qty(computeFirstBuyQuantity('100', '100', FILTERS, '', null))).toBe(1);
  });

  it('returns the quantity when the budget notional meets the floor', () => {
    expect(qty(computeFirstBuyQuantity('100', '100', FILTERS, '50', null))).toBe(1);
  });

  it('skips with min-purchase when the budget cannot meet the floor', () => {
    expect(computeFirstBuyQuantity('100', '100', FILTERS, '150', null)).toEqual({
      skip: 'min-purchase',
    });
  });

  it("treats '0' floor as disabled", () => {
    expect(qty(computeFirstBuyQuantity('100', '100', FILTERS, '0', null))).toBe(1);
  });

  it('skips with invalid-filters on a malformed floor', () => {
    expect(computeFirstBuyQuantity('100', '100', FILTERS, 'abc', null)).toEqual({
      skip: 'invalid-filters',
    });
  });

  it('skips with invalid-filters on a malformed price/budget wire value', () => {
    // A bad snapshot price must skip, not throw (documented skip-not-throw).
    expect(computeFirstBuyQuantity('100', 'oops', FILTERS, '', null)).toEqual({
      skip: 'invalid-filters',
    });
    expect(computeFirstBuyQuantity('oops', '100', FILTERS, '', null)).toEqual({
      skip: 'invalid-filters',
    });
  });

  it('skips with invalid-filters when the price is non-positive', () => {
    expect(computeFirstBuyQuantity('100', '0', FILTERS, '', null)).toEqual({
      skip: 'invalid-filters',
    });
  });
});

describe('computeFirstBuyQuantity — stop-notional floor', () => {
  it('refuses a ZEC-style entry at exactly minNotional when a unit stop fires at entry', () => {
    const stop = ttEntryStopFloor(withStopLoss('1'));
    expect(stop?.distanceFraction.toFixed()).toBe('0');
    expect(computeFirstBuyQuantity('0.0001', '0.01', ZEC_FILTERS, '', stop)).toEqual({
      skip: 'entry-below-stop-notional',
    });
  });

  it('refuses a ZECBTC entry whose stop cannot be sold within the budget', () => {
    expect(computeFirstBuyQuantity('0.00012', '0.0118', ZEC_FILTERS, '', STOP_FLOOR)).toEqual({
      skip: 'entry-below-stop-notional',
    });
  });

  it('leaves a ZECBTC entry at the stop floor unchanged', () => {
    expect(computeFirstBuyQuantity('0.0001298', '0.0118', ZEC_FILTERS, '', STOP_FLOOR)).toEqual({
      quantity: '0.011',
    });
  });

  it('passes through the existing entry sizing when no stop is configured', () => {
    expect(computeFirstBuyQuantity('0.00012', '0.0118', ZEC_FILTERS, '', null)).toEqual({
      quantity: '0.010',
    });
  });

  it('applies the existing min-purchase floor after the stop floor', () => {
    expect(
      computeFirstBuyQuantity('0.00013', '0.0118', ZEC_FILTERS, '0.00014', STOP_FLOOR),
    ).toEqual({
      skip: 'min-purchase',
    });
  });
});

describe('ttEntryStopFloor', () => {
  // The default config carries a usable stopLossPercentage, so only the protective-stop block decides the limit offset under test; a blank offset bypasses schema validation because the worker ticks RAW stored config.
  const withProtectiveStop = (enabled: boolean, limitOffsetPercentage: string): TTConfig => {
    const base = withStopLoss('0.97');
    return {
      ...base,
      sell: {
        ...base.sell,
        protectiveStop: { ...base.sell.protectiveStop, enabled, limitOffsetPercentage },
      },
    };
  };

  it('uses a market fallback when the enabled stop has a blank offset', () => {
    expect(ttEntryStopFloor(withProtectiveStop(true, ''))?.limitOffset.toFixed()).toBe('1');
  });

  it('keeps the offset at 1 when the protective stop is disabled (MARKET stop, no limit leg)', () => {
    expect(ttEntryStopFloor(withProtectiveStop(false, ''))?.limitOffset.toFixed()).toBe('1');
  });

  it('uses the market fallback for a zero protective-stop offset', () => {
    expect(ttEntryStopFloor(withProtectiveStop(true, '0'))?.limitOffset.toFixed()).toBe('1');
  });

  it('uses the market fallback for a protective-stop offset above 1', () => {
    expect(ttEntryStopFloor(withProtectiveStop(true, '1.5'))?.limitOffset.toFixed()).toBe('1');
  });

  it('keeps the canonical unit offset at the trigger', () => {
    // A valid unit offset leaves the stop-limit floor at the trigger price.
    expect(ttEntryStopFloor(withProtectiveStop(true, '1'))?.limitOffset.toFixed()).toBe('1');
  });

  it('keeps a valid fractional protective-stop offset', () => {
    expect(ttEntryStopFloor(withProtectiveStop(true, '0.98'))?.limitOffset.toFixed()).toBe('0.98');
  });

  it('returns null when no loss-side stop is configured', () => {
    const base = defaultTTConfig();
    expect(
      ttEntryStopFloor({
        ...base,
        sell: { ...base.sell, stopLossPercentage: '' },
      }),
    ).toBeNull();
  });

  it("accepts stopLossPercentage '1' as a zero-distance entry floor", () => {
    expect(ttEntryStopFloor(withStopLoss('1'))?.distanceFraction.toFixed()).toBe('0');
  });

  for (const stopLossPercentage of ['0', '1.5']) {
    it(`returns null for stopLossPercentage ${JSON.stringify(stopLossPercentage)}`, () => {
      expect(ttEntryStopFloor(withStopLoss(stopLossPercentage))).toBeNull();
    });
  }

  it('keeps an above-trigger offset conservative for entry sellability', () => {
    const stop = ttEntryStopFloor(withProtectiveStop(true, '1.5'));
    const filters = parseFilters(ZEC_FILTERS);
    if (stop === null || filters === null) throw new Error('expected valid stop and filters');

    const entryPrice = new Decimal('0.0118');
    const triggerPrice = entryPrice.mul(new Decimal(1).minus(stop.distanceFraction));
    const cappedFloor = minSellableQuantityAtStop(filters, triggerPrice.mul(stop.limitOffset));
    const uncappedFloor = minSellableQuantityAtStop(filters, triggerPrice.mul(new Decimal('1.5')));
    if (cappedFloor === null || uncappedFloor === null) {
      throw new Error('expected positive stop prices');
    }

    expect(cappedFloor.gte(uncappedFloor)).toBe(true);
    expect(applyEntryStopFloor(uncappedFloor, entryPrice, filters, stop)).toEqual({
      skip: 'entry-below-stop-notional',
    });
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
