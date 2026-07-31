// Direct unit coverage for two exported vote helpers. Driving every arm through
// the full computeTechnicalsRating pipeline is brittle (the smoothed DI rarely
// lands the exact ADX-slope/DI-direction combinations, and the StochRSI lines
// snap to extremes), so the pure helpers are exercised directly here against
// TradingView's documented rules.

import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';

import { adxVote, aoVote, bbPowerVote, stochRsiVote, uoVote } from '../../src/rating/rating.js';

const D = (n: number) => new Decimal(n);

describe('uoVote — TradingView momentum direction (NOT inverted)', () => {
  it('votes BUY above 70 and SELL below 30, per the TradingView rating', () => {
    // The prior implementation inverted these (treated >70 as a sell); lock the
    // TradingView direction so the regression cannot silently return.
    expect(uoVote(D(75))).toBe(1);
    expect(uoVote(D(25))).toBe(-1);
    expect(uoVote(D(50))).toBe(0);
    expect(uoVote(null)).toBe(0);
  });
});

describe('adxVote — TradingView ADX rising/falling rule', () => {
  it('votes BUY when +DI dominates and ADX is rising above 20', () => {
    // adx 30 > prev 25 (rising), +DI 26 > -DI 14.
    expect(adxVote(D(30), D(25), D(26), D(14))).toBe(1);
  });

  it('votes SELL when -DI dominates and ADX is falling (still > 20)', () => {
    // adx 30 < prev 35 (falling), -DI 26 > +DI 14.
    expect(adxVote(D(30), D(35), D(14), D(26))).toBe(-1);
  });

  it('is NEUTRAL when DI direction and ADX slope disagree (+DI up but ADX falling)', () => {
    expect(adxVote(D(30), D(35), D(26), D(14))).toBe(0);
  });

  it('is NEUTRAL when ADX is weak (<= 20) regardless of DI', () => {
    expect(adxVote(D(18), D(15), D(26), D(14))).toBe(0);
  });

  it('is NEUTRAL on a null input', () => {
    expect(adxVote(null, D(25), D(26), D(14))).toBe(0);
  });
});

describe('stochRsiVote — %K / %D arms', () => {
  it('votes SELL when both lines are overbought (> 80) and %K trails %D', () => {
    expect(stochRsiVote(D(85), D(92))).toBe(-1);
  });

  it('votes BUY when both lines are oversold (< 20) and %K leads %D', () => {
    expect(stochRsiVote(D(12), D(5))).toBe(1);
  });

  it('is NEUTRAL in the mid band', () => {
    expect(stochRsiVote(D(50), D(48))).toBe(0);
  });

  it('is NEUTRAL on a null input', () => {
    expect(stochRsiVote(null, D(50))).toBe(0);
  });
});

describe('aoVote — saucer arms', () => {
  it('votes BUY on a saucer above zero (current > prev, prev pulled in below the bar before)', () => {
    // current 5 > 0, current > prev (5 > 3), prev < prevPrev (3 < 4).
    expect(aoVote(D(5), D(3), D(4))).toBe(1);
  });

  it('votes SELL on a saucer below zero (current < prev, prev pulled in above the bar before)', () => {
    expect(aoVote(D(-5), D(-3), D(-4))).toBe(-1);
  });

  it('is NEUTRAL when neither a zero-cross nor a saucer is present', () => {
    expect(aoVote(D(2), D(3), D(1))).toBe(0);
  });

  it('is NEUTRAL on a null input', () => {
    expect(aoVote(null, D(1), D(1))).toBe(0);
  });
});

describe('bbPowerVote — trend-conditioned arms', () => {
  it('votes BUY in an uptrend when bear power is negative but recovering', () => {
    // trend up, bear -1 < 0, bear -1 > bearPrev -3 (recovering).
    expect(bbPowerVote(D(2), D(-1), D(2), D(-3), 1)).toBe(1);
  });

  it('votes SELL in a downtrend when bull power is positive but fading', () => {
    // trend down, bull 1 > 0, bull 1 < bullPrev 3 (fading).
    expect(bbPowerVote(D(1), D(-2), D(3), D(-1), -1)).toBe(-1);
  });

  it('is NEUTRAL when the EMA trend is flat', () => {
    expect(bbPowerVote(D(1), D(-1), D(2), D(-2), 0)).toBe(0);
  });

  it('is NEUTRAL on a null input', () => {
    expect(bbPowerVote(null, D(-1), D(2), D(-3), 1)).toBe(0);
  });
});
