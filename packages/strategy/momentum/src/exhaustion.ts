import { Decimal } from '@app/money';
import { rsi, sma } from '@app/indicators';
import type { Candle } from '@app/strategy-core';

import { coerceDec } from './config-coerce.js';
import { choppiness } from './ma-cluster.js';

/** Long average the drop is measured against. Fixed at the 400 the research used, like the cluster periods: an untested knob is a way to overfit live. */
export const EXHAUSTION_TREND_PERIOD = 400;

/** RSI period. Fixed at the 14 the research used. */
export const EXHAUSTION_RSI_PERIOD = 14;

/**
 * The exhaustion block's leaves with the defaults the research selected. Live config is unparsed, so every leaf is coerced.
 *
 * @param raw - The unparsed `exhaustion` config block; absent or malformed leaves fall back to the researched defaults.
 * @returns The choppiness ceiling, the fraction the close must sit under the 400-candle average, and the RSI ceiling.
 */
export const exhaustionSettings = (
  raw: unknown,
): { maxChoppiness: Decimal; minBelowAverage: Decimal; maxRsi: Decimal } => {
  const c = (raw ?? {}) as { maxChoppiness?: unknown; minBelowAverage?: unknown; maxRsi?: unknown };
  return {
    maxChoppiness: coerceDec(c.maxChoppiness, { fallback: '30' }),
    minBelowAverage: coerceDec(c.minBelowAverage, { fallback: '0.05' }),
    maxRsi: coerceDec(c.maxRsi, { fallback: '25' }),
  };
};

/**
 * Candles the trigger reads: the 400-candle average is the longest; the choppiness and RSI windows fit inside it.
 *
 * @returns The window length the trigger needs before it can judge a candle.
 */
export const exhaustionNeed = (): number => EXHAUSTION_TREND_PERIOD + 1;

/** What the trigger measured on the last closed candle, for the tick trace. */
export interface ExhaustionReading {
  readonly fired: boolean;
  /** Choppiness Index on the judged candle; low means the candles travelled in one direction. */
  readonly choppiness: Decimal;
  /** How far the close sits under the 400-candle average, as a fraction; negative means above it. */
  readonly belowAverage: Decimal;
  /** RSI(14) on the judged candle. */
  readonly rsi: Decimal;
}

/**
 * Exhaustion: a fast, one-way slide that has run far under the long average, read as sellers running out. It fires when the Choppiness Index is under `maxChoppiness` (the slide is a clean trend, not chop), the close is more than `minBelowAverage` under the 400-candle average, and RSI(14) is under `maxRsi` (oversold). It buys against the trend, so the trend filter must be off for it to ever fire. In the 2025-26 1h research, with a 1.5 ATR trail, it made money over the last 90 days and the April-October 2026 half on both the majors and nine pre-chosen large caps, beating random entries, but lost on the majors from October 2025 to April 2026, so it is meant for a small probation profile, not the main one.
 *
 * @param candles - Closed candles on the strategy interval, oldest first, ending with the candle being judged.
 * @param raw - The unparsed `exhaustion` config block.
 * @returns The reading, or null while the window is shorter than {@link exhaustionNeed}.
 */
export const exhaustionReading = (
  candles: readonly Candle[],
  raw: unknown,
): ExhaustionReading | null => {
  if (candles.length < exhaustionNeed()) return null;
  const s = exhaustionSettings(raw);
  const close = new Decimal(candles[candles.length - 1]!.close);
  const chop = choppiness(candles);
  const belowAverage = new Decimal(1).minus(close.div(sma(candles, EXHAUSTION_TREND_PERIOD)));
  const strength = rsi(candles, EXHAUSTION_RSI_PERIOD);
  return {
    fired: chop.lt(s.maxChoppiness) && belowAverage.gt(s.minBelowAverage) && strength.lt(s.maxRsi),
    choppiness: chop,
    belowAverage,
    rsi: strength,
  };
};

/**
 * The price the close must fall under for the drop leg to fire: the 400-candle average less `minBelowAverage`. A projection for the preview only; the choppiness and RSI legs cannot be projected.
 *
 * @param candles - Closed candles on the strategy interval, oldest first.
 * @param raw - The unparsed `exhaustion` config block.
 * @returns The level, or null while the window is shorter than {@link exhaustionNeed}, the length the tick needs before it can judge a candle.
 */
export const exhaustionLevel = (candles: readonly Candle[], raw: unknown): Decimal | null => {
  if (candles.length < exhaustionNeed()) return null;
  return sma(candles, EXHAUSTION_TREND_PERIOD).times(
    new Decimal(1).minus(exhaustionSettings(raw).minBelowAverage),
  );
};
