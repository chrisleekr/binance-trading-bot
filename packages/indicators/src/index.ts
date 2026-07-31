import Decimal from 'decimal.js';
import type { Candle } from '@app/strategy-core';

/**
 * Ordered, immutable slice of candles. Indicators consume a window so the
 * caller controls slicing and freshness instead of each indicator re-fetching;
 * `readonly` makes accidental mutation a type error.
 */
export type CandleWindow = readonly Candle[];

const requireNonEmpty = (w: CandleWindow, fn: string): void => {
  if (w.length === 0) {
    throw new Error(`@app/indicators/${fn}: empty candle window`);
  }
};

const requirePeriod = (w: CandleWindow, period: number, fn: string): void => {
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error(`@app/indicators/${fn}: period must be a positive integer (got ${period})`);
  }
  if (w.length < period) {
    throw new Error(`@app/indicators/${fn}: window length ${w.length} < period ${period}`);
  }
};

const at = (w: CandleWindow, i: number, fn: string): Candle => {
  const c = w[i];
  /* v8 ignore start -- reason: rsi/atr only call at() with indices proven in range by their requirePeriod guard, so this out-of-bounds throw is a noUncheckedIndexedAccess guard that never fires */
  if (!c) throw new Error(`@app/indicators/${fn}: index ${i} out of bounds (len ${w.length})`);
  /* v8 ignore stop -- reason: end of the unreachable out-of-bounds guard above */
  return c;
};

const dmax = (a: Decimal, b: Decimal): Decimal => (a.greaterThan(b) ? a : b);
const dmin = (a: Decimal, b: Decimal): Decimal => (a.lessThan(b) ? a : b);
const dabs = (a: Decimal): Decimal => (a.lessThan(0) ? a.negated() : a);

/**
 * Lowest `low` across the window. Strategy support/resistance heuristics need
 * exact min. IEEE-754 `Math.min` would lose decimals at small price ticks.
 */
export const lowestLow = (w: CandleWindow): Decimal => {
  requireNonEmpty(w, 'lowestLow');
  let lo: Decimal | null = null;
  for (const c of w) {
    const v = new Decimal(c.low);
    lo = lo === null ? v : dmin(lo, v);
  }
  return lo as Decimal;
};

/**
 * Highest `high` across the window. Decimal-typed for the same precision
 * reason as `lowestLow`.
 */
export const highestHigh = (w: CandleWindow): Decimal => {
  requireNonEmpty(w, 'highestHigh');
  let hi: Decimal | null = null;
  for (const c of w) {
    const v = new Decimal(c.high);
    hi = hi === null ? v : dmax(hi, v);
  }
  return hi as Decimal;
};

/**
 * All-time-high observed within the supplied window, definitionally equal to
 * `highestHigh`. Kept as a distinct name to preserve the trailing-trade
 * vocabulary so the strategy code reads consistently.
 */
export const ath = (w: CandleWindow): Decimal => highestHigh(w);

/**
 * Simple moving average over the trailing `period` closes. Throws when the
 * window is shorter than `period` rather than returning a partial average so
 * a strategy never trades on a misleading "warming up" value.
 */
export const sma = (w: CandleWindow, period: number): Decimal => {
  requirePeriod(w, period, 'sma');
  let acc = new Decimal(0);
  for (const c of w.slice(w.length - period)) {
    acc = acc.plus(new Decimal(c.close));
  }
  return acc.dividedBy(period);
};

/**
 * Population standard deviation of the trailing `period` closes. Pairs with
 * {@link sma} to form a price z-score `(price - sma) / stddev` for
 * mean-reversion entries. Population (divide by N, not N-1): the window IS the
 * sample of interest, and N-vs-N-1 never changes the sign of a z-score
 * threshold comparison. Returns 0 for a perfectly flat window (the caller
 * treats a 0 stddev as "z-score undefined").
 */
export const stddev = (w: CandleWindow, period: number): Decimal => {
  requirePeriod(w, period, 'stddev');
  const slice = w.slice(w.length - period);
  const mean = sma(w, period);
  let sumSq = new Decimal(0);
  for (const c of slice) {
    const d = new Decimal(c.close).minus(mean);
    sumSq = sumSq.plus(d.times(d));
  }
  return sumSq.dividedBy(period).sqrt();
};

/**
 * Exponential moving average. Seeded from the SMA of the first `period`
 * closes. This matches the trailing-trade convention so replays over
 * committed fixtures stay byte-equal.
 */
export const ema = (w: CandleWindow, period: number): Decimal => {
  requirePeriod(w, period, 'ema');
  const k = new Decimal(2).dividedBy(period + 1);
  let value = sma(w.slice(0, period), period);
  for (const c of w.slice(period)) {
    value = new Decimal(c.close).minus(value).times(k).plus(value);
  }
  return value;
};

/**
 * Wilder's-smoothing Relative Strength Index. Wilder (not Cutler) is the
 * strategy's choice; recomputing fixtures with a different smoothing would
 * silently change historical decisions. Needs `period + 1` candles to derive
 * the first `period` deltas.
 */
