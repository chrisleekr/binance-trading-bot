// Incremental Wilder's Average Directional Index.
//
// Three Wilder-smoothed accumulators run in parallel: smoothedTR,
// smoothedPlusDM, smoothedMinusDM. From those:
//   +DI = smoothedPlusDM / smoothedTR * 100
//   -DI = smoothedMinusDM / smoothedTR * 100
//   DX  = |+DI - -DI| / (+DI + -DI) * 100
//   ADX = Wilder-smoothed DX
//
// Wilder smoothing convention used throughout: `next = prev - prev/period + current`.
// The ADX itself is seeded after `period` DX values have accumulated, then
// follows the same smoothing formula. Total cold-start need: `2 * period + 1`
// candles (the first `period+1` produces the initial smoothed TR/DM seeds;
// the next `period` DX values feed the ADX seed).
//
// State carries every accumulator plus `prevHigh, prevLow, prevClose` so
// the next `update` can compute TR + DM from a single candle.

import Decimal from 'decimal.js';
import type { Candle } from '@app/strategy-core';
import type { CandleWindow } from '@app/indicators';
import type { IncrementalIndicator } from './types.js';

export interface ADXState {
  readonly smoothedTR: Decimal;
  readonly smoothedPlusDM: Decimal;
  readonly smoothedMinusDM: Decimal;
  readonly adx: Decimal;
  readonly prevHigh: Decimal;
  readonly prevLow: Decimal;
  readonly prevClose: Decimal;
}

export interface ADXValue {
  readonly adx: Decimal;
  readonly plusDI: Decimal;
  readonly minusDI: Decimal;
  toFixed(): string;
}

interface SerializedADX {
  readonly smoothedTR: string;
  readonly smoothedPlusDM: string;
  readonly smoothedMinusDM: string;
  readonly adx: string;
  readonly prevHigh: string;
  readonly prevLow: string;
  readonly prevClose: string;
}

const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);

const dmax = (a: Decimal, b: Decimal): Decimal => (a.greaterThan(b) ? a : b);
const dabs = (a: Decimal): Decimal => (a.lessThan(0) ? a.negated() : a);

const trueRange = (high: Decimal, low: Decimal, prevClose: Decimal): Decimal =>
  dmax(high.minus(low), dmax(dabs(high.minus(prevClose)), dabs(low.minus(prevClose))));

const directionalMoves = (
  high: Decimal,
  low: Decimal,
  prevHigh: Decimal,
  prevLow: Decimal,
): { plus: Decimal; minus: Decimal } => {
  const upMove = high.minus(prevHigh);
  const downMove = prevLow.minus(low);
  const plus = upMove.greaterThan(downMove) && upMove.greaterThan(0) ? upMove : ZERO;
  const minus = downMove.greaterThan(upMove) && downMove.greaterThan(0) ? downMove : ZERO;
  return { plus, minus };
};

const computeDIs = (
  smoothedTR: Decimal,
  smoothedPlusDM: Decimal,
  smoothedMinusDM: Decimal,
): { plusDI: Decimal; minusDI: Decimal } => {
  if (smoothedTR.isZero()) {
    return { plusDI: ZERO, minusDI: ZERO };
  }
  return {
    plusDI: smoothedPlusDM.dividedBy(smoothedTR).times(HUNDRED),
    minusDI: smoothedMinusDM.dividedBy(smoothedTR).times(HUNDRED),
  };
};

const computeDX = (plusDI: Decimal, minusDI: Decimal): Decimal => {
  const sum = plusDI.plus(minusDI);
  if (sum.isZero()) return ZERO;
  return dabs(plusDI.minus(minusDI)).dividedBy(sum).times(HUNDRED);
};

const wrap = (adx: Decimal, plusDI: Decimal, minusDI: Decimal): ADXValue => ({
  adx,
  plusDI,
  minusDI,
  toFixed: () => adx.toFixed(),
});

