// Incremental Stochastic Oscillator (fast %K, smoothed to slow %K).
//
// State: three rings —
//   - `highRing`: last `period` highs (for the %K formula's lookback max)
//   - `lowRing`:  last `period` lows  (for the lookback min)
//   - `kRing`:    last `smoothK` raw %K values (for the smoothed %K SMA)
//
// Update is O(period) — the lookback min/max scan the ring; for the
// typical `period = 14` this is still negligible per closed candle and
// keeps the code straightforward. (A monotonic deque would buy O(1)
// amortised at the cost of a much larger state to serialise — not worth
// the complexity at v1.0 scale.)
//
// Raw %K = (close - lowestLow) / (highestHigh - lowestLow) * 100
// When the range is zero (period of perfectly flat candles), %K is
// conventionally defined as 50 — convention used by TradingView's
// Pine implementation. Otherwise the divide-by-zero would surface as
// NaN downstream.

import Decimal from 'decimal.js';
import type { Candle } from '@app/strategy-core';
import type { CandleWindow } from '@app/indicators';
import type { IncrementalIndicator } from './types.js';

export interface StochasticState {
  readonly highRing: readonly Decimal[];
  readonly lowRing: readonly Decimal[];
  readonly kRing: readonly Decimal[];
}

export interface StochasticValue {
  readonly k: Decimal;
  toFixed(): string;
}

interface SerializedStochastic {
  readonly highRing: readonly string[];
  readonly lowRing: readonly string[];
  readonly kRing: readonly string[];
}

const FIFTY = new Decimal(50);
const HUNDRED = new Decimal(100);

const minOf = (xs: readonly Decimal[]): Decimal => {
  let m = xs[0] as Decimal;
  for (let i = 1; i < xs.length; i++) {
    const v = xs[i] as Decimal;
    if (v.lessThan(m)) m = v;
  }
  return m;
};
const maxOf = (xs: readonly Decimal[]): Decimal => {
  let m = xs[0] as Decimal;
  for (let i = 1; i < xs.length; i++) {
    const v = xs[i] as Decimal;
    if (v.greaterThan(m)) m = v;
  }
  return m;
};

const rawK = (
  close: Decimal,
  highRing: readonly Decimal[],
  lowRing: readonly Decimal[],
): Decimal => {
  const hi = maxOf(highRing);
  const lo = minOf(lowRing);
  const range = hi.minus(lo);
  if (range.isZero()) return FIFTY;
  return close.minus(lo).dividedBy(range).times(HUNDRED);
};

const smoothedK = (kRing: readonly Decimal[]): Decimal => {
  let sum = new Decimal(0);
  for (const k of kRing) sum = sum.plus(k);
  return sum.dividedBy(kRing.length);
};

const wrap = (k: Decimal): StochasticValue => ({ k, toFixed: () => k.toFixed() });

export const incrementalStochastic = (
  period: number,
  smoothK = 3,
): IncrementalIndicator<StochasticState, StochasticValue> => {
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error(`incrementalStochastic: period must be a positive integer (got ${period})`);
  }
  if (!Number.isInteger(smoothK) || smoothK <= 0) {
    throw new Error(`incrementalStochastic: smoothK must be a positive integer (got ${smoothK})`);
  }
  const minWindow = period + smoothK - 1;

  return {
    id: `stoch:${period}:${smoothK}`,
    initFromWindow: (window: CandleWindow): StochasticState => {
      if (window.length < minWindow) {
        throw new Error(
          `incrementalStochastic(${period},${smoothK}): window length ${window.length} < period+smoothK-1 ${minWindow}`,
        );
      }
      // Seed by walking the last `minWindow` candles: maintain highRing /
      // lowRing of size `period` and accumulate the last `smoothK` raw %K
      // values into kRing.
      const start = window.length - minWindow;
      const highRing: Decimal[] = [];
      const lowRing: Decimal[] = [];
      const kRing: Decimal[] = [];
      for (let i = start; i < window.length; i++) {
        const c = window[i] as Candle;
        const high = new Decimal(c.high);
        const low = new Decimal(c.low);
        const close = new Decimal(c.close);
        highRing.push(high);
        lowRing.push(low);
        if (highRing.length > period) highRing.shift();
        if (lowRing.length > period) lowRing.shift();
        if (highRing.length === period) {
          kRing.push(rawK(close, highRing, lowRing));
          /* v8 ignore start -- reason: the seed walks exactly minWindow = period+smoothK-1 candles, so kRing receives exactly smoothK pushes and never exceeds it; this trim is a guard that never fires during seeding */
          if (kRing.length > smoothK) kRing.shift();
          /* v8 ignore stop -- reason: end of the unreachable seed kRing-trim guard above */
        }
      }
      return { highRing, lowRing, kRing };
    },
    update: (state: StochasticState, next: Candle): readonly [StochasticState, StochasticValue] => {
      const high = new Decimal(next.high);
      const low = new Decimal(next.low);
      const close = new Decimal(next.close);
      const highRing = [...state.highRing.slice(1), high];
      const lowRing = [...state.lowRing.slice(1), low];
      const k = rawK(close, highRing, lowRing);
      const kRing = [...state.kRing.slice(1), k];
      const nextState: StochasticState = { highRing, lowRing, kRing };
      return [nextState, wrap(smoothedK(kRing))] as const;
    },
    currentValue: (state) => wrap(smoothedK(state.kRing)),
    serialize: (state) =>
      JSON.stringify({
        highRing: state.highRing.map((d) => d.toString()),
        lowRing: state.lowRing.map((d) => d.toString()),
        kRing: state.kRing.map((d) => d.toString()),
      } satisfies SerializedStochastic),
    deserialize: (raw: string): StochasticState => {
      const parsed = JSON.parse(raw) as Partial<SerializedStochastic>;
      if (
        !Array.isArray(parsed.highRing) ||
        !Array.isArray(parsed.lowRing) ||
        !Array.isArray(parsed.kRing)
      ) {
        throw new Error(`incrementalStochastic(${period},${smoothK}): malformed state blob`);
      }
      if (parsed.highRing.length !== period || parsed.lowRing.length !== period) {
        throw new Error(
          `incrementalStochastic(${period}): ring length mismatch (${parsed.highRing.length}/${parsed.lowRing.length} != ${period})`,
        );
      }
      if (parsed.kRing.length !== smoothK) {
        throw new Error(
          `incrementalStochastic(${period},${smoothK}): kRing length ${parsed.kRing.length} != smoothK ${smoothK}`,
        );
      }
      return {
        highRing: parsed.highRing.map((s) => new Decimal(s)),
        lowRing: parsed.lowRing.map((s) => new Decimal(s)),
        kRing: parsed.kRing.map((s) => new Decimal(s)),
      };
    },
  };
};
