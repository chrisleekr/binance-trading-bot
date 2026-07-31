// Direct coverage for basketSymbolsFromConfig's guard and de-dupe branches.
// It turns untyped form values into the symbol set a basket backtest loads, so
// the malformed-input and de-dupe paths matter even though the route test only
// drives the happy path.

import { describe, expect, it } from 'vitest';

import { basketSymbolsFromConfig } from '../src/features/symbol/strategies/registry.js';

describe('basketSymbolsFromConfig', () => {
  it('returns [] when targets is missing or not an array', () => {
    expect(basketSymbolsFromConfig({})).toEqual([]);
    expect(basketSymbolsFromConfig({ targets: 'BTCUSDT' })).toEqual([]);
    expect(basketSymbolsFromConfig({ targets: null })).toEqual([]);
  });

  it('skips null, non-object, and missing/non-string/empty symbols', () => {
    expect(
      basketSymbolsFromConfig({
        targets: [null, 42, {}, { symbol: '' }, { symbol: 7 }, { symbol: 'BTCUSDT' }],
      }),
    ).toEqual(['BTCUSDT']);
  });

  it('de-duplicates repeated symbols, preserving first-seen order', () => {
    expect(
      basketSymbolsFromConfig({
        targets: [{ symbol: 'BTCUSDT' }, { symbol: 'ETHUSDT' }, { symbol: 'BTCUSDT' }],
      }),
    ).toEqual(['BTCUSDT', 'ETHUSDT']);
  });
});
