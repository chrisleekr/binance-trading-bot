// Boundary contract for `bucketize` — the function that maps the
// `[-1, +1]` rating score the indicator package produces to the
// five-tier enum the audit log + operator UI consume. Locks down each
// boundary against accidental off-by-one drift so an operator's
// "Strong sell at exactly -0.5" reading stays meaningful.
//
// Thresholds mirror the table at
// https://www.tradingview.com/support/solutions/43000610458-technical-ratings/
// — the user's "Compare on TradingView" link is only meaningful if our
// boundaries match theirs.

import { describe, expect, it } from 'vitest';

import { bucketize } from '../../src/crons/technicals-compute.js';

describe('bucketize (TradingView five-tier thresholds)', () => {
  describe('STRONG_BUY (score >= 0.5)', () => {
    it('classifies exactly 0.5 as STRONG_BUY (boundary inclusive)', () => {
      expect(bucketize(0.5)).toBe('STRONG_BUY');
    });
    it('classifies 0.51 as STRONG_BUY', () => {
      expect(bucketize(0.51)).toBe('STRONG_BUY');
    });
    it('classifies +1 as STRONG_BUY (upper extreme)', () => {
      expect(bucketize(1)).toBe('STRONG_BUY');
    });
  });

  describe('BUY (0.1 <= score < 0.5)', () => {
    it('classifies exactly 0.1 as BUY (lower boundary inclusive)', () => {
      expect(bucketize(0.1)).toBe('BUY');
    });
    it('classifies 0.499 as BUY (one tick below STRONG_BUY)', () => {
      expect(bucketize(0.499)).toBe('BUY');
    });
    it('classifies 0.3 as BUY (mid-range)', () => {
      expect(bucketize(0.3)).toBe('BUY');
    });
  });

  describe('NEUTRAL (-0.1 < score < 0.1)', () => {
    it('classifies exactly 0 as NEUTRAL', () => {
      expect(bucketize(0)).toBe('NEUTRAL');
    });
    it('classifies 0.099 as NEUTRAL (one tick below BUY)', () => {
      expect(bucketize(0.099)).toBe('NEUTRAL');
    });
    it('classifies -0.099 as NEUTRAL (one tick above SELL)', () => {
      expect(bucketize(-0.099)).toBe('NEUTRAL');
    });
  });

  describe('SELL (-0.5 < score <= -0.1)', () => {
    it('classifies exactly -0.1 as SELL (upper boundary inclusive)', () => {
      expect(bucketize(-0.1)).toBe('SELL');
    });
    it('classifies -0.499 as SELL (one tick above STRONG_SELL)', () => {
      expect(bucketize(-0.499)).toBe('SELL');
    });
    it('classifies -0.3 as SELL (mid-range)', () => {
      expect(bucketize(-0.3)).toBe('SELL');
    });
  });

  describe('STRONG_SELL (score <= -0.5)', () => {
    it('classifies exactly -0.5 as STRONG_SELL (boundary inclusive)', () => {
      expect(bucketize(-0.5)).toBe('STRONG_SELL');
    });
    it('classifies -0.51 as STRONG_SELL', () => {
      expect(bucketize(-0.51)).toBe('STRONG_SELL');
    });
    it('classifies -1 as STRONG_SELL (lower extreme)', () => {
      expect(bucketize(-1)).toBe('STRONG_SELL');
    });
  });

  describe('branch ordering smoke', () => {
    // A score of 0.6 is still STRONG_BUY (>= 0.5). 0.6 is also >= 0.1, so a
    // future refactor that flipped the branch order (BUY checked before
    // STRONG_BUY) would silently downgrade strong scores to BUY without
    // breaking the boundary tests above. These two assertions catch that.
    it('returns STRONG_BUY for a clear-strong-buy score, not BUY', () => {
      expect(bucketize(0.6)).toBe('STRONG_BUY');
    });
    it('returns STRONG_SELL for a clear-strong-sell score, not SELL', () => {
      expect(bucketize(-0.6)).toBe('STRONG_SELL');
    });
  });
});
