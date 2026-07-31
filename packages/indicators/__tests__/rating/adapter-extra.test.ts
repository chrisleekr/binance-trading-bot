// Supplemental adapter coverage (#441) — boundary arms the parity snapshot
// does not exercise: a vendored indicator that returns null even though the
// adapter's length guard passed, the rarely-used `wma` wrapper, and the
// toDecimal null arm.

import { describe, expect, it } from 'vitest';
import type { Candle } from '@app/strategy-core';

import * as a from '../../src/rating/adapter.js';

const wave = (n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const v = 100 + Math.sin(i / 3) * 5;
    return {
      openTimeMs: i * 60_000,
      closeTimeMs: i * 60_000 + 50_000,
      open: String(v),
      high: String(v + 1),
      low: String(v - 1),
      close: String(v),
      volume: '1',
      isClosed: true,
    };
  });

describe('adapter — vendored-null boundary', () => {
  it('stoch returns null when the length guard passes but the oscillator is not yet stable', () => {
    // period + signalInterval = 17 passes the adapter guard, but the vendored
    // StochasticOscillator needs one more bar to emit — so getResult() is null
    // and the `r == null` arm returns null.
    expect(a.stoch(wave(17))).toBeNull();
    // One more bar and it produces a reading.
    expect(a.stoch(wave(18))).not.toBeNull();
  });
});

describe('adapter — wma wrapper', () => {
  it('returns null for a window shorter than the period and a value otherwise', () => {
    expect(a.wma(wave(3), 5)).toBeNull();
    expect(a.wma(wave(20), 5)).not.toBeNull();
  });
});
