import { Decimal } from '@app/money';
import { atr } from '@app/indicators';
import type { Candle } from '@app/strategy-core';

import { coerceDec, coerceInt } from './config-coerce.js';

/** ATR period the rise is measured in. Fixed because the research that justified the trigger only tested 14, and an untested knob is a way to overfit live. */
export const IMPULSE_ATR_PERIOD = 14;

/**
 * The impulse block's leaves with the defaults the research selected. Live config is unparsed, so every leaf is coerced.
 *
 * @param raw - The unparsed `impulse` config block; absent or malformed leaves fall back to the researched defaults.
 * @returns The volume baseline length in candles, the volume multiple, and the rise in ATRs the judged candle must beat.
 */
export const impulseSettings = (
  raw: unknown,
): { volumeLookback: number; volumeMultiple: Decimal; riseAtrMultiple: Decimal } => {
  const c = (raw ?? {}) as {
    volumeLookback?: unknown;
    volumeMultiple?: unknown;
    riseAtrMultiple?: unknown;
  };
  return {
    volumeLookback: coerceInt(c.volumeLookback, { min: 2, fallback: 168 }),
    volumeMultiple: coerceDec(c.volumeMultiple, { fallback: '3' }),
    riseAtrMultiple: coerceDec(c.riseAtrMultiple, { fallback: '2' }),
  };
};

/**
 * Candles the trigger reads: the judged candle plus `volumeLookback` before it for the volume average, and enough before it for the ATR's first true range.
 *
 * @param raw - The unparsed `impulse` config block.
 * @returns The window length the trigger needs before it can judge a candle.
 */
export const impulseNeed = (raw: unknown): number => {
  const { volumeLookback } = impulseSettings(raw);
  const atrNeed = IMPULSE_ATR_PERIOD + 1;
  return (volumeLookback > atrNeed ? volumeLookback : atrNeed) + 1;
};

/** What the trigger measured on the last closed candle, for the tick trace. */
export interface ImpulseReading {
  readonly fired: boolean;
  /** The judged candle's volume over the average volume of the candles before it. */
  readonly volumeRatio: Decimal;
  /** The judged candle's close minus open, in ATRs of the candles before it; positive is an up candle. */
  readonly bodyAtr: Decimal;
}

/**
 * Impulse: the last closed candle is a heavy-volume surge, read as new buying that tends to continue. It fires when that candle's volume exceeds `volumeMultiple` times the average of the `volumeLookback` candles before it AND its body (close minus open) rises by more than `riseAtrMultiple` ATRs of the candles before it. Both baselines exclude the judged candle, so the surge cannot dilute its own threshold. In the 2025-26 1h research this entry with a 3 ATR trail made money over the last 90 days and the April-October 2026 half on both the majors and nine pre-chosen large caps, but lost on the majors from October 2025 to April 2026, so it is meant for a small probation profile, not the main one.
 *
 * @param candles - Closed candles on the strategy interval, oldest first, ending with the candle being judged.
 * @param raw - The unparsed `impulse` config block.
 * @returns The reading, or null while the window is shorter than {@link impulseNeed} or the baseline volume or ATR is zero, which reads as no signal.
 */
export const impulseReading = (candles: readonly Candle[], raw: unknown): ImpulseReading | null => {
  const s = impulseSettings(raw);
  if (candles.length < impulseNeed(raw)) return null;
  const last = candles[candles.length - 1]!;
  const prior = candles.slice(0, -1);
  let volume = new Decimal(0);
  for (let i = prior.length - s.volumeLookback; i < prior.length; i++)
    volume = volume.plus(prior[i]!.volume);
  const avgVolume = volume.div(s.volumeLookback);
  const range = atr(prior, IMPULSE_ATR_PERIOD);
  if (!avgVolume.gt(0) || !range.gt(0)) return null;
  const volumeRatio = new Decimal(last.volume).div(avgVolume);
  const bodyAtr = new Decimal(last.close).minus(last.open).div(range);
  return {
    fired: volumeRatio.gt(s.volumeMultiple) && bodyAtr.gt(s.riseAtrMultiple),
    volumeRatio,
    bodyAtr,
  };
};

/**
 * The close the next candle would need for the rise leg to fire if it opened at the last close: `lastClose + riseAtrMultiple × ATR`. A projection for the preview only; the volume leg cannot be projected.
 *
 * @param candles - Closed candles on the strategy interval, oldest first.
 * @param raw - The unparsed `impulse` config block.
 * @returns The level, or null when the window is too short for the ATR.
 */
export const impulseLevel = (candles: readonly Candle[], raw: unknown): Decimal | null => {
  if (candles.length < IMPULSE_ATR_PERIOD + 1) return null;
  return new Decimal(candles[candles.length - 1]!.close).plus(
    impulseSettings(raw).riseAtrMultiple.times(atr(candles, IMPULSE_ATR_PERIOD)),
  );
};
