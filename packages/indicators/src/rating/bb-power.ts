// Elder's Bull/Bear Power (Alexander Elder). Bull = high − EMA(close, period),
// Bear = low − EMA(close, period). TradingView's Technical Ratings use
// "Bull Bear Power (13)" — a 13-period EMA — per the documented methodology
// (https://www.tradingview.com/support/solutions/43000614331-technical-ratings/).
// The vote rule lives in rating.ts, where it combines the pair with the same
// 13-EMA's trend (Elder uses the EMA slope as the trend): uptrend + bear power
// recovering from below zero → buy; downtrend + bull power fading from above
// zero → sell.

import Decimal from 'decimal.js';

import type { CandleWindow } from '@app/indicators';

import { ema } from './adapter.js';

export interface BbPower {
  bull: Decimal;
  bear: Decimal;
}

export const bbPower = (w: CandleWindow, period = 13): BbPower | null => {
  if (w.length < period) return null;
  const last = w[w.length - 1];
  /* v8 ignore start -- reason: w.length >= period >= 1 here, so w[w.length-1] is always defined; this is a noUncheckedIndexedAccess guard */
  if (!last) return null;
  /* v8 ignore stop -- reason: end of the unreachable last-undefined guard above */
  const emaClose = ema(w, period);
  /* v8 ignore start -- reason: ema(w, period) returns null only when w.length < period, which the guard above already excluded, so emaClose is never null here */
  if (emaClose === null) return null;
  /* v8 ignore stop -- reason: end of the unreachable null-ema guard above */
  return {
    bull: new Decimal(last.high).minus(emaClose),
    bear: new Decimal(last.low).minus(emaClose),
  };
};
