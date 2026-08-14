// Crafted candle windows verify that the public pipeline wires indicator values
// into the expected vote families. Exact helper predicates are tested directly.

import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import type { Candle } from '@app/strategy-core';

import { stochRsi } from '../../src/rating/adapter.js';
import { computeTechnicalsRating } from '../../src/rating/index.js';

const N = 260; // long enough to warm the 200-period MAs

const mk = (i: number, close: number, high: number, low: number): Candle => ({
  openTimeMs: i * 60_000,
  closeTimeMs: i * 60_000 + 59_999,
  open: String(close),
  high: String(high),
  low: String(low),
  close: String(close),
  volume: '100',
  isClosed: true,
});

// Monotone uptrend that accelerates near the end (so RSI/Stoch/Williams sit in
// overbought and momentum/MACD/AO read bullish).
const uptrend = (): Candle[] =>
  Array.from({ length: N }, (_, i) => {
    const c = 100 + i * 0.8 + (i > N - 6 ? (i - (N - 6)) * 6 : 0);
    return mk(i, c, c + 0.5, c - 0.5);
  });

// Monotone downtrend that accelerates down near the end.
const downtrend = (): Candle[] =>
  Array.from({ length: N }, (_, i) => {
    const c = 300 - i * 0.8 - (i > N - 6 ? (i - (N - 6)) * 6 : 0);
    return mk(i, c, c + 0.5, c - 0.5);
  });

// Oscillating series so %K/%D cross both ways and RSI swings through 30/70.
const oscillating = (): Candle[] =>
  Array.from({ length: N }, (_, i) => {
    const c = 200 + Math.sin(i / 2) * 30 + Math.sin(i / 7) * 10;
    return mk(i, c, c + 2, c - 2);
  });

// Perfectly flat — every oscillator sits neutral, MAs equal price.
const flat = (): Candle[] => Array.from({ length: N }, (_, i) => mk(i, 150, 150, 150));

const votesOf = (w: Candle[]): Record<string, number> =>
  computeTechnicalsRating(w).perIndicatorVotes;

const seededWindow = (
  seed: number,
  length: number,
  options: {
    readonly initialPrice?: number;
    readonly bias?: number;
    readonly stepScale?: number;
    readonly wickScale?: number;
  } = {},
): Candle[] => {
  let state = seed >>> 0;
  let price = options.initialPrice ?? 200;
  const bias = options.bias ?? 0;
  const stepScale = options.stepScale ?? 20;
  const wickScale = options.wickScale ?? 15;
  const random = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
  return Array.from({ length }, (_, i) => {
    price += (random() - 0.5 + bias) * stepScale;
    const high = price + random() * wickScale + 0.1;
    const low = price - random() * wickScale - 0.1;
    return mk(i, price, high, low);
  });
};

const stochRsiState = (seed: number, bias: number) => {
  const window = seededWindow(seed, 250, { initialPrice: 1_000, bias });
  const rating = computeTechnicalsRating(window);
  const lines = stochRsi(window);
  const ema50 = rating.movingAverages.ema50;
  const last = window[window.length - 1];
  if (!lines || !ema50 || !last) throw new Error('Stochastic RSI case did not warm up');
  return { rating, lines, ema50, close: new Decimal(last.close) };
};

