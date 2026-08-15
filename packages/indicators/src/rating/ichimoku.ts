// Ichimoku Cloud lines for the Technical Ratings vote. TradingView's rating
// uses the full cloud (conversion, base, leading spans A/B), not just the base
// line. Each line is a Donchian midpoint — (highestHigh + lowestLow) / 2 — over
// its length: conversion 9, base 26, leading span B 52; leading span A is the
// average of conversion and base. The rating reads every line from the current
// traded-bar window, matching timestamp-aligned scanner judgments.
//
// The leading spans are reported undisplaced. Ichimoku normally plots them 26
// bars forward, and TradingView's `Ichimoku.Lead1` / `Ichimoku.Lead2` columns
// carry that shift, but the vote in rating.ts is a constant Neutral either way
// and the undisplaced form is what keeps it so. See the note on `ichimokuVote`
// before changing this.

import Decimal from 'decimal.js';

import { highestHigh, lowestLow } from '@app/indicators';
import type { CandleWindow } from '@app/indicators';

export interface IchimokuCloud {
  /** Conversion line (Tenkan-sen), Donchian midpoint over `convLen`. */
  readonly conversion: Decimal;
  /** Base line (Kijun-sen), Donchian midpoint over `baseLen`. */
  readonly base: Decimal;
  /** Current leading span A (Senkou A), the average of conversion and base. */
  readonly leadA: Decimal;
  /** Current leading span B (Senkou B), Donchian midpoint over `leadBLen`. */
  readonly leadB: Decimal;
}

const donchianMid = (w: CandleWindow, period: number): Decimal => {
  const slice = w.slice(w.length - period);
  return highestHigh(slice).plus(lowestLow(slice)).dividedBy(2);
};

/**
 * Full Ichimoku cloud as of the last candle, or null before every line has
 * enough history. Default lengths 9 / 26 / 52 per TradingView.
 */
export const ichimokuCloud = (
  w: CandleWindow,
  convLen = 9,
  baseLen = 26,
  leadBLen = 52,
): IchimokuCloud | null => {
  const longestPeriod = [convLen, baseLen, leadBLen].reduce(
    (longest, period) => (period > longest ? period : longest),
    0,
  );
  if (w.length < longestPeriod) return null;
  const conversion = donchianMid(w, convLen);
  const base = donchianMid(w, baseLen);
  const leadA = conversion.plus(base).dividedBy(2);
  const leadB = donchianMid(w, leadBLen);
  return { conversion, base, leadA, leadB };
};
