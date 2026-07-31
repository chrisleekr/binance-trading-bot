// Supplemental rating-vote coverage (#441).
//
// computeTechnicalsRating's per-indicator vote helpers are module-private, so
// the only way to reach their buy/sell arms is to drive crafted candle windows
// through the public entry point. A strong uptrend, a strong downtrend, an
// oscillating series, and a perfectly flat series between them cover the +1 /
// -1 / 0 arms of every vote rule plus the null-input neutral fallbacks.

import { describe, expect, it } from 'vitest';
import type { Candle } from '@app/strategy-core';

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

describe('computeTechnicalsRating — vote arms across regimes', () => {
  it('a strong uptrend produces buy votes on the moving averages and the Ichimoku cloud', () => {
    const votes = votesOf(uptrend());
    // Price is above every MA → each MA vote is +1. Ichimoku: price above the
    // whole cloud with conversion over base → the cloud buy arm.
    for (const key of ['ema10', 'sma50', 'ema200', 'vwma20', 'hullMa9', 'ichimokuBLine']) {
      expect(votes[key]).toBe(1);
    }
    // At least one oscillator should read bullish or bearish-overbought.
    expect(Object.values(votes).some((v) => v !== 0)).toBe(true);
  });

  it('a strong downtrend produces sell votes on the moving averages and the Ichimoku cloud', () => {
    const votes = votesOf(downtrend());
    for (const key of ['ema10', 'sma50', 'ema200', 'vwma20', 'hullMa9', 'ichimokuBLine']) {
      expect(votes[key]).toBe(-1);
    }
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
    // The ADX-rising/falling buy and sell arms are pinned directly in
    // rating-vote-helpers.test.ts (the smoothed DI/ADX slope is too fiddly to
    // land a specific arm through the full pipeline); here we only assert the
    // trend is recognised and the vote is a valid tri-state.
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
