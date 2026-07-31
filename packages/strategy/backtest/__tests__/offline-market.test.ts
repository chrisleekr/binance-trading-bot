import { describe, expect, it } from 'vitest';
import type { Candle } from '@app/strategy-core';
import { incrementalEMA, incrementalRSI, incrementalSMA } from '@app/indicators/incremental';
import { computeIndicatorSnapshot } from '../src/offline-market.js';

const MIN = 60_000;

// Varied (non-flat) closes so EMA/RSI have real deltas to fold.
function window(n: number): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    price += i % 3 === 0 ? 1.5 : i % 2 === 0 ? -0.7 : 0.4;
    const p = price.toFixed(2);
    out.push({
      openTimeMs: i * MIN,
      closeTimeMs: i * MIN + MIN - 1,
      open: p,
      high: (price + 1).toFixed(2),
      low: (price - 1).toFixed(2),
      close: p,
      volume: '1',
      isClosed: true,
    });
  }
  return out;
}

describe('computeIndicatorSnapshot', () => {
  it('returns null for an empty window', () => {
    expect(computeIndicatorSnapshot([])).toBeNull();
  });

  it('nulls indicators whose period exceeds the window, but always sets low/high', () => {
    const snap = computeIndicatorSnapshot(window(10)); // < 20, < 15
    expect(snap).not.toBeNull();
    expect(snap?.sma20).toBeNull();
    expect(snap?.ema20).toBeNull();
    expect(snap?.rsi14).toBeNull();
    expect(snap?.windowSize).toBe(10);
    expect(typeof snap?.lowestLow).toBe('string');
    expect(typeof snap?.highestHigh).toBe('string');
  });

  it('computes all fields for a sufficient window', () => {
    const w = window(40);
    const snap = computeIndicatorSnapshot(w);
    expect(snap?.windowSize).toBe(40);
    expect(snap?.sma20).not.toBeNull();
    expect(snap?.ema20).not.toBeNull();
    expect(snap?.rsi14).not.toBeNull();
    expect(snap?.lastCandleCloseTimeMs).toBe(w[39]?.closeTimeMs);
    // lowestLow/highestHigh are the window extremes
    const lows = w.map((c) => Number(c.low));
    expect(Number(snap?.lowestLow)).toBeCloseTo(Math.min(...lows), 6);
  });

  // The load-bearing parity property: re-seeding the full window (what the
  // offline provider does each tick) equals the live computer's seed-once
  // then fold-one-candle-at-a-time. If this holds, offline == live by
  // construction for any tick.
  it('matches live incremental stepping (seed-equivalence) for SMA/EMA/RSI', () => {
    const w = window(40);
    const snap = computeIndicatorSnapshot(w);

    const steppedSMA = stepLive(incrementalSMA(20), w, 20);
    const steppedEMA = stepLive(incrementalEMA(20), w, 20);
    const steppedRSI = stepLive(incrementalRSI(14), w, 15);

    expect(snap?.sma20).toBe(steppedSMA);
    expect(snap?.ema20).toBe(steppedEMA);
    expect(snap?.rsi14).toBe(steppedRSI);
  });

  // Seed-equivalence must hold regardless of WHERE seeding happens (live seeds
  // at the first window reaching minWindow, often larger than minWindow).
  it('is invariant to the seed point (seed at 25, not minWindow)', () => {
    const w = window(40);
    const snap = computeIndicatorSnapshot(w);
    expect(snap?.sma20).toBe(stepLive(incrementalSMA(20), w, 25));
    expect(snap?.ema20).toBe(stepLive(incrementalEMA(20), w, 25));
    expect(snap?.rsi14).toBe(stepLive(incrementalRSI(14), w, 25));
  });
});

/** Live-style: seed from the first `seed` candles, then fold the rest one at a time. */
function stepLive<S, V extends { toFixed(): string }>(
  ind: {
    initFromWindow: (w: readonly Candle[]) => S;
    update: (s: S, c: Candle) => readonly [S, V];
    currentValue: (s: S) => V;
  },
  w: readonly Candle[],
  seed: number,
): string {
  let state = ind.initFromWindow(w.slice(0, seed));
  let value: V = ind.currentValue(state);
  for (let i = seed; i < w.length; i++) {
    const candle = w[i];
    if (!candle) continue;
    [state, value] = ind.update(state, candle);
  }
  return value.toFixed();
}
