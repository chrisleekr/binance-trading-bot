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

describe('projectSymbolFilters — PERCENT_PRICE_BY_SIDE', () => {
  const notional = { filterType: 'NOTIONAL', minNotional: '10' };
  const band = {
    filterType: 'PERCENT_PRICE_BY_SIDE',
    bidMultiplierUp: '1.1',
    bidMultiplierDown: '0.5',
    askMultiplierUp: '2',
    askMultiplierDown: '0.9',
    avgPriceMins: 5,
  };

  it('carries the multipliers and the averaging window through verbatim', () => {
    expect(projectSymbolFilters([price, lot, notional, band])?.percentPriceBySide).toEqual({
      bidMultiplierUp: '1.1',
      bidMultiplierDown: '0.5',
      askMultiplierUp: '2',
      askMultiplierDown: '0.9',
      avgPriceMins: 5,
    });
  });

  it('omits the key when Binance publishes no band, leaving the seven intact', () => {
    const projected = projectSymbolFilters([price, lot, notional]);
    expect(projected).not.toBeNull();
    expect(projected).not.toHaveProperty('percentPriceBySide');
    expect(projected?.tickSize).toBe('0.01');
  });

  it('degrades a garbled band to "unknown" rather than voiding the whole set', () => {
    // A band that failed the same all-or-nothing parse as the seven sizing
    // thresholds would take every symbol's filters down with it, which is a far
    // worse outage than the band it was meant to add.
    const garbled = { ...band, askMultiplierDown: 'abc' };
    const projected = projectSymbolFilters([price, lot, notional, garbled]);
    expect(projected).not.toBeNull();
    expect(projected).not.toHaveProperty('percentPriceBySide');
    expect(projected?.minNotional).toBe('10');
  });

  it('degrades a band missing avgPriceMins the same way', () => {
    const { avgPriceMins: _dropped, ...partial } = band;
    const projected = projectSymbolFilters([price, lot, notional, partial]);
    expect(projected).not.toBeNull();
    expect(projected).not.toHaveProperty('percentPriceBySide');
  });
});

describe('projectSymbolFilters — TRAILING_DELTA', () => {
  const notional = { filterType: 'NOTIONAL', minNotional: '10' };
  const trailing = {
    filterType: 'TRAILING_DELTA',
    minTrailingAboveDelta: 10,
    maxTrailingAboveDelta: 2000,
    minTrailingBelowDelta: 10,
    maxTrailingBelowDelta: 2000,
  };

  it('carries the four basis-point bounds through verbatim', () => {
    // The bounds are per symbol — there is no universal range — so a strategy
    // deriving a trailing distance has to read the symbol's own row.
    expect(projectSymbolFilters([price, lot, notional, trailing])?.trailingDelta).toEqual({
      minTrailingAboveDelta: 10,
      maxTrailingAboveDelta: 2000,
      minTrailingBelowDelta: 10,
      maxTrailingBelowDelta: 2000,
    });
  });

  it('omits the key when Binance publishes no bounds, leaving the seven intact', () => {
    const projected = projectSymbolFilters([price, lot, notional]);
    expect(projected).not.toBeNull();
    expect(projected).not.toHaveProperty('trailingDelta');
    expect(projected?.tickSize).toBe('0.01');
  });

  it('degrades a garbled row to "unknown" rather than voiding the whole set', () => {
    // Same all-or-nothing reasoning as the band: an unreadable optional filter
    // must never take a symbol's sizing thresholds down with it.
    const projected = projectSymbolFilters([
      price,
      lot,
      notional,
      { ...trailing, maxTrailingBelowDelta: '2000' },
    ]);
    expect(projected).not.toBeNull();
    expect(projected).not.toHaveProperty('trailingDelta');
    expect(projected?.minNotional).toBe('10');
  });

  it('degrades a row missing a bound the same way', () => {
    const { minTrailingBelowDelta: _dropped, ...partial } = trailing;
    const projected = projectSymbolFilters([price, lot, notional, partial]);
    expect(projected).not.toBeNull();
    expect(projected).not.toHaveProperty('trailingDelta');
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
