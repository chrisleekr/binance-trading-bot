import { describe, it, expect } from 'vitest';

import { computeTechnicalsRating } from '../../src/rating/index.js';
import { loadCanonicalBtc1h, mkCloseWindow } from './test-utils.js';

describe('computeTechnicalsRating — algebraic properties', () => {
  it('recommendAll equals the mean of recommendMa and recommendOther', () => {
    const r = computeTechnicalsRating(loadCanonicalBtc1h().candles);
    const expected = r.recommendMa.plus(r.recommendOther).dividedBy(2);
    expect(r.recommendAll.toString()).toBe(expected.toString());
  });

  it('every per-indicator vote is one of -1, 0, 1', () => {
    const r = computeTechnicalsRating(loadCanonicalBtc1h().candles);
    for (const [key, vote] of Object.entries(r.perIndicatorVotes)) {
      expect([-1, 0, 1], `${key}=${vote} not in {-1,0,1}`).toContain(vote);
    }
  });

  it('aggregates fall within [-1, 1] inclusive', () => {
    const r = computeTechnicalsRating(loadCanonicalBtc1h().candles);
    expect(r.recommendAll.greaterThanOrEqualTo(-1)).toBe(true);
    expect(r.recommendAll.lessThanOrEqualTo(1)).toBe(true);
    expect(r.recommendMa.greaterThanOrEqualTo(-1)).toBe(true);
    expect(r.recommendMa.lessThanOrEqualTo(1)).toBe(true);
    expect(r.recommendOther.greaterThanOrEqualTo(-1)).toBe(true);
    expect(r.recommendOther.lessThanOrEqualTo(1)).toBe(true);
  });

  it('returns neutral votes (no crash) when window is too short for most indicators', () => {
    const w = mkCloseWindow(Array(5).fill('100'));
    const r = computeTechnicalsRating(w);
    // Most indicators will vote 0 because their inputs are null; aggregates
    // are well-defined but near 0.
    expect(r.recommendAll.isFinite()).toBe(true);
    expect(r.recommendMa.isFinite()).toBe(true);
    expect(r.recommendOther.isFinite()).toBe(true);
  });
});

describe('computeTechnicalsRating — snapshot on canonical BTC fixture', () => {
  it('produces stable aggregates and vote map', () => {
    const r = computeTechnicalsRating(loadCanonicalBtc1h().candles);
    expect({
      recommendAll: r.recommendAll.toDecimalPlaces(4).toString(),
      recommendMa: r.recommendMa.toDecimalPlaces(4).toString(),
      recommendOther: r.recommendOther.toDecimalPlaces(4).toString(),
      votes: r.perIndicatorVotes,
    }).toMatchSnapshot();
  });
});
