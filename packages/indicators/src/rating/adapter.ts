// Adapter from our project's `CandleWindow` shape (an array of `Candle`s with
// stringified Decimal prices) to the vendored `trading-signals` indicator
// classes (which want number/HighLowClose inputs). Every wrapper returns the
// LAST indicator value or `null` when the window is shorter than the required
// lookback. Vendored Stochastic and MACD return plain numbers; we normalise
// every output to `Decimal` to keep the boundary single-shape and avoid silent
// IEEE-754 drift downstream.
//
// The Bull/Bear Power and the Ultimate Oscillator are not in the vendored set;
// they live in `bb-power.ts` / `ultimate-osc.ts` alongside this file.

import Decimal from 'decimal.js';
import type { Candle } from '@app/strategy-core';
import type { CandleWindow } from '@app/indicators';

import { AO } from './vendored/momentum/AO/AO.js';
import { CCI } from './vendored/momentum/CCI/CCI.js';
import { MACD } from './vendored/momentum/MACD/MACD.js';
import { MOM } from './vendored/momentum/MOM/MOM.js';
import { RSI } from './vendored/momentum/RSI/RSI.js';
import { StochasticOscillator } from './vendored/momentum/STOCH/StochasticOscillator.js';
import { StochasticRSI } from './vendored/momentum/STOCHRSI/StochasticRSI.js';
import { WilliamsR } from './vendored/momentum/WILLR/WilliamsR.js';
import { ADX } from './vendored/trend/ADX/ADX.js';
import { DX } from './vendored/trend/DX/DX.js';
import { EMA } from './vendored/trend/EMA/EMA.js';
import { SMA } from './vendored/trend/SMA/SMA.js';
import { WMA } from './vendored/trend/WMA/WMA.js';
import type { HighLowClose, HighLowCloseVolume } from './vendored/types/HighLowClose.js';
import { VWMA } from './vendored/volume/VWMA/VWMA.js';

// Per-call projection memoisation. `computeTechnicalsRating` passes the SAME
// window reference (w, and the prev/prev2 slices) to ~30 adapter calls, each of
// which used to rebuild the same number[]/HighLowClose[] from scratch, >15
// full-window arrays per rating. Keying a WeakMap by the window array reference
// builds each projection once and reuses it. The values are read-only (the
// vendored `updates` maps over them, never mutates), and the WeakMap releases an
// entry as soon as its window array is collected, so nothing accumulates. The
// numbers are unchanged, same `Number(c.x)` coercions, just not repeated.
const closesCache = new WeakMap<object, number[]>();
const hlcCache = new WeakMap<object, HighLowClose<number>[]>();
const hlcvCache = new WeakMap<object, HighLowCloseVolume<number>[]>();
const hlCache = new WeakMap<object, { high: number; low: number }[]>();

const memo = <T>(cache: WeakMap<object, T>, w: CandleWindow, build: () => T): T => {
  let v = cache.get(w);
  if (v === undefined) {
    v = build();
    cache.set(w, v);
  }
  return v;
};

const closes = (w: CandleWindow): number[] =>
  memo(closesCache, w, () => w.map((c) => Number(c.close)));

const hlc = (w: CandleWindow): HighLowClose<number>[] =>
  memo(hlcCache, w, () =>
    w.map((c) => ({ high: Number(c.high), low: Number(c.low), close: Number(c.close) })),
  );

const hlcv = (w: CandleWindow): HighLowCloseVolume<number>[] =>
  memo(hlcvCache, w, () =>
    w.map((c) => ({
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume),
    })),
  );

const highLow = (w: CandleWindow): { high: number; low: number }[] =>
  memo(hlCache, w, () => w.map((c) => ({ high: Number(c.high), low: Number(c.low) })));

const toDecimal = (n: number | Decimal | null | undefined): Decimal | null => {
  /* v8 ignore start -- reason: both arms are defensive for the union type and unreachable in practice — every adapter wrapper guards its window length before calling (so getResult() is non-null), and vendored results are always plain numbers, never Decimal */
  if (n == null) return null;
  if (n instanceof Decimal) return n;
  /* v8 ignore stop */
  return new Decimal(n);
};

