import { describe, expect, it } from 'vitest';

import { unrealisedPnlOf } from '../src/features/profile/lib/unrealised-pnl.js';

import { asDecimalString, type ProfileDashboardResponse } from '@app/contracts';

type DashboardSymbol = ProfileDashboardResponse['symbols'][number];

const base: DashboardSymbol = {
  symbol: 'BTCUSDT',
  enabled: true,
  avgEntryPrice: null,
  currentPrice: null,
  quantity: null,
  openOrderCount: 0,
  openOrders: [],
};

describe('unrealisedPnlOf', () => {
  it('computes (currentPrice - avgEntryPrice) * quantity', () => {
    expect(
      unrealisedPnlOf({
        ...base,
        avgEntryPrice: asDecimalString('60000'),
        currentPrice: asDecimalString('61000'),
        quantity: asDecimalString('0.001'),
      }),
    ).toBe(1);
  });

  it('is negative when the mark is below cost', () => {
    expect(
      unrealisedPnlOf({
        ...base,
        avgEntryPrice: asDecimalString('100'),
        currentPrice: asDecimalString('90'),
        quantity: asDecimalString('2'),
      }),
    ).toBe(-20);
  });

  it('rounds so a float-multiplication artifact never surfaces', () => {
    // (100.2 - 100) * 3 = 0.6 exactly, but IEEE-754 yields 0.6000000000000085.
    expect(
      unrealisedPnlOf({
        ...base,
        avgEntryPrice: asDecimalString('100'),
        currentPrice: asDecimalString('100.2'),
        quantity: asDecimalString('3'),
      }),
    ).toBe(0.6);
  });

  it('returns null when the symbol is flat', () => {
    expect(unrealisedPnlOf(base)).toBeNull();
    expect(unrealisedPnlOf({ ...base, avgEntryPrice: asDecimalString('100') })).toBeNull();
  });

  it('returns null when a price coerces to a non-finite number', () => {
    expect(
      unrealisedPnlOf({
        ...base,
        avgEntryPrice: asDecimalString('100'),
        currentPrice: 'not-a-number' as ProfileDashboardResponse['symbols'][number]['currentPrice'],
        quantity: asDecimalString('1'),
      }),
    ).toBeNull();
  });
});
