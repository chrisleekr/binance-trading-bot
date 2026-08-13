// Incremental Bollinger Bands.
//
// State: ring of `period` closes + running sum + running sum-of-squares.
// Update is O(1): subtract the oldest close from both running sums, add
// the newest, replace in the ring.
//
// Bands:
//   middle = sum / period
//   variance = sumSq / period - middle^2
//   stddev = sqrt(variance)
//   upper = middle + mult * stddev
//   lower = middle - mult * stddev

import Decimal from 'decimal.js';
import type { Candle } from '@app/strategy-core';
import type { CandleWindow } from '@app/indicators';
import type { IncrementalIndicator } from './types.js';

export interface BollingerState {
  readonly ring: readonly Decimal[];
  readonly sum: Decimal;
  readonly sumSq: Decimal;
}

export interface BollingerValue {
  readonly middle: Decimal;
  readonly upper: Decimal;
  readonly lower: Decimal;
  /** `.toFixed()` returns the middle band so the value satisfies the worker-side `ToFixed` contract. */
  toFixed(): string;
}

interface SerializedBollinger {
  readonly ring: readonly string[];
  readonly sum: string;
  readonly sumSq: string;
}

const wrapValue = (middle: Decimal, stddev: Decimal, mult: Decimal): BollingerValue => {
  const offset = mult.times(stddev);
  return {
    middle,
    upper: middle.plus(offset),
    lower: middle.minus(offset),
    toFixed: () => middle.toFixed(),
  };
};

export const incrementalBollinger = (
  period: number,
  mult: Decimal.Value = 2,
): IncrementalIndicator<BollingerState, BollingerValue> => {
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error(`incrementalBollinger: period must be a positive integer (got ${period})`);
  }
  const multD = new Decimal(mult);
  const compute = (state: BollingerState): BollingerValue => {
    const middle = state.sum.dividedBy(period);
    // variance = E[X^2] - E[X]^2; clamp at zero to absorb tiny negative
    // values that arise from Decimal precision loss on near-identical closes.
    let variance = state.sumSq.dividedBy(period).minus(middle.times(middle));
    if (variance.lessThan(0)) variance = new Decimal(0);
    const stddev = variance.sqrt();
    return wrapValue(middle, stddev, multD);
  };

  return {
    id: `bollinger:${period}:${multD.toString()}`,
    initFromWindow: (window: CandleWindow): BollingerState => {
      if (window.length < period) {
        throw new Error(
          `incrementalBollinger(${period}): window length ${window.length} < period ${period}`,
        );
      }
      const ring: Decimal[] = [];
      let sum = new Decimal(0);
      let sumSq = new Decimal(0);
      for (let i = window.length - period; i < window.length; i++) {
        const close = new Decimal((window[i] as Candle).close);
        ring.push(close);
        sum = sum.plus(close);
        sumSq = sumSq.plus(close.times(close));
      }
      return { ring, sum, sumSq };
    },
    update: (state: BollingerState, next: Candle): readonly [BollingerState, BollingerValue] => {
      const close = new Decimal(next.close);
      const oldest = state.ring[0] as Decimal;
      const nextSum = state.sum.minus(oldest).plus(close);
      const nextSumSq = state.sumSq.minus(oldest.times(oldest)).plus(close.times(close));
      const nextRing = [...state.ring.slice(1), close];
      const nextState: BollingerState = { ring: nextRing, sum: nextSum, sumSq: nextSumSq };
      return [nextState, compute(nextState)] as const;
    },
    currentValue: compute,
    serialize: (state: BollingerState): string =>
      JSON.stringify({
        ring: state.ring.map((d) => d.toString()),
        sum: state.sum.toString(),
        sumSq: state.sumSq.toString(),
      } satisfies SerializedBollinger),
    deserialize: (raw: string): BollingerState => {
      const parsed = JSON.parse(raw) as Partial<SerializedBollinger>;
      if (
        !Array.isArray(parsed.ring) ||
        typeof parsed.sum !== 'string' ||
        typeof parsed.sumSq !== 'string'
      ) {
        throw new Error(`incrementalBollinger(${period}): malformed state blob`);
      }
      if (parsed.ring.length !== period) {
        throw new Error(
          `incrementalBollinger(${period}): ring length ${parsed.ring.length} != period ${period}`,
        );
      }
      return {
        ring: parsed.ring.map((s) => new Decimal(s)),
        sum: new Decimal(parsed.sum),
        sumSq: new Decimal(parsed.sumSq),
      };
    },
  };
};
