import { describe, expect, it } from 'vitest';

import { computeTechnicalsRating } from '../src/rating/index.js';
import { loadCanonicalBtc1h } from './rating/test-utils.js';

// Local regression gate. Snapshots every value `computeTechnicalsRating`
// produces over the canonical BTC 1h fixture — all 16 oscillator readings,
// all 15 moving averages, the three aggregate verdicts, and every
// per-indicator vote — as exact decimal-strings. One drift in any indicator
// fails the gate. The committed snapshot is the local reference, so it detects
// silent math drift but is not evidence of external TradingView parity.

const dec = (d: { toString(): string } | null): string | null => (d === null ? null : d.toString());

describe('local rating regression over the canonical BTC 1h fixture', () => {
  const rating = computeTechnicalsRating(loadCanonicalBtc1h().candles);

  it('locks every oscillator value', () => {
    const osc = rating.oscillators;
    expect(Object.fromEntries(Object.entries(osc).map(([k, v]) => [k, dec(v)]))).toMatchSnapshot();
  });

  it('locks every moving-average value', () => {
    const ma = rating.movingAverages;
    expect(Object.fromEntries(Object.entries(ma).map(([k, v]) => [k, dec(v)]))).toMatchSnapshot();
  });

  it('locks the aggregate verdicts and every per-indicator vote', () => {
    expect({
      recommendAll: rating.recommendAll.toString(),
      recommendMa: rating.recommendMa.toString(),
      recommendOther: rating.recommendOther.toString(),
      perIndicatorVotes: rating.perIndicatorVotes,
    }).toMatchSnapshot();
  });
});
