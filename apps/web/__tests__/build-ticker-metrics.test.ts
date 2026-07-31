// buildTickerMetrics — pure rollup for the dashboard ticker strip: count open
// positions/orders and sum realised P/L per quote, but only over live+enabled
// profiles so practice (testnet) and paused profiles never inflate the headline.

import { describe, expect, it } from 'vitest';

import { buildTickerMetrics } from '@/features/dashboard/lib/build-ticker-metrics';

import type { DashboardAggregateRow, ProfileDashboardSymbol } from '@app/contracts';

// Valid uuids: DashboardAggregateRow parses profileId via z.uuid().
const PA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const row = (
  overrides: Partial<DashboardAggregateRow> & { profileId: string; name: string },
): DashboardAggregateRow => ({
  enabled: true,
  binanceMode: 'live',
  quoteAsset: 'USDT',
  lastTickAt: null,
  lastTickLatencyMs: null,
  apiKeyConfigured: true,
  lastTickError: null,
  killSwitch: false,
  openOrderCount: 0,
  openPositionCount: 0,
  positions: [],
  ...overrides,
});

const sym = (
  overrides: Partial<ProfileDashboardSymbol> & { symbol: string },
): ProfileDashboardSymbol => ({
  enabled: true,
  source: 'manual',
  avgEntryPrice: null,
  currentPrice: null,
  quantity: null,
  openOrderCount: 0,
  openOrders: [],
  entryBlocker: null,
  ...overrides,
});

describe('buildTickerMetrics', () => {
  it('sums openPositionCount and openOrderCount over live+enabled profiles only', () => {
    const result = buildTickerMetrics(
      [
        row({ profileId: PA, name: 'Live', openPositionCount: 2, openOrderCount: 3 }),
        row({
          profileId: PB,
          name: 'Paused',
          enabled: false,
          openPositionCount: 5,
          openOrderCount: 7,
        }),
        row({
          profileId: PC,
          name: 'Practice',
          binanceMode: 'test',
          openPositionCount: 9,
          openOrderCount: 11,
        }),
      ],
      [],
      [],
    );

    expect(result.positions).toBe(2);
    expect(result.orders).toBe(3);
  });

  it('groups realised P/L per quote asset across live profiles', () => {
    const result = buildTickerMetrics(
      [
        row({ profileId: PA, name: 'Live USDT 1', quoteAsset: 'USDT' }),
        row({ profileId: PB, name: 'Live USDT 2', quoteAsset: 'USDT' }),
        row({ profileId: PC, name: 'Practice', binanceMode: 'test', quoteAsset: 'USDT' }),
      ],
      [
        { profileId: PA, quoteAsset: 'USDT', totalProfit: '10.5' },
        { profileId: PB, quoteAsset: 'USDT', totalProfit: '4.25' },
        { profileId: PA, quoteAsset: 'BTC', totalProfit: '0.002' },
        { profileId: PC, quoteAsset: 'USDT', totalProfit: '99999' },
      ],
      [],
    );

    expect(result.realised).toEqual([
      { quote: 'BTC', pnl: '0.002' },
      { quote: 'USDT', pnl: '14.75' },
    ]);
  });

  it('returns zero-state for no profiles', () => {
    expect(buildTickerMetrics([], [], [])).toEqual({
      positions: 0,
      orders: 0,
      realised: [],
      unrealised: [],
      holdings: [],
    });
  });

  it('computes unrealised total and per-coin holdings from the live symbols', () => {
    // Only live+enabled symbols reach the ticker (the caller passes them), so the
    // held-set passed here is already scoped — no practice/paused leakage to test.
    const result = buildTickerMetrics(
      [row({ profileId: PA, name: 'Live', quoteAsset: 'USDT' })],
      [],
      [
        sym({ symbol: 'BTCUSDT', avgEntryPrice: '100', currentPrice: '110', quantity: '2' }),
        sym({ symbol: 'ETHUSDT', avgEntryPrice: '200', currentPrice: '190', quantity: '1' }),
      ],
    );

    // BTC +20 and ETH -10 net to +10 USDT.
    expect(result.unrealised).toEqual([{ quote: 'USDT', pnl: '10' }]);
    // Per-coin, sorted by symbol: BTC +20 (+10%), ETH -10 (-5%).
    expect(result.holdings).toEqual([
      { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', pnl: '20', pnlPercent: '10' },
      { symbol: 'ETHUSDT', base: 'ETH', quote: 'USDT', pnl: '-10', pnlPercent: '-5' },
    ]);
  });

  it('excludes a held but unpriced symbol from holdings and unrealised', () => {
    const result = buildTickerMetrics(
      [row({ profileId: PA, name: 'Live', quoteAsset: 'USDT' })],
      [],
      [
        sym({ symbol: 'BTCUSDT', avgEntryPrice: '100', currentPrice: '110', quantity: '2' }),
        // Held (avgEntryPrice + quantity) but no live price yet.
        sym({ symbol: 'ETHUSDT', avgEntryPrice: '200', currentPrice: null, quantity: '1' }),
      ],
    );

    expect(result.unrealised).toEqual([{ quote: 'USDT', pnl: '20' }]);
    expect(result.holdings).toEqual([
      { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', pnl: '20', pnlPercent: '10' },
    ]);
  });
});
