// The two wire-account builders that feed the preview: the live dashboard shape
// and the synthetic backtest wallet. Both emit decimal-strings (apps/web cannot
// build Decimal); the strategy revives them at its own boundary.

import { describe, expect, it } from 'vitest';

import {
  accountWireFromBalances,
  filtersFromExchangeInfoSymbol,
  syntheticBacktestAccount,
} from '../src/features/symbol/preview/account-wire.js';

import type { ExchangeInfoSymbol, SymbolFilters } from '@app/contracts';

const filters: SymbolFilters = {
  minNotional: '10.00000000',
  tickSize: '0.01000000',
  stepSize: '0.00010000',
  minQty: '0.00010000',
  maxQty: '1000.00000000',
  minPrice: '0.01000000',
  maxPrice: '1000000.00000000',
};

const row = (overrides: Partial<ExchangeInfoSymbol>): ExchangeInfoSymbol => ({
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'TRADING',
  ...overrides,
});

describe('accountWireFromBalances', () => {
  it('keys balances by asset and carries the deployed cost-basis through unchanged', () => {
    expect(accountWireFromBalances([{ asset: 'USDT', free: '10', locked: '2' }], '5')).toEqual({
      balances: { USDT: { free: '10', locked: '2' } },
      deployedQuoteAcrossProfiles: '5',
    });
  });
});

describe('syntheticBacktestAccount', () => {
  it('puts the typed starting balance as free quote cash with nothing deployed', () => {
    expect(syntheticBacktestAccount('USDT', '100')).toEqual({
      balances: { USDT: { free: '100', locked: '0' } },
      deployedQuoteAcrossProfiles: '0',
    });
  });
});

describe('filtersFromExchangeInfoSymbol', () => {
  it('returns undefined when the exchange-info row is absent', () => {
    expect(filtersFromExchangeInfoSymbol(undefined)).toBeUndefined();
  });

  it('coalesces a null filter set to undefined so the preview falls back to band-only', () => {
    expect(filtersFromExchangeInfoSymbol(row({ filters: null }))).toBeUndefined();
  });

  it('passes a populated filter set through by reference', () => {
    expect(filtersFromExchangeInfoSymbol(row({ filters }))).toBe(filters);
  });
});
