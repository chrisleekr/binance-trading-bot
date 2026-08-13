// Supplemental coverage for the incremental indicators (#441).
//
// The equivalence + p2-slice2 suites cover the happy paths. These tests
// exercise the remaining branches: validation throws, currentValue
// accessors, serialize/deserialize round-trips and their malformed/
// length-mismatch error arms, and the flat-series numeric edges (zero
// directional range, zero variance, %K = 50).

import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import type { Candle } from '@app/strategy-core';

import {
  incrementalSMA,
  incrementalEMA,
  incrementalRSI,
  incrementalATR,
  incrementalBollinger,
  incrementalStochastic,
  incrementalADX,
} from '../../src/incremental/index.js';

const candle = (value: number, high = value, low = value): Candle => ({
  openTimeMs: 0,
  closeTimeMs: 59_999,
  open: String(value),
  high: String(high),
  low: String(low),
  close: String(value),
  volume: '1',
  isClosed: true,
});

// A perfectly flat series: high === low === close for every bar. Drives the
// zero-range / zero-variance edges across ATR-style indicators.
const flat = (n: number, value = 100): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ ...candle(value), openTimeMs: i * 60_000 }));

// A gently moving series so seeding produces non-trivial state to serialize.
const moving = (n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const c = 100 + Math.sin(i / 5) * 5;
    return { ...candle(c, c + 1, c - 1), openTimeMs: i * 60_000 };
  });

describe('incremental — period validation', () => {
  it('every factory rejects a non-positive / non-integer period', () => {
    for (const make of [
      incrementalSMA,
      incrementalEMA,
      incrementalRSI,
      incrementalATR,
      incrementalBollinger,
      incrementalADX,
    ]) {
      expect(() => make(0)).toThrow(/positive integer/);
      expect(() => make(-3)).toThrow(/positive integer/);
      expect(() => make(2.5)).toThrow(/positive integer/);
    }
  });

  it('incrementalStochastic rejects bad period AND bad smoothK', () => {
    expect(() => incrementalStochastic(0)).toThrow(/period must be a positive integer/);
    expect(() => incrementalStochastic(14, 0)).toThrow(/smoothK must be a positive integer/);
    expect(() => incrementalStochastic(14, 1.5)).toThrow(/smoothK must be a positive integer/);
  });
});

describe('incremental — currentValue + serialize round-trip', () => {
  it('SMA currentValue equals the seeded average and survives a round-trip', () => {
    const ind = incrementalSMA(5);
    const state = ind.initFromWindow(moving(20));
    expect(ind.currentValue(state).toString()).toBe(
      ind.deserialize(ind.serialize(state)).sum.dividedBy(5).toString(),
    );
  });

  it('EMA currentValue returns the running value and round-trips', () => {
    const ind = incrementalEMA(5);
    const state = ind.initFromWindow(moving(30));
    expect(ind.currentValue(state).equals(state.value)).toBe(true);
    expect(ind.deserialize(ind.serialize(state)).value.equals(state.value)).toBe(true);
  });

  it('RSI currentValue derives from avgGain/avgLoss and round-trips', () => {
    const ind = incrementalRSI(14);
    const state = ind.initFromWindow(moving(40));
    const v = ind.currentValue(state);
    expect(v).toBeInstanceOf(Decimal);
    const back = ind.deserialize(ind.serialize(state));
    expect(ind.currentValue(back).equals(v)).toBe(true);
  });

  it('ATR currentValue returns the running value and round-trips', () => {
    const ind = incrementalATR(14);
    const state = ind.initFromWindow(moving(40));
    expect(ind.currentValue(state).equals(state.value)).toBe(true);
    expect(ind.deserialize(ind.serialize(state)).value.equals(state.value)).toBe(true);
  });

  it('Bollinger currentValue exposes middle via toFixed and round-trips', () => {
    const ind = incrementalBollinger(20);
    const state = ind.initFromWindow(moving(30));
    expect(typeof ind.currentValue(state).toFixed()).toBe('string');
    const back = ind.deserialize(ind.serialize(state));
    expect(ind.currentValue(back).middle.equals(ind.currentValue(state).middle)).toBe(true);
  });

  it('Stochastic currentValue + toFixed and round-trip', () => {
    const ind = incrementalStochastic(14, 3);
    const state = ind.initFromWindow(moving(40));
    expect(typeof ind.currentValue(state).toFixed()).toBe('string');
    const back = ind.deserialize(ind.serialize(state));
    expect(ind.currentValue(back).k.equals(ind.currentValue(state).k)).toBe(true);
  });

  it('ADX currentValue exposes adx via toFixed and round-trips', () => {
    const ind = incrementalADX(14);
    const state = ind.initFromWindow(moving(60));
    expect(typeof ind.currentValue(state).toFixed()).toBe('string');
    const back = ind.deserialize(ind.serialize(state));
    expect(ind.currentValue(back).adx.equals(ind.currentValue(state).adx)).toBe(true);
  });
});