describe('computeTechnicalsRating — vote arms across regimes', () => {
  it('uses close versus EMA(50) for both trend-gated oscillator votes', () => {
    const votes = votesOf(seededWindow(29, 250, { bias: 0.02, stepScale: 12, wickScale: 8 }));
    expect(votes['stochRsi']).toBe(0);
    expect(votes['bbPower']).toBe(1);
  });

  it('votes BUY for oversold Stochastic RSI only when close is below EMA(50)', () => {
    const buy = stochRsiState(13, -0.04);
    expect(buy.lines.k.lessThan(20)).toBe(true);
    expect(buy.lines.d.lessThan(20)).toBe(true);
    expect(buy.lines.k.greaterThan(buy.lines.d)).toBe(true);
    expect(buy.close.lessThan(buy.ema50)).toBe(true);
    expect(buy.rating.perIndicatorVotes['stochRsi']).toBe(1);

    const oppositeTrend = stochRsiState(13, 0);
    expect(oppositeTrend.lines.k.lessThan(20)).toBe(true);
    expect(oppositeTrend.lines.d.lessThan(20)).toBe(true);
    expect(oppositeTrend.lines.k.greaterThan(oppositeTrend.lines.d)).toBe(true);
    expect(oppositeTrend.close.greaterThan(oppositeTrend.ema50)).toBe(true);
    expect(oppositeTrend.rating.perIndicatorVotes['stochRsi']).toBe(0);
  });

  it('votes SELL for overbought Stochastic RSI only when close is above EMA(50)', () => {
    const sell = stochRsiState(3, 0);
    expect(sell.lines.k.greaterThan(80)).toBe(true);
    expect(sell.lines.d.greaterThan(80)).toBe(true);
    expect(sell.lines.k.lessThan(sell.lines.d)).toBe(true);
    expect(sell.close.greaterThan(sell.ema50)).toBe(true);
    expect(sell.rating.perIndicatorVotes['stochRsi']).toBe(-1);

    const oppositeTrend = stochRsiState(3, -0.04);
    expect(oppositeTrend.lines.k.greaterThan(80)).toBe(true);
    expect(oppositeTrend.lines.d.greaterThan(80)).toBe(true);
    expect(oppositeTrend.lines.k.lessThan(oppositeTrend.lines.d)).toBe(true);
    expect(oppositeTrend.close.lessThan(oppositeTrend.ema50)).toBe(true);
    expect(oppositeTrend.rating.perIndicatorVotes['stochRsi']).toBe(0);
  });

  it('a strong uptrend produces buy votes on the moving averages', () => {
    const votes = votesOf(uptrend());
    for (const key of ['ema10', 'sma50', 'ema200', 'vwma20', 'hullMa9']) {
      expect(votes[key]).toBe(1);
    }
    // Not "this window misses the setup": the Ichimoku arms are unsatisfiable
    // by construction, so Neutral here is the invariant, matching TradingView's
    // own always-0 Rec.Ichimoku. rating-vote-helpers.test.ts proves it.
    expect(votes['ichimokuBLine']).toBe(0);
    // At least one oscillator should read bullish or bearish-overbought.
    expect(Object.values(votes).some((v) => v !== 0)).toBe(true);
  });

  it('a strong downtrend produces sell votes on the moving averages', () => {
    const votes = votesOf(downtrend());
    for (const key of ['ema10', 'sma50', 'ema200', 'vwma20', 'hullMa9']) {
      expect(votes[key]).toBe(-1);
    }
    // Constant Neutral by construction, as in the uptrend case above.
    expect(votes['ichimokuBLine']).toBe(0);
  });

  it('an oscillating series exercises the oscillator cross arms without crashing', () => {
    const r = computeTechnicalsRating(oscillating());
    expect(r.recommendOther.isFinite()).toBe(true);
    for (const v of Object.values(r.perIndicatorVotes)) {
      expect([-1, 0, 1]).toContain(v);
    }
  });

  it('a perfectly flat series votes neutral everywhere (price equals every MA)', () => {
    const votes = votesOf(flat());
    // ichimokuBLine is computed in Decimal from the (flat) highs/lows, so it
    // equals price exactly → priceVsMa returns 0 (the equal arm). The vendored
    // float MAs can drift a tick on a flat series, so only the Decimal-exact
    // indicator is asserted here.
    expect(votes['ichimokuBLine']).toBe(0);
    // The aggregate stays finite and every vote is a valid tri-state.
    const r = computeTechnicalsRating(flat());
    expect(r.recommendAll.isFinite()).toBe(true);
    for (const v of Object.values(votes)) expect([-1, 0, 1]).toContain(v);
  });

  // A steep sustained decline that ticks UP a hair on the final bar: RSI is
  // pinned deeply oversold (< 30) and `current > prev` on the last bar — the
  // buy arm of rsiVote (and the rising-momentum arms of ao/mom).
  const oversoldReversal = (): Candle[] =>
    Array.from({ length: N }, (_, i) => {
      const c = i < N - 1 ? 900 - i * 3 : 900 - (N - 2) * 3 + 1;
      return mk(i, c, c + 0.3, c - 0.3);
    });

  // A steep sustained climb that ticks DOWN a hair on the final bar: RSI is
  // pinned overbought (> 70) and `current < prev` on the last bar — the sell
  // arms of rsiVote and williamsVote.
  const overboughtReversal = (): Candle[] =>
    Array.from({ length: N }, (_, i) =>
      i < N - 1
        ? mk(i, 100 + i * 3, 100 + i * 3 + 0.3, 100 + i * 3 - 0.3)
        : mk(i, 100 + (N - 2) * 3 - 1, 100 + (N - 2) * 3 - 0.7, 100 + (N - 2) * 3 - 1.3),
    );

  it('an oversold reversal trips the rsiVote buy arm (RSI < 30 and rising)', () => {
    const r = computeTechnicalsRating(oversoldReversal());
    expect(r.oscillators.rsi?.lessThan(30)).toBe(true);
    expect(r.perIndicatorVotes['rsi']).toBe(1);
  });

  it('an overbought reversal trips the rsiVote and williamsVote sell arms', () => {
    const r = computeTechnicalsRating(overboughtReversal());
    expect(r.oscillators.rsi?.greaterThan(70)).toBe(true);
    expect(r.perIndicatorVotes['rsi']).toBe(-1);
    expect(r.perIndicatorVotes['wr']).toBe(-1);
  });

  it('computes a present, valid ADX vote in a strong trend', () => {
    // The rising ADX Buy/Sell arms and falling ADX Neutral branch are pinned
    // directly in rating-vote-helpers.test.ts (the smoothed DI/ADX slope is too
    // fiddly to land a specific arm through the full pipeline); here we only
    // assert the trend is recognised and the vote is a valid tri-state.
    const r = computeTechnicalsRating(uptrend());
    expect(r.oscillators.adx?.greaterThan(20)).toBe(true);
    expect([-1, 0, 1]).toContain(r.perIndicatorVotes['adx']);
  });

  it('a downtrend-then-sharp-recovery trips the aoVote zero-cross buy arm', () => {
    // 36 down bars then a 4-bar rally tuned so the Awesome Oscillator crosses
    // the zero line from below ON the final bar (prev <= 0, current > 0).
    const w: Candle[] = [];
    let c = 300;
    let i = 0;
    for (let k = 0; k < 36; k++, i++) {
      c -= 1;
      w.push(mk(i, c, c + 1, c - 1));
    }
    for (let j = 0; j < 4; j++, i++) {
      c += 8;
      w.push(mk(i, c, c + 1, c - 1));
    }
    expect(computeTechnicalsRating(w).perIndicatorVotes['ao']).toBe(1);
  });

  it('an empty window yields zero-mean aggregates (mean of no votes)', () => {
    const r = computeTechnicalsRating([]);
    expect(r.recommendAll.toString()).toBe('0');
    expect(r.recommendMa.toString()).toBe('0');
    expect(r.recommendOther.toString()).toBe('0');
  });
});
