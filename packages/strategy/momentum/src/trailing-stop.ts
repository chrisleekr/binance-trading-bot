import type { Decimal } from '@app/money';
import { atr } from '@app/indicators';
import type { Candle } from '@app/strategy-core';

import { coerceDec, coerceInt } from './config-coerce.js';
import type { MomentumConfig } from './schema.js';

/** ATR lookback as a finite int >= 2, else the 14 default. Live config is unparsed. */
const atrStopPeriod = (raw: unknown): number => coerceInt(raw, { min: 2, fallback: 14 });

/** ATR multiple as a positive Decimal, else the 3 default. */
const atrStopMultiple = (raw: unknown) => coerceDec(raw, { fallback: '3' });

/**
 * The volatility-scaled trailing-stop price for the current tick, or null when
 * the ATR mode is off, the window is too short to compute ATR, or the resulting
 * stop is non-positive. Chandelier exit: `effectiveHigh − multiple × ATR(period)`.
 * Both the in-process trail and the resting protective stop resolve their level
 * through this one function, so they can never diverge. Null means "fall back to
 * the fixed `trailingStopPct`" — the caller keeps the existing fixed expression,
 * so a disabled block leaves the fixed path byte-identical. Config is read
 * defensively (the live worker passes it unparsed).
 */
export const atrTrailingStopPrice = (
  config: MomentumConfig,
  candles: readonly Candle[],
  effectiveHigh: Decimal,
): Decimal | null => {
  const cfg = config.atrTrailingStop;
  if (cfg?.enabled !== true) return null;
  const period = atrStopPeriod(cfg.period);
  // ATR needs period + 1 candles for the first true-range value.
  if (candles.length < period + 1) return null;
  const stop = effectiveHigh.minus(atrStopMultiple(cfg.multiple).times(atr(candles, period)));
  return stop.gt(0) ? stop : null;
};
