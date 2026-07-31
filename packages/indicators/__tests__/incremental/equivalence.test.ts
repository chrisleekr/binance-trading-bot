// Equivalence tests for the incremental indicators.
//
// For each indicator the test runs:
//   1. fullWindow(window[0..N], period)      — the reference math.
//   2. initFromWindow(window[0..k]) + update over window[k..N]  — the
//      incremental form.
// and asserts the two end-values are Decimal-equal at every checkpoint.
//
// Indicator math is platform-agnostic, but Decimal-typed accumulators are
// the project's invariant — float drift between the two forms would be
// caught here as a fixture mismatch.

import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import type { Candle } from '@app/strategy-core';

import { sma as fullSma, ema as fullEma, rsi as fullRsi, atr as fullAtr } from '../../src/index.js';
import {
  incrementalSMA,
  incrementalEMA,
  incrementalRSI,
  incrementalATR,
  type IncrementalIndicator,
} from '../../src/incremental/index.js';

// Synthetic 250-candle fixture. Closes follow a deterministic walk so the
// fixture is reproducible without recording real market data. Highs/lows
// move around the close to give ATR something to chew on.
const buildFixture = (length: number): readonly Candle[] => {
  const candles: Candle[] = [];
  // Walk seed; arbitrary non-trivial sequence.
  let close = 100;
  for (let i = 0; i < length; i++) {
    // Pseudo-random delta in [-1.5, +1.5] via a simple LCG so the test stays
    // hermetic. Math.random would re-seed each run and break "delta=0"
    // edge cases the fixture happens to exercise.
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

const runIncremental = <S>(
  ind: IncrementalIndicator<S, Decimal>,
  window: readonly Candle[],
  warmUp: number,
): Decimal => {
  let state = ind.initFromWindow(window.slice(0, warmUp));
  let value = new Decimal(0);
  for (let i = warmUp; i < window.length; i++) {
    [state, value] = ind.update(state, window[i] as Candle);
  }
  return value;
};

describe('incremental indicators — equivalence with full-window form', () => {
  // Every indicator runs across two warm-up sizes: exactly the minimum
  // seed, and twice the minimum. Both must converge to the same end-value
  // as the full-window math.
  describe('incrementalSMA', () => {
    it.each([PERIOD, PERIOD * 2])('matches fullSma after warm-up=%i', (warmUp) => {
      const expected = fullSma(FIXTURE, PERIOD);
      const actual = runIncremental(incrementalSMA(PERIOD), FIXTURE, warmUp);
      expect(actual.toString()).toBe(expected.toString());
    });

    it('throws when window length < period', () => {
      expect(() => incrementalSMA(PERIOD).initFromWindow(FIXTURE.slice(0, PERIOD - 1))).toThrow(
        /window length/,
      );
    });

    it('rejects non-positive periods', () => {
      expect(() => incrementalSMA(0)).toThrow(/positive integer/);
      expect(() => incrementalSMA(-1)).toThrow(/positive integer/);
      expect(() => incrementalSMA(1.5)).toThrow(/positive integer/);
    });
  });

  describe('incrementalEMA', () => {
    it.each([PERIOD, PERIOD * 2])('matches fullEma after warm-up=%i', (warmUp) => {
      const expected = fullEma(FIXTURE, PERIOD);
      const actual = runIncremental(incrementalEMA(PERIOD), FIXTURE, warmUp);
      expect(actual.toString()).toBe(expected.toString());
    });

    it('throws when window length < period', () => {
      expect(() => incrementalEMA(PERIOD).initFromWindow(FIXTURE.slice(0, PERIOD - 1))).toThrow(
        /window length/,
      );
    });
  });

  describe('incrementalRSI', () => {
    it.each([PERIOD + 1, PERIOD * 2])('matches fullRsi after warm-up=%i', (warmUp) => {
      const expected = fullRsi(FIXTURE, PERIOD);
      const actual = runIncremental(incrementalRSI(PERIOD), FIXTURE, warmUp);
      expect(actual.toString()).toBe(expected.toString());
    });

    it('throws when window length < period+1', () => {
      expect(() => incrementalRSI(PERIOD).initFromWindow(FIXTURE.slice(0, PERIOD))).toThrow(
        /window length/,
      );
    });

    it('saturates at 100 when avgLoss is zero', () => {
      // Construct an only-up sequence so avgLoss is exactly zero.
      const candles: Candle[] = Array.from({ length: PERIOD + 5 }, (_, i) => ({
        openTimeMs: i * 60_000,
        closeTimeMs: (i + 1) * 60_000 - 1,
        open: `${100 + i}`,
        high: `${100 + i + 0.5}`,
        low: `${100 + i - 0.5}`,
        close: `${100 + i}`,
        volume: '1',
        isClosed: true,
      }));
      const ind = incrementalRSI(PERIOD);
      const state = ind.initFromWindow(candles);
      expect(state.avgLoss.isZero()).toBe(true);
      // Continuation candle higher than state.prevClose; delta > 0 keeps
      // loss=0, so smoothed avgLoss stays zero and RSI saturates at 100.
      const nextClose = state.prevClose.plus(1).toString();
      const next: Candle = {
        openTimeMs: candles.length * 60_000,
        closeTimeMs: (candles.length + 1) * 60_000 - 1,
        open: nextClose,
        high: nextClose,
        low: nextClose,
        close: nextClose,
        volume: '1',
        isClosed: true,
      };
      const [, value] = ind.update(state, next);
      expect(value.toString()).toBe('100');
    });
  });

  describe('incrementalATR', () => {
    it.each([PERIOD + 1, PERIOD * 2])('matches fullAtr after warm-up=%i', (warmUp) => {
      const expected = fullAtr(FIXTURE, PERIOD);
      const actual = runIncremental(incrementalATR(PERIOD), FIXTURE, warmUp);
      expect(actual.toString()).toBe(expected.toString());
    });

    it('throws when window length < period+1', () => {
      expect(() => incrementalATR(PERIOD).initFromWindow(FIXTURE.slice(0, PERIOD))).toThrow(
        /window length/,
      );
    });
  });

  describe('purity', () => {
    it('update does not mutate the input SMA state', () => {
      const ind = incrementalSMA(PERIOD);
      const state = ind.initFromWindow(FIXTURE.slice(0, PERIOD));
      const ringSnapshot = state.ring.map((d) => d.toString());
      const sumSnapshot = state.sum.toString();
      ind.update(state, FIXTURE[PERIOD] as Candle);
      expect(state.ring.map((d) => d.toString())).toEqual(ringSnapshot);
      expect(state.sum.toString()).toBe(sumSnapshot);
    });

    it('id is stable per (indicator, period)', () => {
      expect(incrementalSMA(20).id).toBe('sma:20');
      expect(incrementalEMA(50).id).toBe('ema:50');
      expect(incrementalRSI(14).id).toBe('rsi:14');
      expect(incrementalATR(14).id).toBe('atr:14');
    });
  });

  describe('id uniqueness across periods', () => {
    it('SMA periods yield distinct ids', () => {
      expect(incrementalSMA(20).id).not.toBe(incrementalSMA(50).id);
    });
  });

  describe('purity (all indicators)', () => {
    it.each([
      ['ema', incrementalEMA(PERIOD)],
      ['rsi', incrementalRSI(PERIOD)],
      ['atr', incrementalATR(PERIOD)],
    ] as const)('%s update does not mutate input state', (_name, ind) => {
      const state = ind.initFromWindow(FIXTURE);
      const before = ind.serialize(state);
      ind.update(state, FIXTURE[FIXTURE.length - 1] as Candle);
      expect(ind.serialize(state)).toBe(before);
    });
  });

  describe('delta=0 edge case (RSI/ATR)', () => {
    it('RSI: a zero-delta update decays both gain and loss equally', () => {
      const ind = incrementalRSI(PERIOD);
      const state = ind.initFromWindow(FIXTURE);
      const close = state.prevClose.toString();
      const flat: Candle = {
        openTimeMs: 0,
        closeTimeMs: 0,
        open: close,
        high: close,
        low: close,
        close,
        volume: '0',
        isClosed: true,
      };
      const [next, value] = ind.update(state, flat);
      // Both averages decayed by (period-1)/period; the ratio is unchanged.
      const ratioBefore = state.avgGain.dividedBy(state.avgLoss).toString();
      const ratioAfter = next.avgGain.dividedBy(next.avgLoss).toString();
      expect(ratioAfter).toBe(ratioBefore);
      // Value is finite (not NaN).
      expect(Number.isFinite(Number(value.toString()))).toBe(true);
    });

    it('ATR: a zero-range update (high=low=prevClose) decays the ATR by (period-1)/period', () => {
      const ind = incrementalATR(PERIOD);
      const state = ind.initFromWindow(FIXTURE);
      const close = state.prevClose.toString();
      const flat: Candle = {
        openTimeMs: 0,
        closeTimeMs: 0,
        open: close,
        high: close,
        low: close,
        close,
        volume: '0',
        isClosed: true,
      };
      const [, value] = ind.update(state, flat);
      const expected = state.value
        .times(PERIOD - 1)
        .dividedBy(PERIOD)
        .toString();
      expect(value.toString()).toBe(expected);
    });
  });

  describe('period=1 (pathological but legal)', () => {
    it('SMA(1) is just the last close', () => {
      const ind = incrementalSMA(1);
      const state = ind.initFromWindow(FIXTURE.slice(0, 5));
      const [, value] = ind.update(state, FIXTURE[10] as Candle);
      expect(value.toString()).toBe(new Decimal((FIXTURE[10] as Candle).close).toString());
    });

    it('EMA(1) collapses to the latest close (k = 2/2 = 1)', () => {
      const ind = incrementalEMA(1);
      const state = ind.initFromWindow(FIXTURE.slice(0, 5));
      const [, value] = ind.update(state, FIXTURE[10] as Candle);
      expect(value.toString()).toBe(new Decimal((FIXTURE[10] as Candle).close).toString());
    });
  });

  describe('serialize / deserialize round-trip', () => {
    it.each([
      ['sma', incrementalSMA(PERIOD)],
      ['ema', incrementalEMA(PERIOD)],
      ['rsi', incrementalRSI(PERIOD)],
      ['atr', incrementalATR(PERIOD)],
    ] as const)('%s state survives a string round-trip', (_name, ind) => {
      const state = ind.initFromWindow(FIXTURE);
      const blob = ind.serialize(state);
      const rehydrated = ind.deserialize(blob);
      // Re-serialising the rehydrated state yields the same blob — proves
      // the decode is the exact inverse of the encode at Decimal precision.
      expect(ind.serialize(rehydrated)).toBe(blob);
      // One update step from rehydrated state matches an update step from
      // the original — proves the rehydrated state is operationally identical.
      const next = FIXTURE[FIXTURE.length - 1] as Candle;
      const [, valueA] = ind.update(state, next);
      const [, valueB] = ind.update(rehydrated, next);
      expect(valueB.toString()).toBe(valueA.toString());
    });

    it.each([
      ['sma', incrementalSMA(PERIOD)],
      ['ema', incrementalEMA(PERIOD)],
      ['rsi', incrementalRSI(PERIOD)],
      ['atr', incrementalATR(PERIOD)],
    ] as const)('%s deserialize rejects a malformed blob', (_name, ind) => {
      expect(() => ind.deserialize('{}')).toThrow();
      expect(() => ind.deserialize('not json')).toThrow();
    });

    it('SMA deserialize rejects a wrong-length ring', () => {
      const ind = incrementalSMA(PERIOD);
      const blob = JSON.stringify({ ring: ['1', '2', '3'], sum: '6' });
      expect(() => ind.deserialize(blob)).toThrow(/ring length/);
    });
  });
});
