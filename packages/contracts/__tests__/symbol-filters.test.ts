import { describe, expect, it } from 'vitest';

import { ProfileSymbolResponse, projectSymbolFilters } from '../src/symbols.js';

const price = {
  filterType: 'PRICE_FILTER',
  minPrice: '0.01',
  maxPrice: '1000000',
  tickSize: '0.01',
};
const lot = { filterType: 'LOT_SIZE', minQty: '0.0001', maxQty: '9000', stepSize: '0.0001' };

describe('projectSymbolFilters', () => {
  it('projects the full set from NOTIONAL + LOT_SIZE + PRICE_FILTER, verbatim', () => {
    const filters = [
      {
        filterType: 'PRICE_FILTER',
        minPrice: '0.01000000',
        maxPrice: '1000000.00000000',
        tickSize: '0.01000000',
      },
      {
        filterType: 'LOT_SIZE',
        minQty: '0.00010000',
        maxQty: '9000.00000000',
        stepSize: '0.00010000',
      },
      { filterType: 'NOTIONAL', minNotional: '10.00000000' },
    ];
    expect(projectSymbolFilters(filters)).toEqual({
      minNotional: '10.00000000',
      tickSize: '0.01000000',
      stepSize: '0.00010000',
      minQty: '0.00010000',
      maxQty: '9000.00000000',
      minPrice: '0.01000000',
      maxPrice: '1000000.00000000',
    });
  });

  it('falls back to the legacy MIN_NOTIONAL filter for minNotional', () => {
    const filters = [price, lot, { filterType: 'MIN_NOTIONAL', minNotional: '5' }];
    expect(projectSymbolFilters(filters)?.minNotional).toBe('5');
  });

  it('returns null when a required filter group is missing', () => {
    // No LOT_SIZE — stepSize/minQty/maxQty would be absent, so the whole set is null.
    expect(projectSymbolFilters([price, { filterType: 'NOTIONAL', minNotional: '10' }])).toBeNull();
  });

  it('returns null when a value is not a positive decimal-string', () => {
    const badLot = { filterType: 'LOT_SIZE', minQty: 'abc', maxQty: '9000', stepSize: '0.0001' };
    expect(
      projectSymbolFilters([price, badLot, { filterType: 'NOTIONAL', minNotional: '10' }]),
    ).toBeNull();
  });

  it('returns null when the filter list is absent', () => {
    expect(projectSymbolFilters(undefined)).toBeNull();
  });
});

describe('ProfileSymbolResponse save diagnostics', () => {
  const base = { symbol: 'BTCUSDT', overrideConfig: null, source: 'manual' as const };

  // The symbols list read parses this schema for every row, and only a bind ever
  // sets the field. If it stopped being optional, listing symbols would throw.
  it('omits the field when the response carries none', () => {
    expect(ProfileSymbolResponse.parse(base)).not.toHaveProperty('diagnostics');
  });

  it('round-trips the findings a bind attaches', () => {
    const diagnostics = [
      { level: 'warn' as const, code: 'price-unavailable', message: 'BTCUSDT: no price yet.' },
    ];
    expect(ProfileSymbolResponse.parse({ ...base, diagnostics }).diagnostics).toEqual(diagnostics);
  });
});
