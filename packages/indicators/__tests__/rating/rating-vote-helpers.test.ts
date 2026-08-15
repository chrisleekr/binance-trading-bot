// Direct unit coverage keeps exact rule predicates separate from indicator
// smoothing, which rarely lands boundary combinations in crafted windows.

import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';

import { ichimokuCloud } from '../../src/rating/ichimoku.js';
import {
  adxVote,
  aoVote,
  bbPowerVote,
  ichimokuVote,
  stochRsiVote,
  uoVote,
} from '../../src/rating/rating.js';
import { mkOhlcvWindow } from './test-utils.js';

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

describe('adxVote — executable TechnicalRating v3 rule', () => {
  it('votes BUY when +DI dominates and ADX is rising above 20', () => {
    // adx 30 > prev 25 (rising), +DI 26 > -DI 14.
    expect(adxVote(D(30), D(25), D(26), D(14))).toBe(1);
  });

  it('votes SELL when -DI dominates and ADX is rising above 20', () => {
    expect(adxVote(D(30), D(25), D(14), D(26))).toBe(-1);
  });

  it('is NEUTRAL when ADX is falling regardless of DI direction', () => {
    expect(adxVote(D(30), D(35), D(26), D(14))).toBe(0);
    expect(adxVote(D(30), D(35), D(14), D(26))).toBe(0);
  });

  it('is NEUTRAL when ADX is weak (<= 20) regardless of DI', () => {
    expect(adxVote(D(18), D(15), D(26), D(14))).toBe(0);
  });

  it('is NEUTRAL when the directional indexes are equal', () => {
    expect(adxVote(D(30), D(25), D(20), D(20))).toBe(0);
  });

  it('is NEUTRAL on a null input', () => {
    expect(adxVote(null, D(25), D(26), D(14))).toBe(0);
  });
});

describe('stochRsiVote — EMA(50) price-trend gate', () => {
  it('votes SELL only in an uptrend when both lines are overbought', () => {
    expect(stochRsiVote(D(85), D(92), 1)).toBe(-1);
    expect(stochRsiVote(D(85), D(92), -1)).toBe(0);
  });

  it('votes BUY only in a downtrend when both lines are oversold', () => {
    expect(stochRsiVote(D(12), D(5), -1)).toBe(1);
    expect(stochRsiVote(D(12), D(5), 1)).toBe(0);
  });

  it('is NEUTRAL in the mid band', () => {
    expect(stochRsiVote(D(50), D(48), 1)).toBe(0);
  });

  it('is NEUTRAL on a null input', () => {
    expect(stochRsiVote(null, D(50), -1)).toBe(0);
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

describe('bbPowerVote — EMA(50) price-trend gate', () => {
  it('votes BUY when price is above EMA(50) and bear power is recovering', () => {
    expect(bbPowerVote(D(2), D(-1), D(2), D(-3), 1)).toBe(1);
  });

  it('votes SELL when price is below EMA(50) and bull power is fading', () => {
    expect(bbPowerVote(D(1), D(-2), D(3), D(-1), -1)).toBe(-1);
  });

  it('is NEUTRAL when price equals EMA(50)', () => {
    expect(bbPowerVote(D(1), D(-1), D(2), D(-2), 0)).toBe(0);
  });

  it('is NEUTRAL on a null input', () => {
    expect(bbPowerVote(null, D(-1), D(2), D(-3), 1)).toBe(0);
  });
});

describe('ichimokuVote — full line ordering', () => {
  // These two clouds are synthetic and cannot come out of `ichimokuCloud`,
  // which always reports leadA as (conversion + base) / 2: 3 !== (5 + 4) / 2
  // and 2 !== (0 + 1) / 2. They exist only to pin the transcribed predicate
  // itself. The reachable behaviour is asserted by the constancy test at the
  // bottom of this block, which drives real `ichimokuCloud` output.
  const bullish = {
    leadA: D(3),
    leadB: D(2),
    base: D(4),
    conversion: D(5),
  };
  const bearish = {
    leadA: D(2),
    leadB: D(3),
    base: D(1),
    conversion: D(0),
  };

  it('votes on both fully ordered directions when handed an unreachable cloud', () => {
    expect(ichimokuVote(bullish, D(6))).toBe(1);
    expect(ichimokuVote(bearish, D(-1))).toBe(-1);
  });

  it.each([
    { ...bullish, leadA: D(2) },
    { ...bullish, base: D(3) },
    { ...bullish, conversion: D(4) },
  ])('keeps a bullish near miss neutral', (cloud) => {
    expect(ichimokuVote(cloud, D(6))).toBe(0);
  });

  it('keeps a bullish price near miss neutral', () => {
    expect(ichimokuVote(bullish, D(5))).toBe(0);
  });

  it.each([
    { ...bearish, leadA: D(3) },
    { ...bearish, base: D(2) },
    { ...bearish, conversion: D(1) },
  ])('keeps a bearish near miss neutral', (cloud) => {
    expect(ichimokuVote(cloud, D(-1))).toBe(0);
  });

  it('keeps a bearish price near miss neutral', () => {
    expect(ichimokuVote(bearish, D(0))).toBe(0);
  });

  it('is NEUTRAL on a null input', () => {
    expect(ichimokuVote(null, D(1))).toBe(0);
    expect(ichimokuVote(bullish, null)).toBe(0);
  });

  it('is constant NEUTRAL for every cloud ichimokuCloud can actually produce', () => {
    // leadA = (conversion + base) / 2 makes `base > leadA` equivalent to
    // `base > conversion`, which contradicts the `conversion > base` term in
    // the same arm, so neither arm is satisfiable. Drive real cloud output over
    // randomised price paths to keep that a proven invariant rather than an
    // accident nobody notices when the cloud definition changes. A seeded LCG
    // keeps the walk reproducible.
    let seed = 0x2f6e2b1;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let run = 0; run < 400; run++) {
      let price = 100;
      const bars = Array.from({ length: 60 }, () => {
        // Alternate drift regimes so trending, ranging and reversing windows
        // all reach the vote, not just a single random walk shape.
        price = Math.max(1, price * (1 + (next() - 0.5) * 0.08) + (run % 3) - 1);
        const high = price * (1 + next() * 0.02);
        const low = price * (1 - next() * 0.02);
        return { o: String(price), h: String(high), l: String(low), c: String(price) };
      });
      const window = mkOhlcvWindow(bars);
      const cloud = ichimokuCloud(window);
      expect(cloud).not.toBeNull();
      const close = window[window.length - 1]?.close;
      expect(close).toBeDefined();
      expect(ichimokuVote(cloud, new Decimal(String(close)))).toBe(0);
    }
  });
});
