import { Decimal } from '@app/money';
import type { Candle } from '@app/strategy-core';

import { coerceInt } from './config-coerce.js';

/** Breakout lookback as a finite int >= 2, else the 400 default. Live config is unparsed. */
export const breakoutLookback = (raw: unknown): number => coerceInt(raw, { min: 2, fallback: 400 });

/**
 * The highest high of the last `lookback` candles: the price a later close must clear for a breakout entry. The tick passes the window without the candle it is judging, so that candle's own high can never be the level it has to beat; the preview passes the whole closed window, projecting the level the next close faces. Null while fewer than `lookback` candles are available, which reads as no signal rather than a breakout against a partial range.
 *
 * @param candles - Closed candles on the strategy interval, oldest first, ending with the last candle that belongs to the range.
 * @param lookback - How many trailing candles form the range, already coerced by {@link breakoutLookback}.
 * @returns The breakout level, or null when the window is too short to measure the full range.
 */
export const breakoutLevel = (candles: readonly Candle[], lookback: number): Decimal | null => {
  if (candles.length < lookback) return null;
  let level = new Decimal(candles[candles.length - lookback]!.high);
  for (let i = candles.length - lookback + 1; i < candles.length; i++) {
    const high = new Decimal(candles[i]!.high);
    if (high.gt(level)) level = high;
  }
  return level;
};