export const rsi = (w: CandleWindow, period: number): Decimal => {
  requirePeriod(w, period + 1, 'rsi');
  let gains = new Decimal(0);
  let losses = new Decimal(0);
  for (let i = 1; i <= period; i++) {
    const delta = new Decimal(at(w, i, 'rsi').close).minus(at(w, i - 1, 'rsi').close);
    if (delta.greaterThan(0)) gains = gains.plus(delta);
    else losses = losses.plus(delta.negated());
  }
  let avgGain = gains.dividedBy(period);
  let avgLoss = losses.dividedBy(period);
  for (let i = period + 1; i < w.length; i++) {
    const delta = new Decimal(at(w, i, 'rsi').close).minus(at(w, i - 1, 'rsi').close);
    const gain = delta.greaterThan(0) ? delta : new Decimal(0);
    const loss = delta.lessThan(0) ? delta.negated() : new Decimal(0);
    avgGain = avgGain
      .times(period - 1)
      .plus(gain)
      .dividedBy(period);
    avgLoss = avgLoss
      .times(period - 1)
      .plus(loss)
      .dividedBy(period);
  }
  if (avgLoss.isZero()) return new Decimal(100);
  const rs = avgGain.dividedBy(avgLoss);
  return new Decimal(100).minus(new Decimal(100).dividedBy(rs.plus(1)));
};

/**
 * Wilder's-smoothing Average True Range. Same Wilder reproducibility
 * constraint as `rsi`. Needs `period + 1` candles to compute the first
 * `period` true-range values from consecutive closes.
 */
export const atr = (w: CandleWindow, period: number): Decimal => {
  requirePeriod(w, period + 1, 'atr');
  const trueRange = (i: number): Decimal => {
    const cur = at(w, i, 'atr');
    const prev = at(w, i - 1, 'atr');
    const high = new Decimal(cur.high);
    const low = new Decimal(cur.low);
    const prevClose = new Decimal(prev.close);
    return dmax(high.minus(low), dmax(dabs(high.minus(prevClose)), dabs(low.minus(prevClose))));
  };
  let acc = new Decimal(0);
  for (let i = 1; i <= period; i++) acc = acc.plus(trueRange(i));
  let value = acc.dividedBy(period);
  for (let i = period + 1; i < w.length; i++) {
    value = value
      .times(period - 1)
      .plus(trueRange(i))
      .dividedBy(period);
  }
  return value;
};

/**
 * Buy/sell trigger price = `lowest * triggerPct`. `triggerPct` is an absolute
 * multiplier (e.g. `1.05` for +5%) matching the trailing-trade config so
 * operator-tuned values need no conversion.
 */
export const triggerPrice = (lowest: Decimal, triggerPct: Decimal): Decimal =>
  lowest.times(triggerPct);

/**
 * Limit price for an order = `price * limitPct`. Absolute-multiplier
 * convention identical to `triggerPrice`.
 */
export const limitPrice = (price: Decimal, limitPct: Decimal): Decimal => price.times(limitPct);

/**
 * Realised P&L for `qty` units bought at `lastBuy` and marked at `current`.
 * Decimal-typed because IEEE-754 drift on small price ticks compounds across
 * the thousands of evaluations a strategy does per session.
 */
export const profit = (lastBuy: Decimal, current: Decimal, qty: Decimal): Decimal =>
  current.minus(lastBuy).times(qty);

/**
 * Pearson correlation coefficient of two equal-length return series, in
 * `[-1, 1]`. Returns `null` when either series is constant (zero variance —
 * correlation is undefined) or shorter than 2 points, so the caller can treat
 * "undefined" distinctly from "uncorrelated (0)". Population formula
 * (divide-by-N cancels in the ratio, so N vs N-1 does not change the result).
 * Decimal throughout: a correlation cap compares against a tight threshold, so
 * IEEE-754 drift near the boundary must not flip the decision.
 */
export const pearsonCorrelation = (
  a: readonly Decimal[],
  b: readonly Decimal[],
): Decimal | null => {
  if (a.length !== b.length) {
    throw new Error(
      `@app/indicators/pearsonCorrelation: length mismatch (${a.length} vs ${b.length})`,
    );
  }
  const n = a.length;
  if (n < 2) return null;
  const nd = new Decimal(n);
  let sumA = new Decimal(0);
  let sumB = new Decimal(0);
  for (let i = 0; i < n; i++) {
    sumA = sumA.plus(a[i] as Decimal);
    sumB = sumB.plus(b[i] as Decimal);
  }
  const meanA = sumA.dividedBy(nd);
  const meanB = sumB.dividedBy(nd);
  let cov = new Decimal(0);
  let varA = new Decimal(0);
  let varB = new Decimal(0);
  for (let i = 0; i < n; i++) {
    const dA = (a[i] as Decimal).minus(meanA);
    const dB = (b[i] as Decimal).minus(meanB);
    cov = cov.plus(dA.times(dB));
    varA = varA.plus(dA.times(dA));
    varB = varB.plus(dB.times(dB));
  }
  if (varA.isZero() || varB.isZero()) return null;
  return cov.dividedBy(varA.times(varB).sqrt());
};