export const incrementalADX = (period: number): IncrementalIndicator<ADXState, ADXValue> => {
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error(`incrementalADX: period must be a positive integer (got ${period})`);
  }
  const minWindow = 2 * period + 1;

  return {
    id: `adx:${period}`,
    initFromWindow: (window: CandleWindow): ADXState => {
      if (window.length < minWindow) {
        throw new Error(
          `incrementalADX(${period}): window length ${window.length} < 2*period+1 ${minWindow}`,
        );
      }
      // First `period+1` candles: produce `period` TR/+DM/-DM seeds.
      // Initial Wilder smoothed values are the *sum* of those seeds; the
      // first update will start the `next = prev - prev/period + current`
      // smoothing.
      let smTR = ZERO;
      let smPDM = ZERO;
      let smMDM = ZERO;
      for (let i = 1; i <= period; i++) {
        const cur = window[i] as Candle;
        const prev = window[i - 1] as Candle;
        const prevClose = new Decimal(prev.close);
        const high = new Decimal(cur.high);
        const low = new Decimal(cur.low);
        smTR = smTR.plus(trueRange(high, low, prevClose));
        const dm = directionalMoves(high, low, new Decimal(prev.high), new Decimal(prev.low));
        smPDM = smPDM.plus(dm.plus);
        smMDM = smMDM.plus(dm.minus);
      }
      // Accumulate `period` DX values then ADX-seed = mean(DX). Continue
      // smoothing past 2*period if the window is longer than minWindow.
      let dxSum = ZERO;
      let dxCount = 0;
      let adx = ZERO;
      let prevHigh = new Decimal((window[period] as Candle).high);
      let prevLow = new Decimal((window[period] as Candle).low);
      let prevClose = new Decimal((window[period] as Candle).close);
      for (let i = period + 1; i < window.length; i++) {
        const cur = window[i] as Candle;
        const high = new Decimal(cur.high);
        const low = new Decimal(cur.low);
        const close = new Decimal(cur.close);
        const tr = trueRange(high, low, prevClose);
        const dm = directionalMoves(high, low, prevHigh, prevLow);
        smTR = smTR.minus(smTR.dividedBy(period)).plus(tr);
        smPDM = smPDM.minus(smPDM.dividedBy(period)).plus(dm.plus);
        smMDM = smMDM.minus(smMDM.dividedBy(period)).plus(dm.minus);
        const { plusDI, minusDI } = computeDIs(smTR, smPDM, smMDM);
        const dx = computeDX(plusDI, minusDI);
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
        prevHigh = high;
        prevLow = low;
        prevClose = close;
      }
      return {
        smoothedTR: smTR,
        smoothedPlusDM: smPDM,
        smoothedMinusDM: smMDM,
        adx,
        prevHigh,
        prevLow,
        prevClose,
      };
    },
    update: (state: ADXState, next: Candle): readonly [ADXState, ADXValue] => {
      const high = new Decimal(next.high);
      const low = new Decimal(next.low);
      const close = new Decimal(next.close);
      const tr = trueRange(high, low, state.prevClose);
      const dm = directionalMoves(high, low, state.prevHigh, state.prevLow);
      const smTR = state.smoothedTR.minus(state.smoothedTR.dividedBy(period)).plus(tr);
      const smPDM = state.smoothedPlusDM
        .minus(state.smoothedPlusDM.dividedBy(period))
        .plus(dm.plus);
      const smMDM = state.smoothedMinusDM
        .minus(state.smoothedMinusDM.dividedBy(period))
        .plus(dm.minus);
      const { plusDI, minusDI } = computeDIs(smTR, smPDM, smMDM);
      const dx = computeDX(plusDI, minusDI);
      const adx = state.adx
        .times(period - 1)
        .plus(dx)
        .dividedBy(period);
      const nextState: ADXState = {
        smoothedTR: smTR,
        smoothedPlusDM: smPDM,
        smoothedMinusDM: smMDM,
        adx,
        prevHigh: high,
        prevLow: low,
        prevClose: close,
      };
      return [nextState, wrap(adx, plusDI, minusDI)] as const;
    },
    currentValue: (state) => {
      const { plusDI, minusDI } = computeDIs(
        state.smoothedTR,
        state.smoothedPlusDM,
        state.smoothedMinusDM,
      );
      return wrap(state.adx, plusDI, minusDI);
    },
    serialize: (state) =>
      JSON.stringify({
        smoothedTR: state.smoothedTR.toString(),
        smoothedPlusDM: state.smoothedPlusDM.toString(),
        smoothedMinusDM: state.smoothedMinusDM.toString(),
        adx: state.adx.toString(),
        prevHigh: state.prevHigh.toString(),
        prevLow: state.prevLow.toString(),
        prevClose: state.prevClose.toString(),
      } satisfies SerializedADX),
    deserialize: (raw: string): ADXState => {
      const parsed = JSON.parse(raw) as Partial<SerializedADX>;
      const fields: (keyof SerializedADX)[] = [
        'smoothedTR',
        'smoothedPlusDM',
        'smoothedMinusDM',
        'adx',
        'prevHigh',
        'prevLow',
        'prevClose',
      ];
      for (const f of fields) {
        if (typeof parsed[f] !== 'string') {
          throw new Error(`incrementalADX(${period}): malformed state blob (missing ${f})`);
        }
      }
      return {
        smoothedTR: new Decimal(parsed.smoothedTR as string),
        smoothedPlusDM: new Decimal(parsed.smoothedPlusDM as string),
        smoothedMinusDM: new Decimal(parsed.smoothedMinusDM as string),
        adx: new Decimal(parsed.adx as string),
        prevHigh: new Decimal(parsed.prevHigh as string),
        prevLow: new Decimal(parsed.prevLow as string),
        prevClose: new Decimal(parsed.prevClose as string),
      };
    },
  };
};
