import { Decimal } from '@app/money';
import { decOrNull } from '@app/strategy-core';
import type { Candle } from '@app/strategy-core';

import { coerceDec, coerceInt } from './config-coerce.js';
import type { MomentumConfig } from './schema.js';
import { atrTrailingStopPrice } from './trailing-stop.js';

// The single resolution point for momentum's exit level. Three consumers must
// report the same number — the in-process trail, the resting protective stop,
// and the operator preview — and they used to compute it independently, which is
// exactly how they would diverge once a second leg was added.

/** Activation threshold as a fraction in (0, 1), else the schema default. Live config is unparsed. */
const activationPct = (raw: unknown): Decimal => coerceDec(raw, { fallback: '0.05' });

/** Pullback fraction in (0, 1), else the schema default. */
const trailPct = (raw: unknown): Decimal => coerceDec(raw, { fallback: '0.03' });

/** Bucket width in whole minutes, clamped to >= 1, else the schema default. */
const ratchetMinutes = (raw: unknown): number => coerceInt(raw, { min: 1, fallback: 5 });

/**
 * Whether a 1m candle is the FINAL minute of an aligned N-minute window, i.e.
 * whether its close doubles as an N-minute close. `openTimeMs + 60_000` is the
 * candle's end; an aligned window ends when that lands on the grid.
 *
 * Modulo rather than a floor division: `.oxlintrc.json` bans the `Math` global
 * outright inside strategy code, not just `Math.random`. N = 1 reduces to "every
 * 1m close", which is what an operator asking for a one-minute ratchet means.
 */
export const isBucketEnd = (candle: Candle, minutes: number): boolean =>
  (candle.openTimeMs + 60_000) % (minutes * 60_000) === 0;

/**
 * Epoch bounding which 1m closes may ratchet the profit trail: the close instant
 * of the newest 1m candle that had already closed when the position opened.
 *
 * Derived from the candle window rather than from a clock, deliberately. `tick()`
 * has to stay replayable, and a wall-clock stamp written into `nextState` can
 * never reproduce from a golden fixture. Minute resolution loses nothing: the
 * trail only ever folds 1m closes, so a finer epoch could not change which
 * candles qualify.
 *
 * Equally deliberately NOT the entry candle's close, which names the candle the
 * cross fired on: a cross stays live for the rest of that candle, so on a 1h/1d
 * profile the buy can land hours after that close. Folding from there would seed
 * the mark with a pre-entry peak the position never held, arm the trail
 * immediately, and sell the position it just opened.
 *
 * Null when no 1m candle has closed yet — entry epoch unknown, fold nothing.
 */
export const profitTrailEpoch = (oneMinuteCandles: readonly Candle[]): number | null => {
  let newest: number | null = null;
  for (const candle of oneMinuteCandles) {
    if (!candle.isClosed) continue;
    const closeMs = candle.openTimeMs + 60_000;
    if (newest === null || closeMs > newest) newest = closeMs;
  }
  return newest;
};

/**
 * Advance the profit-side high-water mark with the bucket-end closes in this 1m
 * window. `max` is monotone, so folding the WHOLE window every tick is
 * idempotent and self-heals a worker outage that missed boundaries.
 *
 * The window is `market.candlesByInterval['1m']`, which the live worker feeds
 * for every symbol regardless of `candleInterval`. The backtest runner does NOT
 * supply it today — it publishes only a daily auxiliary window — so this leg is
 * inert in backtest unless the profile itself trades on 1m. Tuning the trail
 * against a backtest therefore proves nothing yet.
 *
 * Floored at `entryPrice` so a revived state can never produce a mark below the
 * position's own cost basis. Candles that opened before `sinceMs` (see
 * `profitTrailEpoch`) are excluded, so a peak the position never held cannot
 * leak in. `sinceMs === null` means the entry epoch is unknown — a
 * wallet-reconciled position the bot never opened, or an entry taken before any
 * 1m candle had closed — and folds nothing: the hard stop is the only honest
 * protection for a position whose entry we cannot place in time.
 *
 * Returns null only when the trail is disabled, which is what tells the caller
 * to persist null rather than a stale mark.
 */