describe('incremental — deserialize error arms', () => {
  it('Bollinger rejects malformed blob AND ring-length mismatch', () => {
    const ind = incrementalBollinger(20);
    expect(() => ind.deserialize('{}')).toThrow(/malformed state blob/);
    // Well-formed shape but wrong ring length.
    const bad = JSON.stringify({ ring: ['1', '2'], sum: '3', sumSq: '5' });
    expect(() => ind.deserialize(bad)).toThrow(/ring length/);
  });

  it('Stochastic rejects malformed blob, ring-length, and kRing-length mismatch', () => {
    const ind = incrementalStochastic(14, 3);
    expect(() => ind.deserialize('{}')).toThrow(/malformed state blob/);
    const wrongRing = JSON.stringify({ highRing: ['1'], lowRing: ['1'], kRing: ['1', '1', '1'] });
    expect(() => ind.deserialize(wrongRing)).toThrow(/ring length mismatch/);
    const wrongK = JSON.stringify({
      highRing: Array.from({ length: 14 }, () => '1'),
      lowRing: Array.from({ length: 14 }, () => '1'),
      kRing: ['1'],
    });
    expect(() => ind.deserialize(wrongK)).toThrow(/kRing length/);
  });

  it('ADX rejects a blob missing a required field', () => {
    const ind = incrementalADX(14);
    // All fields present except prevClose → the missing-field arm.
    const bad = JSON.stringify({
      smoothedTR: '1',
      smoothedPlusDM: '1',
      smoothedMinusDM: '1',
      adx: '1',
      prevHigh: '1',
      prevLow: '1',
    });
    expect(() => ind.deserialize(bad)).toThrow(/malformed state blob/);
  });
});

describe('incremental — initFromWindow short-window throws', () => {
  it('Bollinger throws when the seed window is shorter than the period', () => {
    expect(() => incrementalBollinger(5).initFromWindow(flat(3))).toThrow(/window length/);
  });

  it('Stochastic throws when the seed window is shorter than period+smoothK-1', () => {
    expect(() => incrementalStochastic(5, 3).initFromWindow(flat(3))).toThrow(/< period\+smoothK/);
  });

  it('Stochastic seeding produces a kRing of exactly smoothK', () => {
    const state = incrementalStochastic(5, 3).initFromWindow(moving(20));
    expect(state.kRing).toHaveLength(3);
  });
});

describe('incremental — flat-series numeric edges', () => {
  it('ADX over a perfectly flat series yields zero DIs and zero ADX (no NaN)', () => {
    const ind = incrementalADX(5);
    let state = ind.initFromWindow(flat(11));
    for (const c of flat(20)) [state] = ind.update(state, c);
    const v = ind.currentValue(state);
    expect(v.adx.isNaN()).toBe(false);
    expect(v.plusDI.toString()).toBe('0');
    expect(v.minusDI.toString()).toBe('0');
    expect(v.adx.toString()).toBe('0');
  });

  it('Bollinger over a flat series clamps variance to zero (stddev = 0)', () => {
    const ind = incrementalBollinger(5);
    const state = ind.initFromWindow(flat(10));
    const v = ind.currentValue(state);
    // middle == upper == lower when stddev is zero.
    expect(v.upper.equals(v.middle)).toBe(true);
    expect(v.lower.equals(v.middle)).toBe(true);
  });

  it('Bollinger clamps Decimal precision loss for near-identical closes', () => {
    const ind = incrementalBollinger(2);
    const first = candle(1);
    const second = { ...candle(1), close: '1.0000000000000000001' };
    const v = ind.currentValue(ind.initFromWindow([first, second]));

    expect(v.middle.isFinite()).toBe(true);
    expect(v.upper.equals(v.middle)).toBe(true);
    expect(v.lower.equals(v.middle)).toBe(true);
  });

  it('Stochastic over a flat series yields %K = 50 and trims kRing to smoothK', () => {
    const ind = incrementalStochastic(5, 3);
    let state = ind.initFromWindow(flat(7));
    // Several updates so the kRing trim (length > smoothK → shift) fires.
    for (const c of flat(10)) [state] = ind.update(state, c);
    expect(ind.currentValue(state).k.toString()).toBe('50');
    expect(state.kRing).toHaveLength(3);
  });
});
