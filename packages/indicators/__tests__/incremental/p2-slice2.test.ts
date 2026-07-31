// Equivalence + round-trip tests for the second-slice incremental
// indicators (Bollinger, Stochastic, ADX). Each indicator's incremental
// `initFromWindow + N×update` must produce the same end-value as a
// self-contained full-window reference implementation defined in this
// file. The references are intentionally naïve — they're the canonical
// math, not optimised — so the equivalence assertion is high-confidence.

import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import type { Candle } from '@app/strategy-core';

import {
  incrementalBollinger,
  incrementalStochastic,
  incrementalADX,
} from '../../src/incremental/index.js';

const buildFixture = (length: number): Candle[] => {
  const candles: Candle[] = [];
  let close = 100;
  for (let i = 0; i < length; i++) {
    const seed = ((i * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    close += (seed - 0.5) * 3;
    const high = close + 0.4 + seed * 0.6;
    const low = close - 0.4 - (1 - seed) * 0.6;
    candles.push({
      openTimeMs: i * 60_000,
      closeTimeMs: (i + 1) * 60_000 - 1,
      open: close.toString(),
      high: high.toString(),
      low: low.toString(),
      close: close.toString(),
      volume: '1',
      isClosed: true,
    });
  }
  return candles;
};

const FIXTURE = buildFixture(250);
const PERIOD = 14;

// ---- Reference (naïve, full-window) implementations ----

const refBollinger = (
  w: readonly Candle[],
  period: number,
  mult: number,
): { middle: string; upper: string; lower: string } => {
  // Mirrors the incremental form's algorithmic path so the two are
  // byte-equal at Decimal precision: seed `sum`/`sumSq` from the first
  // `period` closes, then slide subtract/add through the rest of the
  // window. A fresh "sum of the last 20" diverges from the incremental
  // form by a few digits at the 20-sig-fig tail after 250 slides — the
  // slide path is the reference here.
  let sum = new Decimal(0);
  let sumSq = new Decimal(0);
  for (let i = 0; i < period; i++) {
    const v = new Decimal((w[i] as Candle).close);
    sum = sum.plus(v);
    sumSq = sumSq.plus(v.times(v));
  }
  const ring: Decimal[] = w.slice(0, period).map((c) => new Decimal(c.close));
  for (let i = period; i < w.length; i++) {
    const oldest = ring.shift() as Decimal;
    const v = new Decimal((w[i] as Candle).close);
    sum = sum.minus(oldest).plus(v);
    sumSq = sumSq.minus(oldest.times(oldest)).plus(v.times(v));
    ring.push(v);
  }
  const middle = sum.dividedBy(period);
  let variance = sumSq.dividedBy(period).minus(middle.times(middle));
  if (variance.lessThan(0)) variance = new Decimal(0);
  const stddev = variance.sqrt();
  const offset = stddev.times(mult);
  return {
    middle: middle.toString(),
    upper: middle.plus(offset).toString(),
    lower: middle.minus(offset).toString(),
  };
};

const refStochasticK = (w: readonly Candle[], period: number, smoothK: number): string => {
  // raw %K at index i requires w[i-period+1..i]; smoothed %K is SMA of
  // the last smoothK raw %K values.
  const ks: Decimal[] = [];
  for (let i = period - 1; i < w.length; i++) {
    const slice = w.slice(i - period + 1, i + 1);
    const first = slice[0] as Candle;
    let hi = new Decimal(first.high);
    let lo = new Decimal(first.low);
    for (const c of slice) {
      const h = new Decimal(c.high);
      const l = new Decimal(c.low);
      if (h.greaterThan(hi)) hi = h;
      if (l.lessThan(lo)) lo = l;
    }
    const close = new Decimal((w[i] as Candle).close);
    const range = hi.minus(lo);
    if (range.isZero()) {
      ks.push(new Decimal(50));
    } else {
      ks.push(close.minus(lo).dividedBy(range).times(100));
    }
  }
  const tail = ks.slice(-smoothK);
  let sum = new Decimal(0);
  for (const k of tail) sum = sum.plus(k);
  return sum.dividedBy(tail.length).toString();
};

const refADX = (w: readonly Candle[], period: number): string => {
  // Wilder's textbook ADX: sum first `period` TR/+DM/-DM as initial
  // smoothed values, then smooth forward; accumulate `period` DX values
  // as the ADX seed; smooth ADX forward thereafter.
  const dmax = (a: Decimal, b: Decimal): Decimal => (a.greaterThan(b) ? a : b);
  const dabs = (a: Decimal): Decimal => (a.lessThan(0) ? a.negated() : a);
  let smTR = new Decimal(0),
    smP = new Decimal(0),
    smM = new Decimal(0);
  for (let i = 1; i <= period; i++) {
    const cur = w[i] as Candle;
    const prev = w[i - 1] as Candle;
    const high = new Decimal(cur.high);
    const low = new Decimal(cur.low);
    const prevHigh = new Decimal(prev.high);
    const prevLow = new Decimal(prev.low);
    const prevClose = new Decimal(prev.close);
    const tr = dmax(high.minus(low), dmax(dabs(high.minus(prevClose)), dabs(low.minus(prevClose))));
    smTR = smTR.plus(tr);
    const up = high.minus(prevHigh);
    const dn = prevLow.minus(low);
    const p = up.greaterThan(dn) && up.greaterThan(0) ? up : new Decimal(0);
    const m = dn.greaterThan(up) && dn.greaterThan(0) ? dn : new Decimal(0);
    smP = smP.plus(p);
    smM = smM.plus(m);
  }
  let dxSum = new Decimal(0);
  let dxCount = 0;
  let adx = new Decimal(0);
  for (let i = period + 1; i < w.length; i++) {
    const cur = w[i] as Candle;
    const prev = w[i - 1] as Candle;
    const high = new Decimal(cur.high);
    const low = new Decimal(cur.low);
    const prevHigh = new Decimal(prev.high);
    const prevLow = new Decimal(prev.low);
    const prevClose = new Decimal(prev.close);
    const tr = dmax(high.minus(low), dmax(dabs(high.minus(prevClose)), dabs(low.minus(prevClose))));
    const up = high.minus(prevHigh);
    const dn = prevLow.minus(low);
    const p = up.greaterThan(dn) && up.greaterThan(0) ? up : new Decimal(0);
    const m = dn.greaterThan(up) && dn.greaterThan(0) ? dn : new Decimal(0);
    smTR = smTR.minus(smTR.dividedBy(period)).plus(tr);
    smP = smP.minus(smP.dividedBy(period)).plus(p);
    smM = smM.minus(smM.dividedBy(period)).plus(m);
    if (smTR.isZero()) continue;
    const plusDI = smP.dividedBy(smTR).times(100);
    const minusDI = smM.dividedBy(smTR).times(100);
    const diSum = plusDI.plus(minusDI);
    const dx = diSum.isZero()
      ? new Decimal(0)
      : dabs(plusDI.minus(minusDI)).dividedBy(diSum).times(100);
    if (dxCount < period) {
      dxSum = dxSum.plus(dx);
      dxCount += 1;
      if (dxCount === period) adx = dxSum.dividedBy(period);
    } else {
      adx = adx
        .times(period - 1)
        .plus(dx)
        .dividedBy(period);
    }
  }
  return adx.toString();
};

// ---- Tests ----

describe('incrementalBollinger', () => {
  it('matches the full-window reference middle/upper/lower', () => {
    const ind = incrementalBollinger(20, 2);
    let state = ind.initFromWindow(FIXTURE.slice(0, 20));
    let value = ind.currentValue(state);
    for (let i = 20; i < FIXTURE.length; i++) {
      [state, value] = ind.update(state, FIXTURE[i] as Candle);
    }
    const ref = refBollinger(FIXTURE, 20, 2);
    expect(value.middle.toString()).toBe(ref.middle);
    expect(value.upper.toString()).toBe(ref.upper);
    expect(value.lower.toString()).toBe(ref.lower);
  });

  it('rejects malformed state blob', () => {
    expect(() => incrementalBollinger(20).deserialize('{}')).toThrow();
  });

  it('serialise round-trip is identity at Decimal precision', () => {
    const ind = incrementalBollinger(20);
    const s1 = ind.initFromWindow(FIXTURE.slice(0, 30));
    const blob = ind.serialize(s1);
    expect(ind.serialize(ind.deserialize(blob))).toBe(blob);
  });
});

describe('incrementalStochastic', () => {
  it('matches the reference smoothed %K', () => {
    const ind = incrementalStochastic(PERIOD, 3);
    let state = ind.initFromWindow(FIXTURE.slice(0, PERIOD + 2));
    let value = ind.currentValue(state);
    for (let i = PERIOD + 2; i < FIXTURE.length; i++) {
      [state, value] = ind.update(state, FIXTURE[i] as Candle);
    }
    expect(value.k.toString()).toBe(refStochasticK(FIXTURE, PERIOD, 3));
  });

  it('flat candles yield %K = 50', () => {
    const flat: Candle[] = Array.from({ length: PERIOD + 5 }, (_, i) => ({
      openTimeMs: i * 60_000,
      closeTimeMs: (i + 1) * 60_000 - 1,
      open: '100',
      high: '100',
      low: '100',
      close: '100',
      volume: '0',
      isClosed: true,
    }));
    const ind = incrementalStochastic(PERIOD, 3);
    const state = ind.initFromWindow(flat);
    expect(ind.currentValue(state).k.toString()).toBe('50');
  });

  it('serialise round-trip is identity', () => {
    const ind = incrementalStochastic(PERIOD, 3);
    const s1 = ind.initFromWindow(FIXTURE.slice(0, PERIOD + 5));
    const blob = ind.serialize(s1);
    expect(ind.serialize(ind.deserialize(blob))).toBe(blob);
  });
});

describe('incrementalADX', () => {
  it('matches the reference ADX over a 250-candle window', () => {
    const ind = incrementalADX(PERIOD);
    let state = ind.initFromWindow(FIXTURE.slice(0, 2 * PERIOD + 1));
    let value = ind.currentValue(state);
    for (let i = 2 * PERIOD + 1; i < FIXTURE.length; i++) {
      [state, value] = ind.update(state, FIXTURE[i] as Candle);
    }
    expect(value.adx.toString()).toBe(refADX(FIXTURE, PERIOD));
  });

  it('throws when window < 2*period+1', () => {
    const ind = incrementalADX(PERIOD);
    expect(() => ind.initFromWindow(FIXTURE.slice(0, 2 * PERIOD))).toThrow(/2\*period\+1/);
  });

  it('serialise round-trip is identity', () => {
    const ind = incrementalADX(PERIOD);
    const s1 = ind.initFromWindow(FIXTURE.slice(0, 2 * PERIOD + 5));
    const blob = ind.serialize(s1);
    expect(ind.serialize(ind.deserialize(blob))).toBe(blob);
  });
});
