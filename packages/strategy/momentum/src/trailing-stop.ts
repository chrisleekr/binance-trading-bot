import type { Decimal } from '@app/money';
import { atr } from '@app/indicators';
import { decOrNull } from '@app/strategy-core';
import type { Candle } from '@app/strategy-core';

import { coerceDec, coerceInt } from './config-coerce.js';
import type { MomentumConfig } from './schema.js';

/** ATR lookback as a finite int >= 2, else the 14 default. Live config is unparsed. */
export const atrStopPeriod = (raw: unknown): number => coerceInt(raw, { min: 2, fallback: 14 });

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

/** A stop distance is only usable as a divisor when it is a real fraction of the entry price: zero would divide by nothing and 1 or more means the stop sits at or below zero. Returns the value only when it is in the open interval (0, 1), else null. */
export const unitFraction = (d: Decimal | null): Decimal | null =>
  d !== null && d.gt(0) && d.lt(1) ? d : null;

/**
 * The INITIAL stop distance for a not-yet-open position, as a fraction of the entry price, or null when it cannot be resolved. This is the denominator risk-based sizing divides equity risk by, so it answers "how much of this position is at stake if the first stop fires", not "where does the stop sit".
 *
 * It deliberately does NOT inherit `resolveStopLevel`'s fallback. That function drops back to the fixed `trailingStopPct` whenever the ATR level is null, which is right for an OPEN position: some stop beats none. Here it would be wrong — but only for two of the three refusals below, which are not one story.
 *
 * The genuine divergence is a window too short to measure volatility, and a window whose `multiple × ATR` spans the whole price so the chandelier level lands at or below zero — the first stop is anchored on a high seeded to the entry price, so spanning the price and going non-positive are the same condition here. In both, `atrTrailingStopPrice` yields null and `resolveStopLevel` rests a fixed-percent stop that the ATR level replaces as soon as the reading changes — once enough candles have closed in the first case, whenever volatility narrows in the second, which nothing bounds. Sizing against that temporary fixed distance would state a per-trade loss the position will never actually carry, and the cost of refusing is one signal on a symbol whose stop distance cannot yet be named. Do not "fix" the divergence by mirroring the fallback.
 *
 * The third refusal is not a divergence at all: at an ATR of exactly zero the chandelier is `effectiveHigh` itself, which clears that function's own `stop.gt(0)` check, so `atrTrailingStopPrice` returns a level and no fallback is ever reached. Zero is refused here for the reason `unitFraction` already gives — it is not a divisor.
 *
 * One leg of `resolveStopLevel` stays unmodelled by design: under `protectiveStop.onBandBlock: 'clamp'` the level is finally raised to the lowest trigger Binance's `PERCENT_PRICE_BY_SIDE` band accepts, which can sit far nearer the market than the ATR distance sized against here. That floor is band-relative and re-derived every tick from live exchange filters, so an entry-time function cannot predict it, and the error runs the safe way: a clamped stop costs less than `riskPct`, not more.
 *
 * @param config - Momentum config, read defensively: the live worker passes it unparsed, so every leaf may be absent or malformed.
 * @param candles - Closed candles on the strategy interval, oldest first; the ATR window is measured off the tail.
 * @param price - The price the entry would fill at, which is both the divisor and the scale the fraction is quoted against.
 * @returns The stop distance as a fraction of `price` in (0, 1), or null when the configured mode cannot produce one.
 */
export const initialStopDistanceFraction = (
  config: MomentumConfig,
  candles: readonly Candle[],
  price: Decimal,
): Decimal | null => {
  if (!price.gt(0)) return null;
  const cfg = config.atrTrailingStop;
  if (cfg?.enabled !== true) return unitFraction(decOrNull(config.trailingStopPct));
  const period = atrStopPeriod(cfg.period);
  // ATR needs period + 1 candles for the first true-range value.
  if (candles.length < period + 1) return null;
  return unitFraction(atrStopMultiple(cfg.multiple).times(atr(candles, period)).div(price));
};
