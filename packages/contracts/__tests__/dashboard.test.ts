import { describe, expect, it } from 'vitest';
import { ProfileDashboardResponse, ProfileDashboardSymbol } from '../src/dashboard.js';

/** Minimal valid payload for the required fields, omitting `entryBlocker`. */
const base = {
  symbol: 'SOLUSDT',
  enabled: true,
  source: 'manual',
  avgEntryPrice: '100.5',
  currentPrice: '101.25',
  quantity: '2',
  openOrderCount: 0,
  openOrders: [],
};

describe('ProfileDashboardSymbol entryBlocker', () => {
  it('decodes a payload that omits entryBlocker to null (default)', () => {
    const parsed = ProfileDashboardSymbol.parse(base);
    expect(parsed.entryBlocker).toBe(null);
  });

  it('preserves an explicit entryBlocker through a round-trip', () => {
    const parsed = ProfileDashboardSymbol.parse({
      ...base,
      entryBlocker: { reason: 'awaiting-trigger-price', detail: {} },
    });
    expect(parsed.entryBlocker).toEqual({ reason: 'awaiting-trigger-price', detail: {} });
  });

  it('parses an explicit null entryBlocker to null', () => {
    const parsed = ProfileDashboardSymbol.parse({ ...base, entryBlocker: null });
    expect(parsed.entryBlocker).toBe(null);
  });
});

describe('ProfileDashboardResponse deployedQuote', () => {
  /** Minimal valid response, omitting the defaulted `deployedQuote`. */
  const response = {
    profileId: '11111111-1111-4111-8111-111111111111',
    enabled: true,
    binanceMode: 'test',
    quoteAsset: 'USDT',
    balances: [],
    totalProfit: '0',
    enabledNotifierCount: 0,
    symbols: [],
    cachedAt: '2026-06-16T00:00:00.000Z',
  };

  it('defaults deployedQuote to 0 for a cache blob written before the field existed', () => {
    expect(ProfileDashboardResponse.parse(response).deployedQuote).toBe('0');
  });

  it('preserves an explicit deployedQuote through a round-trip', () => {
    expect(
      ProfileDashboardResponse.parse({ ...response, deployedQuote: '1234.5' }).deployedQuote,
    ).toBe('1234.5');
  });
});

describe('ProfileDashboardResponse balances usdPrice', () => {
  /** Minimal valid response; each test supplies its own `balances`. */
  const response = {
    profileId: '11111111-1111-4111-8111-111111111111',
    enabled: true,
    binanceMode: 'test',
    quoteAsset: 'USDT',
    totalProfit: '0',
    enabledNotifierCount: 0,
    symbols: [],
    cachedAt: '2026-06-16T00:00:00.000Z',
  };

  it('preserves a per-asset usdPrice on a balances row', () => {
    const parsed = ProfileDashboardResponse.parse({
      ...response,
      balances: [{ asset: 'ETH', free: '1.5', locked: '0', usdPrice: '2135.88' }],
    });
    expect(parsed.balances[0]?.usdPrice).toBe('2135.88');
  });

  it('decodes a balances row that omits usdPrice (nullable)', () => {
    const parsed = ProfileDashboardResponse.parse({
      ...response,
      balances: [{ asset: 'USDT', free: '100', locked: '0' }],
    });
    expect(parsed.balances[0]?.usdPrice ?? null).toBeNull();
  });
});
