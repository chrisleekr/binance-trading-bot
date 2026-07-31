// Incremental Wilder's-smoothing Average True Range.
//
// Mirrors the full-window form in `@app/indicators`: seeded from the
// arithmetic mean of the first `period` true-range values, then smoothed
// forward as `next = (prev * (period - 1) + tr) / period`.
//
// State: smoothed ATR value + previous close (TR needs the prior close).
// Update is O(1).
//
// Needs `period + 1` candles to seed (TR requires a prior close).

import Decimal from 'decimal.js';
import type { Candle } from '@app/strategy-core';
import type { CandleWindow } from '@app/indicators';
import type { IncrementalIndicator } from './types.js';

export interface ATRState {
  readonly value: Decimal;
  readonly prevClose: Decimal;
}

interface SerializedATR {
  readonly value: string;
  readonly prevClose: string;
}

const dmax = (a: Decimal, b: Decimal): Decimal => (a.greaterThan(b) ? a : b);
const dabs = (a: Decimal): Decimal => (a.lessThan(0) ? a.negated() : a);

const trueRange = (high: Decimal, low: Decimal, prevClose: Decimal): Decimal =>
  dmax(high.minus(low), dmax(dabs(high.minus(prevClose)), dabs(low.minus(prevClose))));

export const incrementalATR = (period: number): IncrementalIndicator<ATRState, Decimal> => {
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error(`incrementalATR: period must be a positive integer (got ${period})`);
  }
  return {
    id: `atr:${period}`,
    initFromWindow: (window: CandleWindow): ATRState => {
      if (window.length < period + 1) {
        throw new Error(
          `incrementalATR(${period}): window length ${window.length} < period+1 ${period + 1}`,
        );
      }
      // Wilder's seed: arithmetic mean of the first `period` TR values.
      let acc = new Decimal(0);
      for (let i = 1; i <= period; i++) {
        const cur = window[i] as Candle;
        const prev = window[i - 1] as Candle;
        acc = acc.plus(
          trueRange(new Decimal(cur.high), new Decimal(cur.low), new Decimal(prev.close)),
        );
      }
      let value = acc.dividedBy(period);
      // Smooth forward through the rest of the window.
      for (let i = period + 1; i < window.length; i++) {
        const cur = window[i] as Candle;
        const prev = window[i - 1] as Candle;
        const tr = trueRange(new Decimal(cur.high), new Decimal(cur.low), new Decimal(prev.close));
        value = value
          .times(period - 1)
          .plus(tr)
          .dividedBy(period);
      }
      const prevClose = new Decimal((window[window.length - 1] as Candle).close);
      return { value, prevClose };
    },
    currentValue: (state: ATRState): Decimal => state.value,
    update: (state: ATRState, next: Candle): readonly [ATRState, Decimal] => {
      const high = new Decimal(next.high);
      const low = new Decimal(next.low);
      const close = new Decimal(next.close);
      const tr = trueRange(high, low, state.prevClose);
      const value = state.value
        .times(period - 1)
        .plus(tr)
        .dividedBy(period);
      return [{ value, prevClose: close }, value] as const;
    },
    serialize: (state: ATRState): string =>
      JSON.stringify({
        value: state.value.toString(),
        prevClose: state.prevClose.toString(),
      } satisfies SerializedATR),
    deserialize: (raw: string): ATRState => {
      const parsed = JSON.parse(raw) as Partial<SerializedATR>;
      if (typeof parsed.value !== 'string' || typeof parsed.prevClose !== 'string') {
        throw new Error(`incrementalATR(${period}): malformed state blob`);
      }
      return {
        value: new Decimal(parsed.value),
        prevClose: new Decimal(parsed.prevClose),
      };
    },
  };
};
