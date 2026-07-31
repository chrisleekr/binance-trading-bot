import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import {
  computeHoldoutSegment,
  HOLDOUT_FRACTION,
  type PricePoint,
  type RegimeTrade,
} from '../src/regime.js';
import type { EquityPoint } from '../src/types.js';

const DAY = 86_400_000;
const price = (day: number, close: string): PricePoint => ({ tsMs: day * DAY, close });
const eqp = (day: number, equity: string): EquityPoint => ({ tsMs: day * DAY, equity });
const rtrade = (pnl: string, day: number): RegimeTrade => ({
  pnl: new Decimal(pnl),
  openTsMs: day * DAY,
});

// An 11-point curve over days 0..10. With fraction 0.3 the cut lands exactly on
// day 7 (10-day span × 0.7), so the holdout is the steps whose later point is
// day 7..10. Equity is flat at 100 through day 6, then 100→110 and 110→121, so
// the holdout strategy return is exactly 1.1 × 1.1 = 21%. The benchmark is flat
// at 200 then 200→220, a clean 10% hold return, so alpha is 11%.
const equityCurve: EquityPoint[] = [
  eqp(0, '100'),
  eqp(1, '100'),
  eqp(2, '100'),
  eqp(3, '100'),
  eqp(4, '100'),
  eqp(5, '100'),
  eqp(6, '100'),
  eqp(7, '110'),
  eqp(8, '110'),
  eqp(9, '110'),
  eqp(10, '121'),
];
const benchmarkPrices: PricePoint[] = [
  price(0, '200'),
  price(1, '200'),
  price(2, '200'),
  price(3, '200'),
  price(4, '200'),
  price(5, '200'),
  price(6, '200'),
  price(7, '200'),
  price(8, '200'),
  price(9, '200'),
  price(10, '220'),
];

describe('computeHoldoutSegment', () => {
  it('exposes 0.3 (recent 30%) as the fixed holdout fraction', () => {
    expect(HOLDOUT_FRACTION).toBe(0.3);
  });

  it('cuts the window at the 70/30 boundary and compounds only holdout steps', () => {
    const seg = computeHoldoutSegment([], benchmarkPrices, equityCurve, HOLDOUT_FRACTION);
    expect(seg).not.toBeNull();
    expect(seg?.fraction).toBe(0.3);
    expect(seg?.fromMs).toBe(7 * DAY); // exact 70% boundary
    expect(seg?.toMs).toBe(10 * DAY);
    expect(seg?.returnPct).toBeCloseTo(21, 9);
    expect(seg?.holdReturnPct).toBeCloseTo(10, 9);
    expect(seg?.alphaVsHoldPct).toBeCloseTo(11, 9);
  });

  it('counts only trades opened inside the holdout window', () => {
    const trades: RegimeTrade[] = [
      rtrade('999', 5), // before the cut → excluded
      rtrade('30', 7), // win (on the cut)
      rtrade('-10', 8), // loss
      rtrade('0', 9), // break-even (neither win nor loss)
    ];
    const seg = computeHoldoutSegment(trades, benchmarkPrices, equityCurve, HOLDOUT_FRACTION);
    expect(seg?.trades).toBe(3); // the day-5 trade is not counted
    expect(seg?.profitFactor).toBeCloseTo(3, 9); // 30 / 10
    expect(seg?.winRate).toBeCloseTo(33.3333, 3);
    expect(Number(seg?.expectancy)).toBeCloseTo(20 / 3, 9); // (30 - 10 + 0) / 3
  });

  it('reports profitFactor null when the holdout has no losing trades', () => {
    const seg = computeHoldoutSegment(
      [rtrade('30', 7), rtrade('10', 8)],
      benchmarkPrices,
      equityCurve,
      HOLDOUT_FRACTION,
    );
    expect(seg?.trades).toBe(2);
    expect(seg?.profitFactor).toBeNull();
  });

  it('still reports returns when no trades opened in the holdout', () => {
    const seg = computeHoldoutSegment(
      [rtrade('5', 2)],
      benchmarkPrices,
      equityCurve,
      HOLDOUT_FRACTION,
    );
    expect(seg?.trades).toBe(0);
    expect(seg?.winRate).toBe(0);
    expect(seg?.profitFactor).toBeNull();
    expect(seg?.expectancy).toBe('0');
    expect(seg?.returnPct).toBeCloseTo(21, 9); // returns come from equity steps, not trades
  });

  it('returns null when the run is too short to carve a holdout', () => {
    expect(computeHoldoutSegment([], [], [], HOLDOUT_FRACTION)).toBeNull();
    expect(computeHoldoutSegment([], [], [eqp(0, '100')], HOLDOUT_FRACTION)).toBeNull();
    // Two points at the same instant → zero-length span → null.
    expect(
      computeHoldoutSegment([], [], [eqp(0, '100'), eqp(0, '110')], HOLDOUT_FRACTION),
    ).toBeNull();
  });
});
