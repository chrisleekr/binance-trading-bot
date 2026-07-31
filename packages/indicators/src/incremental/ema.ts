// Incremental Exponential Moving Average.
//
// Mirrors the full-window form in `@app/indicators`: seeded from the SMA of
// the first `period` closes, then folded forward as
// `value = (close - value) * k + value` with `k = 2 / (period + 1)`.
//
// State: just the current value. Update is O(1).

import Decimal from 'decimal.js';
import type { Candle } from '@app/strategy-core';
import type { CandleWindow } from '@app/indicators';
import type { IncrementalIndicator } from './types.js';

export interface EMAState {
  readonly value: Decimal;
}

interface SerializedEMA {
  readonly value: string;
}

export const incrementalEMA = (period: number): IncrementalIndicator<EMAState, Decimal> => {
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error(`incrementalEMA: period must be a positive integer (got ${period})`);
  }
  const k = new Decimal(2).dividedBy(period + 1);
  return {
    id: `ema:${period}`,
    initFromWindow: (window: CandleWindow): EMAState => {
      if (window.length < period) {
        throw new Error(
          `incrementalEMA(${period}): window length ${window.length} < period ${period}`,
        );
      }
      // Seed from SMA of the first `period` closes (full-window convention).
      let sum = new Decimal(0);
      for (let i = 0; i < period; i++) sum = sum.plus(new Decimal((window[i] as Candle).close));
      let value = sum.dividedBy(period);
      // Fold the remainder of the window into the EMA.
      for (let i = period; i < window.length; i++) {
        const close = new Decimal((window[i] as Candle).close);
        value = close.minus(value).times(k).plus(value);
      }
      return { value };
    },
    currentValue: (state: EMAState): Decimal => state.value,
    update: (state: EMAState, next: Candle): readonly [EMAState, Decimal] => {
      const close = new Decimal(next.close);
      const value = close.minus(state.value).times(k).plus(state.value);
      return [{ value }, value] as const;
    },
    serialize: (state: EMAState): string =>
      JSON.stringify({ value: state.value.toString() } satisfies SerializedEMA),
    deserialize: (raw: string): EMAState => {
      const parsed = JSON.parse(raw) as Partial<SerializedEMA>;
      if (typeof parsed.value !== 'string') {
        throw new Error(`incrementalEMA(${period}): malformed state blob`);
      }
      return { value: new Decimal(parsed.value) };
    },
  };
};
