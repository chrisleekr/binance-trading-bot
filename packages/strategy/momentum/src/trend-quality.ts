import { Decimal } from '@app/money';
import type { Candle } from '@app/strategy-core';

import { coerceDec, coerceInt } from './config-coerce.js';

/**
 * The trendQuality block's leaves with the defaults the research selected. Live config is unparsed, so every leaf is coerced.
 *
 * @param raw - The unparsed `trendQuality` config block; absent or malformed leaves fall back to the researched defaults.
 * @returns The number of closes each regression fits, and the R-squared the fit must beat.
 */
export const trendQualitySettings = (raw: unknown): { lookback: number; minRSquared: Decimal } => {
  const c = (raw ?? {}) as { lookback?: unknown; minRSquared?: unknown };
  return {
    // Fewer than three points fit a line exactly, so R-squared would be 1 by construction.
    lookback: coerceInt(c.lookback, { min: 3, fallback: 48 }),
    minRSquared: coerceDec(c.minRSquared, { fallback: '0.9' }),
  };
};

/**
 * Candles the trigger reads: the judged candle's regression plus the previous candle's, which fits the same number of closes one bar earlier.
 *
 * @param raw - The unparsed `trendQuality` config block.
 * @returns The window length the trigger needs before it can judge a candle.
 */
export const trendQualityNeed = (raw: unknown): number => trendQualitySettings(raw).lookback + 1;

/** Least-squares line through `ys` against 0..n-1: how well it fits (R-squared), its slope per candle, and its value at the last point. */
interface LineFit {
  readonly rSquared: Decimal;
  readonly slope: Decimal;
  readonly fitted: Decimal;
}

/**
 * Ordinary least squares of `ys` on x = 0..n-1.
 *
 * @param ys - Natural-log closes of one regression window, oldest first.
 * @returns R-squared (0 when the closes are all equal), slope per candle, and the fitted value at the last point.
 */
const fitLine = (ys: readonly Decimal[]): LineFit => {
  const n = ys.length;
  const xMean = new Decimal(n - 1).div(2);
  const yMean = Decimal.sum(...ys).div(n);
  let sxx = new Decimal(0);
  let sxy = new Decimal(0);
  let syy = new Decimal(0);
  ys.forEach((y, x) => {
    const dx = new Decimal(x).minus(xMean);
    const dy = y.minus(yMean);
    sxx = sxx.plus(dx.times(dx));
    sxy = sxy.plus(dx.times(dy));
    syy = syy.plus(dy.times(dy));
  });
  const slope = sxy.div(sxx);
  return {
    rSquared: syy.isZero() ? new Decimal(0) : sxy.times(sxy).div(sxx.times(syy)),
    slope,
    fitted: yMean.plus(slope.times(new Decimal(n - 1).minus(xMean))),
  };
};

/** What the trigger measured on the last closed candle, for the tick trace. */
export interface TrendQualityReading {
  readonly fired: boolean;
  /** The judged candle's fit is straight and rising: R-squared above the minimum and slope above zero. */
  readonly armed: boolean;
  /** The previous candle's fit was already straight and rising, so this trend is not fresh. */
  readonly previousArmed: boolean;
  /** R-squared of the judged candle's regression: 1 means the closes sit exactly on a straight line. */
  readonly rSquared: Decimal;
  /** Regression slope per candle, in natural-log units, so about the fractional price change per candle. */
  readonly slope: Decimal;
  /** ln(close) minus the line's value at the judged candle; positive means the close is above the line. */
  readonly aboveLine: Decimal;
}

/**
 * Trend quality: the last `lookback` closes, on a log scale, sit close to a rising straight line (R-squared, how closely the closes follow a straight line, above `minRSquared`; slope above zero), the close is above that line, and the previous candle's fit was not already straight and rising, so each trend fires once as it forms. Only the previous candle's R-squared and slope are checked, not its close against the line. In the 2025-26 1h research, with a 4 ATR trail, it made money after 2.5x costs on nine pre-chosen large caps over the last 90 days, the April-October 2026 half and the last 365 days, beating nearly all random entries, but was weaker on the five majors and rested on one coin there, so it is meant for a small probation profile, not the main one.
 *
 * @param candles - Closed candles on the strategy interval, oldest first, ending with the candle being judged.
 * @param raw - The unparsed `trendQuality` config block.
 * @returns The reading, or null while the window is shorter than {@link trendQualityNeed}.
 */
export const trendQualityReading = (
  candles: readonly Candle[],
  raw: unknown,
): TrendQualityReading | null => {
  const s = trendQualitySettings(raw);
  if (candles.length < s.lookback + 1) return null;
  const ys = candles.slice(-(s.lookback + 1)).map((c) => new Decimal(c.close).ln());
  const now = fitLine(ys.slice(1));
  const before = fitLine(ys.slice(0, -1));
  const armed = now.rSquared.gt(s.minRSquared) && now.slope.gt(0);
  const previousArmed = before.rSquared.gt(s.minRSquared) && before.slope.gt(0);
  const aboveLine = ys[ys.length - 1]!.minus(now.fitted);
  return {
    fired: armed && aboveLine.gt(0) && !previousArmed,
    armed,
    previousArmed,
    rSquared: now.rSquared,
    slope: now.slope,
    aboveLine,
  };
};

/**
 * The price the line leg compares the close with: the current regression line's value at the last candle. A projection for the preview only; the next candle's line sits higher, and the R-squared and freshness legs cannot be projected.
 *
 * @param candles - Closed candles on the strategy interval, oldest first.
 * @param raw - The unparsed `trendQuality` config block.
 * @returns The level, or null while the window is shorter than {@link trendQualityNeed}.
 */
export const trendQualityLevel = (candles: readonly Candle[], raw: unknown): Decimal | null => {
  const s = trendQualitySettings(raw);
  if (candles.length < s.lookback + 1) return null;
  return fitLine(candles.slice(-s.lookback).map((c) => new Decimal(c.close).ln())).fitted.exp();
};
