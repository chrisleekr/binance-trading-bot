import { describe, expect, it } from 'vitest';

import { computeTechnicalsRating } from '../src/rating/index.js';
import { loadCanonicalBtc1h } from './rating/test-utils.js';

// Indicator parity gate. Snapshots EVERY value `computeTechnicalsRating`
// produces over the canonical BTC 1h fixture — all 16 oscillator readings,
// all 15 moving averages, the three aggregate verdicts, and every
// per-indicator vote — as exact decimal-strings. One drift in any indicator
// fails the gate, which is what makes the backtest's offline-bundle provider
// trustworthy: the same `computeTechnicalsRating` runs live and offline, so a
// locked output here guarantees both paths read identical numbers.
//
// The committed snapshot IS the reference. It locks the rating output against
// silent self-drift: any change to the indicator math surfaces as a snapshot
// diff here.

const dec = (d: { toString(): string } | null): string | null => (d === null ? null : d.toString());

describe('indicator parity — full rating over the canonical BTC 1h fixture', () => {
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
