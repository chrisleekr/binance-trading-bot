// Ultimate Oscillator (Larry Williams, 1976). Weighted average of three
// buying-pressure ratios at different lookback periods (default 7, 14, 28).
// Bullish below 30, bearish above 70 — opposite of RSI! Formula:
//   BP = close − min(low, previousClose)
//   TR = max(high, previousClose) − min(low, previousClose)
//   avg(p) = sum(BP, p) / sum(TR, p)
//   UO = 100 * (4·avg(short) + 2·avg(mid) + 1·avg(long)) / 7

import Decimal from 'decimal.js';

import type { CandleWindow } from '@app/indicators';

const ZERO = new Decimal(0);

const sumOver = (arr: Decimal[], period: number, endExclusive: number): Decimal => {
  let acc = ZERO;
  for (let i = endExclusive - period; i < endExclusive; i++) {
    /* v8 ignore start -- reason: callers pass period <= endExclusive <= arr.length, so every index is in range; the ?? ZERO fallback is a noUncheckedIndexedAccess guard that never fires */
    acc = acc.plus(arr[i] ?? ZERO);
    /* v8 ignore stop -- reason: end of the unreachable ?? ZERO index guard above */
  }
  return acc;
};

export const ultimateOscillator = (
  w: CandleWindow,
  short = 7,
  mid = 14,
  long = 28,
): Decimal | null => {
  if (w.length < long + 1) return null;
  // Only the trailing `long` BP/TR pairs are ever summed, and each pair reads
  // its own bar plus the one before it. Every bar older than `long + 1` was
  // costing four Decimal constructions and two subtractions for a value that is
  // then discarded — O(window) dead work per call on the replay hot path.
  const win = w.length > long + 1 ? w.slice(w.length - (long + 1)) : w;
  const bp: Decimal[] = [];
  const tr: Decimal[] = [];
  for (let i = 1; i < win.length; i++) {
    const c = win[i];
    const prev = win[i - 1];
    /* v8 ignore start -- reason: i ranges over [1, w.length), so w[i] and w[i-1] are always defined; noUncheckedIndexedAccess guard */
    if (!c || !prev) continue;
    /* v8 ignore stop -- reason: end of the unreachable candle-undefined guard above */
    const high = new Decimal(c.high);
    const low = new Decimal(c.low);
    const close = new Decimal(c.close);
    const prevClose = new Decimal(prev.close);
    const trueLow = low.lessThan(prevClose) ? low : prevClose;
    const trueHigh = high.greaterThan(prevClose) ? high : prevClose;
    bp.push(close.minus(trueLow));
    tr.push(trueHigh.minus(trueLow));
  }
  /* v8 ignore start -- reason: the loop never `continue`s (the candle guard above is unreachable), so bp gets win.length-1 entries; win is exactly long+1 bars (or w, which is >= long+1), so bp.length >= long always, making this guard unreachable */
  if (bp.length < long) return null;
  /* v8 ignore stop -- reason: end of the unreachable short-bp guard above */
  const end = bp.length;
  const trShort = sumOver(tr, short, end);
  const trMid = sumOver(tr, mid, end);
  const trLong = sumOver(tr, long, end);
  // A flat window has true range 0 at every bar — typical on halted symbols
  // or thinly-traded alts. Dividing by zero would yield NaN/Infinity and
  // fail the contract's `z.number()` validation downstream; return null so
  // the rating's nullable indicator slot covers it.
  if (trShort.isZero() || trMid.isZero() || trLong.isZero()) return null;
  const avgShort = sumOver(bp, short, end).dividedBy(trShort);
  const avgMid = sumOver(bp, mid, end).dividedBy(trMid);
  const avgLong = sumOver(bp, long, end).dividedBy(trLong);
  return avgShort.times(4).plus(avgMid.times(2)).plus(avgLong).times(100).dividedBy(7);
};
