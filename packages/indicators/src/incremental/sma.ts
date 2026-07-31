// Incremental Simple Moving Average.
//
// State: ring of the last `period` closes + their running sum. Update is
// O(1): subtract the oldest close, add the newest, evict-and-insert in the
// ring.

import Decimal from 'decimal.js';
import type { Candle } from '@app/strategy-core';
import type { CandleWindow } from '@app/indicators';
import type { IncrementalIndicator } from './types.js';

export interface SMAState {
  /** Ring of the last `period` closes, oldest at index 0. */
  readonly ring: readonly Decimal[];
  /** Running sum of `ring`; the SMA value is `sum / period`. */
  readonly sum: Decimal;
}

interface SerializedSMA {
  readonly ring: readonly string[];
  readonly sum: string;
}

export const incrementalSMA = (period: number): IncrementalIndicator<SMAState, Decimal> => {
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error(`incrementalSMA: period must be a positive integer (got ${period})`);
  }
  return {
    id: `sma:${period}`,
    initFromWindow: (window: CandleWindow): SMAState => {
      if (window.length < period) {
        throw new Error(
          `incrementalSMA(${period}): window length ${window.length} < period ${period}`,
        );
      }
      const ring: Decimal[] = [];
      let sum = new Decimal(0);
      for (let i = window.length - period; i < window.length; i++) {
        const close = new Decimal((window[i] as Candle).close);
        ring.push(close);
        sum = sum.plus(close);
      }
      return { ring, sum };
    },
    currentValue: (state: SMAState): Decimal => state.sum.dividedBy(period),
    update: (state: SMAState, next: Candle): readonly [SMAState, Decimal] => {
      const close = new Decimal(next.close);
      const oldest = state.ring[0] as Decimal;
      const nextSum = state.sum.minus(oldest).plus(close);
      // Slice off the oldest, append the newest. New array — state is
      // immutable so callers can persist state.ring without aliasing.
      const nextRing = [...state.ring.slice(1), close];
      const value = nextSum.dividedBy(period);
      return [{ ring: nextRing, sum: nextSum }, value] as const;
    },
    serialize: (state: SMAState): string =>
      JSON.stringify({
        ring: state.ring.map((d) => d.toString()),
        sum: state.sum.toString(),
      } satisfies SerializedSMA),
    deserialize: (raw: string): SMAState => {
      const parsed = JSON.parse(raw) as Partial<SerializedSMA>;
      if (!Array.isArray(parsed.ring) || typeof parsed.sum !== 'string') {
        throw new Error(`incrementalSMA(${period}): malformed state blob`);
      }
      if (parsed.ring.length !== period) {
        throw new Error(
          `incrementalSMA(${period}): ring length ${parsed.ring.length} != period ${period}`,
        );
      }
      return {
        ring: parsed.ring.map((s) => new Decimal(s)),
        sum: new Decimal(parsed.sum),
      };
    },
  };
};