export const ratchetProfitHigh = (
  config: MomentumConfig,
  previous: Decimal | null,
  entryPrice: Decimal,
  oneMinuteCandles: readonly Candle[],
  sinceMs: number | null,
): Decimal | null => {
  if (config.profitTrail?.enabled !== true) return null;
  let high = Decimal.max(previous ?? entryPrice, entryPrice);
  if (sinceMs === null) return high;
  const minutes = ratchetMinutes(config.profitTrail.ratchetMinutes);
  for (const candle of oneMinuteCandles) {
    if (!candle.isClosed || candle.openTimeMs < sinceMs) continue;
    if (!isBucketEnd(candle, minutes)) continue;
    const close = new Decimal(candle.close);
    if (close.gt(high)) high = close;
  }
  return high;
};

/** The stop level for a held long, plus the profit mark the tick persists. */
export interface StopResolution {
  /** Profit-side high-water mark, or null when the profit trail is off. Persisted by `tick()`. */
  readonly profitHigh: Decimal | null;
  /**
   * `max` of whichever legs resolved — what the in-process trail fires on and
   * what the resting stop mirrors. Null only when NEITHER resolved: no usable
   * `trailingStopPct`, no computable ATR, and no armed profit leg. That means
   * "no trail this tick", never "sell".
   */
  readonly stop: Decimal | null;
}

/**
 * Resolve the one stop level for a held long from marks the caller already
 * advanced.
 *
 * Two independent legs. The HARD leg is the pre-existing expression — the ATR
 * chandelier when enabled and computable, else `effectiveHigh × (1 −
 * trailingStopPct)` — anchored on the trading interval, so on a 1d profile it
 * moves once a day. The PROFIT leg is `profitHigh × (1 − trailPct)`, live only
 * once `profitHigh` clears `entryPrice × (1 + activationPct)`.
 *
 * The result is the MAX of the two, which is what makes the second leg safe: it
 * can only tighten protection, never loosen it, and a trade that never clears
 * activation behaves exactly as it did before the leg existed.
 *
 * The profit leg is floored at `entryPrice` so it cannot manufacture a loss.
 * The schema's `trailPct < activationPct / (1 + activationPct)` rule already
 * implies that, but only at save time: the worker reads stored config unparsed,
 * and lowering a profile's `activationPct` does not re-validate symbol
 * overrides that were merged against the old one. The floor makes the guarantee
 * structural.
 */
export const resolveStopLevel = (
  config: MomentumConfig,
  entryPrice: Decimal,
  effectiveHigh: Decimal,
  profitHigh: Decimal | null,
  tradingCandles: readonly Candle[],
): StopResolution => {
  let hard = atrTrailingStopPrice(config, tradingCandles, effectiveHigh);
  if (hard === null) {
    // Read defensively but NOT defaulted: an unusable retrace fraction means the
    // operator has no hard stop configured, and quietly substituting one would
    // invent a level they never chose.
    const pct = decOrNull(config.trailingStopPct);
    hard =
      pct !== null && pct.gt(0) && pct.lt(1) ? effectiveHigh.mul(new Decimal(1).minus(pct)) : null;
  }

  const cfg = config.profitTrail;
  const activation = entryPrice.mul(new Decimal(1).plus(activationPct(cfg?.activationPct)));
  // Narrowed to the mark itself rather than to a boolean, so the leg below reads
  // it without an assertion that armed implies non-null.
  const armedHigh =
    cfg?.enabled === true && profitHigh !== null && profitHigh.gte(activation) ? profitHigh : null;
  const profitStop =
    armedHigh === null
      ? null
      : Decimal.max(entryPrice, armedHigh.mul(new Decimal(1).minus(trailPct(cfg?.trailPct))));

  // The max of whichever legs resolved; null only when neither did.
  const stop =
    hard !== null && profitStop !== null ? Decimal.max(hard, profitStop) : (hard ?? profitStop);
  return { profitHigh, stop };
};
