// Incremental Wilder's-smoothing Relative Strength Index.
//
// Mirrors the full-window form in `@app/indicators`: seeded from the
// arithmetic mean of the first `period` gain/loss values (Wilder's initial
// average), then smoothed forward as
// `next = (prev * (period - 1) + current) / period`.
//
// State: smoothed avg gain, smoothed avg loss, previous close (to compute
// the next delta). Update is O(1).
//
// Needs `period + 1` candles to seed (the first `period` deltas come from
// the first `period + 1` closes).

import Decimal from 'decimal.js';
import type { Candle } from '@app/strategy-core';
import type { CandleWindow } from '@app/indicators';
import type { IncrementalIndicator } from './types.js';

export interface RSIState {
  readonly avgGain: Decimal;
  readonly avgLoss: Decimal;
  /** Close of the most recently folded candle; the next update's delta source. */
  readonly prevClose: Decimal;
}

interface SerializedRSI {
  readonly avgGain: string;
  readonly avgLoss: string;
  readonly prevClose: string;
}

const ZERO = new Decimal(0);
const ONE_HUNDRED = new Decimal(100);

const rsiValue = (avgGain: Decimal, avgLoss: Decimal): Decimal => {
  // avgLoss=0 means no down-moves in the window — Wilder's RSI saturates at 100.
  if (avgLoss.isZero()) return ONE_HUNDRED;
  const rs = avgGain.dividedBy(avgLoss);
  return ONE_HUNDRED.minus(ONE_HUNDRED.dividedBy(rs.plus(1)));
};

export const incrementalRSI = (period: number): IncrementalIndicator<RSIState, Decimal> => {
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error(`incrementalRSI: period must be a positive integer (got ${period})`);
  }
  return {
    id: `rsi:${period}`,
    initFromWindow: (window: CandleWindow): RSIState => {
      if (window.length < period + 1) {
        throw new Error(
          `incrementalRSI(${period}): window length ${window.length} < period+1 ${period + 1}`,
        );
      }
      let gains = ZERO;
      let losses = ZERO;
      // Wilder's seed: arithmetic mean of the first `period` gain/loss values.
      for (let i = 1; i <= period; i++) {
        const delta = new Decimal((window[i] as Candle).close).minus(
          (window[i - 1] as Candle).close,
        );
        if (delta.greaterThan(0)) gains = gains.plus(delta);
        else losses = losses.plus(delta.negated());
      }
      let avgGain = gains.dividedBy(period);
      let avgLoss = losses.dividedBy(period);
      // Smooth forward through the rest of the window.
      for (let i = period + 1; i < window.length; i++) {
        const delta = new Decimal((window[i] as Candle).close).minus(
          (window[i - 1] as Candle).close,
        );
        const gain = delta.greaterThan(0) ? delta : ZERO;
        const loss = delta.lessThan(0) ? delta.negated() : ZERO;
        avgGain = avgGain
          .times(period - 1)
          .plus(gain)
          .dividedBy(period);
        avgLoss = avgLoss
          .times(period - 1)
          .plus(loss)
          .dividedBy(period);
      }
      const prevClose = new Decimal((window[window.length - 1] as Candle).close);
      return { avgGain, avgLoss, prevClose };
    },
    currentValue: (state: RSIState): Decimal => rsiValue(state.avgGain, state.avgLoss),
    update: (state: RSIState, next: Candle): readonly [RSIState, Decimal] => {
      const close = new Decimal(next.close);
      const delta = close.minus(state.prevClose);
      const gain = delta.greaterThan(0) ? delta : ZERO;
      const loss = delta.lessThan(0) ? delta.negated() : ZERO;
      const avgGain = state.avgGain
        .times(period - 1)
        .plus(gain)
        .dividedBy(period);
      const avgLoss = state.avgLoss
        .times(period - 1)
        .plus(loss)
        .dividedBy(period);
      const value = rsiValue(avgGain, avgLoss);
      return [{ avgGain, avgLoss, prevClose: close }, value] as const;
    },
    serialize: (state: RSIState): string =>
      JSON.stringify({
        avgGain: state.avgGain.toString(),
        avgLoss: state.avgLoss.toString(),
        prevClose: state.prevClose.toString(),
      } satisfies SerializedRSI),
    deserialize: (raw: string): RSIState => {
      const parsed = JSON.parse(raw) as Partial<SerializedRSI>;
      if (
        typeof parsed.avgGain !== 'string' ||
        typeof parsed.avgLoss !== 'string' ||
        typeof parsed.prevClose !== 'string'
      ) {
        throw new Error(`incrementalRSI(${period}): malformed state blob`);
      }
      return {
        avgGain: new Decimal(parsed.avgGain),
        avgLoss: new Decimal(parsed.avgLoss),
        prevClose: new Decimal(parsed.prevClose),
      };
    },
  };
};
