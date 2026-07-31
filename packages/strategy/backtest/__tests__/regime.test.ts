import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import { computeRegimeBreakdown, type PricePoint, type RegimeTrade } from '../src/regime.js';
import type { EquityPoint } from '../src/types.js';

const DAY = 86_400_000;
const price = (day: number, close: string): PricePoint => ({ tsMs: day * DAY, close });
const eqp = (day: number, equity: string): EquityPoint => ({ tsMs: day * DAY, equity });
const rtrade = (pnl: string, day: number): RegimeTrade => ({
  pnl: new Decimal(pnl),
  openTsMs: day * DAY,
});

describe('computeRegimeBreakdown', () => {
  it('classifies bull/neutral/bear and attributes trades to the open regime', () => {
    // 60 flat days (neutral baseline), then an uptrend (bull), then a downtrend
    // (bear) — enough daily history past the 50-day MA to label all three.
    const closes: number[] = [];
    for (let i = 0; i < 60; i++) closes.push(100);
    for (let i = 0; i < 20; i++) closes.push(120 + i * 2); // days 60..79
    for (let i = 0; i < 20; i++) closes.push(158 - i * 5); // days 80..99
    const benchmarkPrices = closes.map((c, i) => price(i, String(c)));
    // Equity fully tracks the benchmark (held), so per-regime strategy return
    // equals hold return and alpha is ~0 — the honest verdict for buy-and-hold.
    const equityCurve = closes.map((c, i) => eqp(i, String(c * 10)));
    const trades = [
      rtrade('50', 62), // bull winner
      rtrade('-20', 62), // bull loser
      rtrade('0', 62), // bull break-even (neither win nor loss)
      rtrade('999', 5), // day 5 is unclassified (pre-MA) → excluded
    ];

    const segs = computeRegimeBreakdown(trades, benchmarkPrices, equityCurve);
    const byRegime = new Map(segs.map((s) => [s.regime, s]));
    expect([...byRegime.keys()].sort()).toEqual(['bear', 'bull', 'neutral']);

    const bull = byRegime.get('bull');
    expect(bull?.trades).toBe(3); // the unclassified day-5 trade is not counted
    expect(bull?.winRate).toBeCloseTo(33.3333, 3);
    expect(bull?.profitFactor).toBeCloseTo(2.5, 9);
    expect(bull?.expectancy).toBe('10');

    const neutral = byRegime.get('neutral');
    expect(neutral?.trades).toBe(0);
    expect(neutral?.winRate).toBe(0);
    expect(neutral?.profitFactor).toBeNull();
    expect(neutral?.expectancy).toBe('0');

    // Fully-held equity → strategy return equals hold return in every regime.
    for (const s of segs) {
      expect(s.alphaVsHoldPct).toBeCloseTo(s.returnPct - s.holdReturnPct, 9);
      expect(s.returnPct).toBeCloseTo(s.holdReturnPct, 9);
    }
  });

  it('omits regimes the window never reached', () => {
    // Monotonic uptrend: once the MA is warm, every day is bull — neutral and
    // bear are never reached and must not appear as zero-filled rows.
    const up = Array.from({ length: 70 }, (_, i) => 100 + i * 3);
    const segs = computeRegimeBreakdown(
      [],
      up.map((c, i) => price(i, String(c))),
      up.map((c, i) => eqp(i, String(c))),
    );
    expect(segs.map((s) => s.regime)).toEqual(['bull']);
    expect(segs[0]?.trades).toBe(0);
    expect(segs[0]?.profitFactor).toBeNull();
  });

  it('reports an all-loss regime with a finite zero profit factor and zero win rate', () => {
    // Flat history then a steep downtrend → the late days are confirmed bear.
    const closes: number[] = [];
    for (let i = 0; i < 52; i++) closes.push(100);
    for (let i = 0; i < 15; i++) closes.push(100 - (i + 1) * 5); // days 52..66
    const lastDay = closes.length - 1;
    const segs = computeRegimeBreakdown(
      [rtrade('-10', lastDay), rtrade('-30', lastDay)], // both lose, opened in the bear regime
      closes.map((c, i) => price(i, String(c))),
      closes.map((c, i) => eqp(i, String(c * 10))),
    );
    const bear = segs.find((s) => s.regime === 'bear');
    expect(bear?.trades).toBe(2);
    expect(bear?.winRate).toBe(0);
    // grossWin 0 / grossLoss 40 → a finite 0, NOT null: the honest "no winners
    // here" verdict, distinct from a no-trade regime's null.
    expect(bear?.profitFactor).toBe(0);
    expect(bear?.expectancy).toBe('-20');
  });

  it('returns empty when the window is too short to classify a regime', () => {
    const segs = computeRegimeBreakdown(
      [],
      [price(0, '100'), price(1, '101')],
      [eqp(0, '100'), eqp(1, '101')],
    );
    expect(segs).toEqual([]);
  });

  it('ignores malformed closes and non-positive equity steps', () => {
    const flat: PricePoint[] = [];
    const ec: EquityPoint[] = [];
    for (let i = 0; i < 55; i++) {
      flat.push(price(i, '100'));
      ec.push(eqp(i, '100'));
    }
    // A non-positive equity point: the step that follows it is skipped (a zero
    // base cannot yield a ratio).
    ec.push(eqp(55, '0'));
    ec.push(eqp(56, '100'));
    flat.push(price(55, '100'));
    flat.push(price(56, '100'));
    // Malformed closes in both series are dropped, not fatal.
    flat.push(price(60, 'not-a-number'));
    ec.push(eqp(60, 'not-a-number'));

    const segs = computeRegimeBreakdown([], flat, ec);
    expect(segs.some((s) => s.regime === 'neutral')).toBe(true);
  });
});
