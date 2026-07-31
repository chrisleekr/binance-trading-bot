// Hull Moving Average (Alan Hull, 2005). Not in the vendored set; composed
// from two WMAs. Formula: WMA(2 * WMA(close, n/2) − WMA(close, n), sqrt(n)).
// The "n/2" is floored and "sqrt(n)" is rounded down — matches the common
// implementation Trading View uses on the chart.

import Decimal from 'decimal.js';

import type { CandleWindow } from '@app/indicators';

import { wma } from './adapter.js';

export const hullMa = (w: CandleWindow, period = 9): Decimal | null => {
  if (period <= 1 || w.length < period) return null;
  // Decimal-based integer ops because the strategy-purity lint bans the `Math`
  // global wholesale (oxlint `no-restricted-globals`; its message names
  // `Math.random` but the rule catches every Math.* call in pure code).
  const halfPeriod = new Decimal(period).dividedBy(2).floor().toNumber();
  const sqrtFloor = new Decimal(period).sqrt().floor().toNumber();
  /* v8 ignore start -- reason: period >= 2 here (period <= 1 returned null above), so floor(sqrt(period)) >= 1; the sqrtFloor < 1 fallback to 1 is unreachable */
  const sqrtPeriod = sqrtFloor < 1 ? 1 : sqrtFloor;
  /* v8 ignore stop -- reason: end of the unreachable sqrtFloor<1 fallback above */
  // The inner series holds 2·WMA(half) − WMA(period) evaluated at every prefix
  // of `w` from `period` long up to the full window. The outer WMA is a
  // finite-window average, so it reads only the LAST `sqrtPeriod` of them, and
  // each inner WMA likewise reads only the trailing `period` closes of its
  // prefix. Materialising every prefix therefore made this O(window²) — with
  // Decimal arithmetic and a synthesised candle per step, it cost ~4.4ms of the
  // ~7.6ms `computeTechnicalsRating` call at the 250-candle replay window, and
  // grew quadratically. Evaluate only the prefixes the outer WMA consumes.
  const innerCount = w.length - period + 1;
  if (innerCount < sqrtPeriod) return null;
  const firstPrefix = w.length - sqrtPeriod + 1;
  const innerCandles: {
    openTimeMs: number;
    closeTimeMs: number;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
    isClosed: boolean;
  }[] = [];
  for (let i = firstPrefix; i <= w.length; i++) {
    const wHalf = wma(w.slice(i - halfPeriod, i), halfPeriod);
    const wFull = wma(w.slice(i - period, i), period);
    /* v8 ignore start -- reason: each slice is exactly as long as its period, so both wma() calls always return a value; the null-skip is a guard that never fires */
    if (wHalf === null || wFull === null) continue;
    /* v8 ignore stop -- reason: end of the unreachable wma-null skip above */
    const v = wHalf.times(2).minus(wFull);
    // Synthesize a candle so we can reuse `wma`; only `close` matters.
    const last = w[i - 1];
    /* v8 ignore start -- reason: firstPrefix >= period >= 2 and i <= w.length, so w[i-1] is always defined; noUncheckedIndexedAccess guard */
    if (!last) continue;
    /* v8 ignore stop -- reason: end of the unreachable last-undefined guard above */
    innerCandles.push({
      openTimeMs: last.openTimeMs,
      closeTimeMs: last.closeTimeMs,
      open: v.toString(),
      high: v.toString(),
      low: v.toString(),
      close: v.toString(),
      volume: '0',
      isClosed: true,
    });
  }
  return wma(innerCandles, sqrtPeriod);
};
