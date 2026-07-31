import { describe, expect, it } from 'vitest';

import { deriveBase, deriveQuote, distinctQuotes } from '../src/shared/lib/symbol-quote';

describe('deriveQuote', () => {
  it.each([
    ['BTCUSDT', 'USDT'],
    ['ETHUSDT', 'USDT'],
    ['BNBBUSD', 'BUSD'],
    ['ETHBTC', 'BTC'],
    ['BNBETH', 'ETH'],
    ['ADATUSD', 'TUSD'],
    ['ADAFDUSD', 'FDUSD'],
    ['BTCUSDC', 'USDC'],
    ['BTCEUR', 'EUR'],
  ])('parses %s → %s', (symbol, expected) => {
    expect(deriveQuote(symbol)).toBe(expected);
  });

  it('returns null for unknown quote suffixes', () => {
    expect(deriveQuote('BTCABC')).toBeNull();
  });

  it('rejects a quote-only string (no base)', () => {
    expect(deriveQuote('USDT')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(deriveQuote('')).toBeNull();
  });

  it('prefers the longer-suffix match (FDUSD before USDT)', () => {
    // A hypothetical "ADAFDUSD" should resolve to FDUSD, not USDT (which is
    // a strict suffix of FDUSD only at the byte level — both `endsWith`
    // would otherwise pick the first match in the list).
    expect(deriveQuote('ADAFDUSD')).toBe('FDUSD');
  });
});

describe('distinctQuotes', () => {
  it('returns the alphabetically-sorted unique quote set', () => {
    expect(
      distinctQuotes([
        { symbol: 'BTCUSDT' },
        { symbol: 'ETHUSDT' },
        { symbol: 'BNBBUSD' },
        { symbol: 'ETHBTC' },
      ]),
    ).toEqual(['BTC', 'BUSD', 'USDT']);
  });

  it('drops symbols with unparseable suffixes silently', () => {
    expect(distinctQuotes([{ symbol: 'BTCUSDT' }, { symbol: 'BTCXYZ' }])).toEqual(['USDT']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(distinctQuotes([{ symbol: 'foo' }, { symbol: 'bar' }])).toEqual([]);
  });
});

describe('deriveBase', () => {
  it('strips the quote asset to yield the base asset', () => {
    expect(deriveBase('ETHUSDT', 'USDT')).toBe('ETH');
    expect(deriveBase('BTCUSDT', 'USDT')).toBe('BTC');
  });

  it('returns null when the symbol does not end with the quote asset', () => {
    expect(deriveBase('ETHBTC', 'USDT')).toBeNull();
  });
});
