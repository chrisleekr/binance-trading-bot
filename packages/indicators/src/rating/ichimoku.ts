// Ichimoku Cloud lines for the Technical Ratings vote. TradingView's rating
// uses the full cloud (conversion, base, leading spans A/B), not just the base
// line. Each line is a Donchian midpoint — (highestHigh + lowestLow) / 2 — over
// its length: conversion 9, base 26, leading span B 52; leading span A is the
// average of conversion and base. The leading spans are read at the current bar
// (no forward displacement), matching the published Technical Ratings script.

import Decimal from 'decimal.js';

import { highestHigh, lowestLow } from '@app/indicators';
import type { CandleWindow } from '@app/indicators';

export interface IchimokuCloud {
  /** Conversion line (Tenkan-sen), Donchian midpoint over `convLen`. */
  readonly conversion: Decimal;
  /** Base line (Kijun-sen), Donchian midpoint over `baseLen`. */
  readonly base: Decimal;
  /** Leading span A (Senkou A), the average of conversion and base. */
  readonly leadA: Decimal;
  /** Leading span B (Senkou B), Donchian midpoint over `leadBLen`. */
  readonly leadB: Decimal;
}

const donchianMid = (w: CandleWindow, period: number): Decimal => {
  const slice = w.slice(w.length - period);
  return highestHigh(slice).plus(lowestLow(slice)).dividedBy(2);
};

/**
 * Full Ichimoku cloud as of the last candle, or null when the window is shorter
 * than the longest line (`leadBLen`). Default lengths 9 / 26 / 52 per TradingView.
 */
export const ichimokuCloud = (
  w: CandleWindow,
  convLen = 9,
  baseLen = 26,
  leadBLen = 52,
): IchimokuCloud | null => {
  if (w.length < leadBLen) return null;
  const conversion = donchianMid(w, convLen);
  const base = donchianMid(w, baseLen);
  const leadB = donchianMid(w, leadBLen);
  return { conversion, base, leadA: conversion.plus(base).dividedBy(2), leadB };
};