/** Closing price of the last candle (the panel uses this for MA-vs-price votes). */
export const lastClose = (w: CandleWindow): Decimal | null => {
  const last: Candle | undefined = w[w.length - 1];
  return last === undefined ? null : new Decimal(last.close);
};

// -- Oscillators --

/** Returns {k, d}. Both Decimal or both null. */
export const stoch = (
  w: CandleWindow,
  period = 14,
  signalInterval = 3,
): { k: Decimal; d: Decimal } | null => {
  if (w.length < period + signalInterval) return null;
  const i = new StochasticOscillator(period, signalInterval, signalInterval);
  i.updates(hlc(w), false);
  const r = i.getResult();
  return r == null ? null : { k: new Decimal(r.stochK), d: new Decimal(r.stochD) };
};

export const adx = (w: CandleWindow, period = 14): Decimal | null => {
  if (w.length < period * 2) return null;
  const i = new ADX(period);
  i.updates(hlc(w), false);
  return toDecimal(i.getResult());
};

/** Returns {pdi, mdi} — TradingView calls these +DI and -DI. */
export const directionalIndicators = (
  w: CandleWindow,
  period = 14,
): { plus: Decimal; minus: Decimal } | null => {
  if (w.length < period + 1) return null;
  const i = new DX(period);
  i.updates(hlc(w), false);
  /* v8 ignore start -- reason: DX sets pdi/mdi once its smoothing is stable, which always holds for w.length >= period+1 (the guard above), so this null check never returns */
  if (i.pdi == null || i.mdi == null) return null;
  /* v8 ignore stop -- reason: end of the unreachable DX null-DI guard above */
  return { plus: new Decimal(i.pdi), minus: new Decimal(i.mdi) };
};

/** Returns {macd, signal}. */
export const macd = (
  w: CandleWindow,
  shortInterval = 12,
  longInterval = 26,
  signalInterval = 9,
): { macd: Decimal; signal: Decimal } | null => {
  if (w.length < longInterval + signalInterval) return null;
  const i = new MACD(new EMA(shortInterval), new EMA(longInterval), new EMA(signalInterval));
  i.updates(closes(w), false);
  const r = i.getResult();
  /* v8 ignore start -- reason: MACD emits a result once it has longInterval+signalInterval closes, which the length guard above guarantees, so r is never null here */
  return r == null ? null : { macd: new Decimal(r.macd), signal: new Decimal(r.signal) };
  /* v8 ignore stop -- reason: end of the unreachable null-MACD-result arm above */
};

/**
 * Returns the smoothed %K and %D lines of the Stochastic-RSI (both or null).
 * The vendored class keeps the lines in [0, 1]; TradingView's vote thresholds
 * (20 / 80) are on a 0-100 scale, so scale at this boundary. `getResult()`
 * yields null until the %K and %D SMAs are stable, which guards the short window
 * beyond the cheap length pre-check.
 */
export const stochRsi = (w: CandleWindow, period = 14): { k: Decimal; d: Decimal } | null => {
  if (w.length < period * 2 + 3) return null;
  const i = new StochasticRSI(period);
  i.updates(closes(w), false);
  // %D is an SMA of %K, so it stabilises last; a null %D means the window is
  // still one or two bars short of a full StochRSI reading.
  const d = i.smoothing.d.getResult();
  if (d == null) return null;
  // %K stabilises before %D (it is the input to %D's SMA), so a non-null %D
  // guarantees a non-null %K — read it directly rather than re-guarding.
  const k = i.smoothing.k.getResultOrThrow();
  return { k: new Decimal(k).times(100), d: new Decimal(d).times(100) };
};

// -- Moving averages --

export const sma = (w: CandleWindow, period: number): Decimal | null => {
  if (w.length < period) return null;
  const i = new SMA(period);
  i.updates(closes(w), false);
  return toDecimal(i.getResult());
};

export const ema = (w: CandleWindow, period: number): Decimal | null => {
  if (w.length < period) return null;
  const i = new EMA(period);
  i.updates(closes(w), false);
  return toDecimal(i.getResult());
};

export const wma = (w: CandleWindow, period: number): Decimal | null => {
  if (w.length < period) return null;
  const i = new WMA(period);
  i.updates(closes(w), false);
  return toDecimal(i.getResult());
};

