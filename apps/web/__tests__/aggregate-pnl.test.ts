// Home-screen card P/L aggregation — apps/web/src/features/dashboard/lib/aggregate-pnl.ts.

import { describe, expect, it } from 'vitest';

import { asDecimalString, type DashboardPositionInput } from '@app/contracts';

import { aggregatePositionPnl } from '../src/features/dashboard/lib/aggregate-pnl.js';

const pos = (
  symbol: string,
  avgEntryPrice: string,
  currentPrice: string | null,
  quantity: string | null,
): DashboardPositionInput => ({
  symbol,
  avgEntryPrice: asDecimalString(avgEntryPrice),
  currentPrice: currentPrice == null ? null : asDecimalString(currentPrice),
  quantity: quantity == null ? null : asDecimalString(quantity),
});

describe('aggregatePositionPnl', () => {
  it('sums (currentPrice - avgEntryPrice) * quantity per quote asset', () => {
    // (112.34 - 100) * 1 = 12.34 ; (50 - 40) * 2 = 20 ; both USDT → one group
    expect(
      aggregatePositionPnl([pos('SOLUSDT', '100', '112.34', '1'), pos('ADAUSDT', '40', '50', '2')]),
    ).toEqual([{ quote: 'USDT', pnl: '32.34' }]);
  });

  it('groups by quote asset and sorts the groups by quote', () => {
    // USDT: (90-100)*1 = -10 ; BTC: (0.5-0.4)*2 = 0.2
    expect(
      aggregatePositionPnl([pos('SOLUSDT', '100', '90', '1'), pos('ETHBTC', '0.4', '0.5', '2')]),
    ).toEqual([
      { quote: 'BTC', pnl: '0.2' },
      { quote: 'USDT', pnl: '-10' },
    ]);
  });

  it('returns an empty array for a flat profile (no positions)', () => {
    expect(aggregatePositionPnl([])).toEqual([]);
  });

  it('returns an empty array when no position has a live price yet', () => {
    expect(
      aggregatePositionPnl([pos('SOLUSDT', '100', null, '1'), pos('ADAUSDT', '40', null, '2')]),
    ).toEqual([]);
  });

  it('sums only the priced positions, skipping ones still awaiting a price', () => {
    expect(
      aggregatePositionPnl([pos('SOLUSDT', '100', '112.34', '1'), pos('ADAUSDT', '40', null, '2')]),
    ).toEqual([{ quote: 'USDT', pnl: '12.34' }]);
  });

  it('falls back to the raw symbol as the group when the quote suffix is unknown', () => {
    expect(aggregatePositionPnl([pos('WEIRDPAIR', '100', '110', '1')])).toEqual([
      { quote: 'WEIRDPAIR', pnl: '10' },
    ]);
  });
});
