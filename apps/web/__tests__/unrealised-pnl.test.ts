import { describe, expect, it } from 'vitest';

import {
  isManagedPosition,
  managedUnrealisedPnlOf,
  unrealisedPnlOf,
} from '../src/features/profile/lib/unrealised-pnl.js';

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

describe('the refusal-aware predicate and its P/L', () => {
  // A position the strategy is actually running: cost basis, quantity, a live price and no refusal.
  const running = {
    ...base,
    avgEntryPrice: asDecimalString('100'),
    currentPrice: asDecimalString('110'),
    quantity: asDecimalString('2'),
  };
  const refusal = { code: 'no-sellable-position', since: '2026-08-27T00:00:00Z' };

  it('agrees with the held predicate while no refusal stands', () => {
    expect(isManagedPosition(running)).toBe(true);
    expect(managedUnrealisedPnlOf(running)).toBe(20);
    // The whole point of the pair: with no refusal they must be indistinguishable, or every healthy row changes behaviour.
    expect(managedUnrealisedPnlOf(running)).toBe(unrealisedPnlOf(running));
  });

  it('withdraws both the position and its P/L once the seed was refused', () => {
    const refused = { ...running, positionSeedRefusal: refusal };
    expect(isManagedPosition(refused)).toBe(false);
    expect(managedUnrealisedPnlOf(refused)).toBeNull();
    // The arithmetic still WORKS on that row, which is exactly why the suppression has to be explicit: the number is a gain on something that will never be sold.
    expect(unrealisedPnlOf(refused)).toBe(20);
  });

  it('reads an absent field as unrefused, so a payload without it is unchanged', () => {
    // `?? null` rather than a bare `=== null`: the contract defaults the field, but an optimistic write or a fixture leaves it undefined, and `undefined !== null` would blank the P/L on every healthy row in the app.
    expect(isManagedPosition({ ...running, positionSeedRefusal: undefined })).toBe(true);
    expect(managedUnrealisedPnlOf({ ...running, positionSeedRefusal: undefined })).toBe(20);
  });

  it('stays false for a flat row whatever the refusal says', () => {
    expect(isManagedPosition(base)).toBe(false);
    expect(isManagedPosition({ ...base, positionSeedRefusal: refusal })).toBe(false);
  });
});