export const vwma = (w: CandleWindow, period = 20): Decimal | null => {
  if (w.length < period) return null;
  const i = new VWMA(period);
  i.updates(hlcv(w), false);
  return toDecimal(i.getResult());
};

// -- Current + previous values in a single pass --
//
// The rating needs several indicators at BOTH the last bar (current) and the
// bar before it (previous, for slope/cross votes). Computing `X(w)` and
// `X(w.slice(0, -1))` runs the indicator twice over near-identical windows. But
// `updates(closes(w))` already returns the indicator's value after EVERY bar, so
// the second-to-last entry IS the indicator over the window minus its last bar —
// byte-identical to a separate pass, because each value depends only on the bars
// up to its own index. Reading the last two off that one array halves the work.

interface Curr2 {
  curr: Decimal | null;
  prev: Decimal | null;
}

// Read the current (last bar) and previous (second-to-last bar) values off the
// `updates` series, applying the SAME minimum-window guard the single-value
// wrappers use: `prev` is null when the window minus its last bar is shorter than
// the lookback `minWindow`, exactly as `X(w.slice(0, -1))` returns. This matters
// because some vendored indicators (e.g. EMA) emit a value BEFORE their nominal
// lookback, so a raw `results[n-2]` would leak a value where the single-value
// wrapper's length guard returns null. With this guard `prev` is byte-identical to
// a separate `X(prev)` pass for every window size.
const currPrev = (
  results: readonly (number | null)[],
  windowLen: number,
  minWindow: number,
): Curr2 => ({
  // toDecimal already maps null/undefined → null (its defensive arms are
  // v8-ignored), so no extra `?? null` branch is needed for the indexed reads.
  curr: toDecimal(results[results.length - 1]),
  prev: windowLen - 1 < minWindow ? null : toDecimal(results[results.length - 2]),
});

/** RSI at the last bar and the bar before it. */
export const rsiCurrPrev = (w: CandleWindow, period = 14): Curr2 => {
  if (w.length < period + 1) return { curr: null, prev: null };
  return currPrev(new RSI(period).updates(closes(w), false), w.length, period + 1);
};

/** CCI at the last bar and the bar before it. */
export const cciCurrPrev = (w: CandleWindow, period = 20): Curr2 => {
  if (w.length < period) return { curr: null, prev: null };
  return currPrev(new CCI(period).updates(hlc(w), false), w.length, period);
};

/** ADX at the last bar and the bar before it. */
export const adxCurrPrev = (w: CandleWindow, period = 14): Curr2 => {
  if (w.length < period * 2) return { curr: null, prev: null };
  return currPrev(new ADX(period).updates(hlc(w), false), w.length, period * 2);
};

/** Awesome Oscillator at the last bar and the two before it (slope vote needs prev2). */
export const aoCurrPrevPrev2 = (
  w: CandleWindow,
): { curr: Decimal | null; prev: Decimal | null; prev2: Decimal | null } => {
  const minWindow = 34;
  if (w.length < minWindow) return { curr: null, prev: null, prev2: null };
  const r = new AO(5, minWindow).updates(highLow(w), false);
  return {
    curr: toDecimal(r[r.length - 1]),
    prev: w.length - 1 < minWindow ? null : toDecimal(r[r.length - 2]),
    prev2: w.length - 2 < minWindow ? null : toDecimal(r[r.length - 3]),
  };
};

/** Momentum at the last bar and the bar before it. */
export const momentumCurrPrev = (w: CandleWindow, period = 10): Curr2 => {
  if (w.length < period + 1) return { curr: null, prev: null };
  return currPrev(new MOM(period).updates(closes(w), false), w.length, period + 1);
};

/** Williams %R at the last bar and the bar before it. */
export const williamsCurrPrev = (w: CandleWindow, period = 14): Curr2 => {
  if (w.length < period) return { curr: null, prev: null };
  return currPrev(new WilliamsR(period).updates(hlc(w), false), w.length, period);
};

/** EMA at the last bar and the bar before it. */
export const emaCurrPrev = (w: CandleWindow, period: number): Curr2 => {
  if (w.length < period) return { curr: null, prev: null };
  return currPrev(new EMA(period).updates(closes(w), false), w.length, period);
};
