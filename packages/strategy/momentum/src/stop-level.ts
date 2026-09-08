import { Decimal } from '@app/money';
import { clampStopToExchangeFloor, decOrNull } from '@app/strategy-core';
import type { Candle, StopBandContext } from '@app/strategy-core';

import { coerceInt } from './config-coerce.js';
import { profitLegDistance } from './profit-leg.js';
import { DEFAULT_LIMIT_OFFSET } from './protective-stop.js';
import type { MomentumConfig } from './schema.js';
import { atrTrailingStopPrice } from './trailing-stop.js';

// The single resolution point for momentum's exit level. Three consumers must
// report the same number — the in-process trail, the resting protective stop,
// and the operator preview — and they used to compute it independently, which is
// exactly how they would diverge once a second leg was added.

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
  /** Trail high-water mark the hard leg resolved against on this tick. */
  readonly effectiveHigh: Decimal;
  /** Profit-side high-water mark, or null when the profit trail is off. Persisted by `tick()`. */
  readonly profitHigh: Decimal | null;
  /**
   * `max` of whichever legs resolved — what the in-process trail fires on and
   * what the resting stop mirrors. Null only when NEITHER resolved: no usable
   * `trailingStopPct`, no computable ATR, and no armed profit leg. That means
   * "no trail this tick", never "sell".
   */
  readonly stop: Decimal | null;
  /**
   * Whether `stop` was raised off the operator's level to the lowest trigger
   * Binance's price band accepts. Reported so a caller can say the level shown
   * is the exchange's, not the one configured.
   */
  readonly floorClamped: boolean;
}

/**
 * Resolve the one stop level for a held long from marks the caller already advanced, keeping the in-process exit, exchange order, and operator preview on one number.
 *
 * The hard leg is the ATR chandelier when enabled and computable, otherwise `effectiveHigh × (1 - trailingStopPct)`. The profit leg is `profitHigh × (1 - trailPct)` after activation. Taking their maximum lets the profit leg tighten protection without loosening the hard leg.
 *
 * The profit leg is floored at `entryPrice` so unparsed stored config cannot manufacture a loss after bypassing the schema's cross-field rule.
 *
 * Under `onBandBlock: 'clamp'` the result is raised to the lowest trigger Binance's price band accepts here, before any consumer sees it. A clamp follows that market-anchored floor in both directions, so the ordinary priced-stop pin is deliberately disabled in clamp mode.
 *
 * Outside clamp mode, a priced order already resting on Binance is a final monotone floor. Keeping the resolver at or above that trigger prevents the in-process exit and its exchange backstop from disagreeing while a re-arm candidate would otherwise loosen.
 *
 * @param config - The possibly unparsed momentum settings that select and parameterise both stop legs and the protective-stop band policy.
 * @param entryPrice - The open position's cost basis, used to activate and floor the profit leg.
 * @param effectiveHigh - The hard leg's high-water mark after the caller has advanced it for this tick.
 * @param profitHigh - The profit leg's bucketed high-water mark, or null while that leg is disabled or unavailable.
 * @param tradingCandles - The closed trading-interval candles used to resolve an ATR hard leg.
 * @param bandContext - The current reference price and Binance price band used to derive a clamp floor when configured.
 * @param previousStop - The trigger of our own resting PRICED stop, or null; it is a monotone floor outside clamp mode and is never pinned under clamp mode so the clamp can follow the market down.
 * @returns The shared stop level, its input marks, and whether the exchange floor raised it.
 */
export const resolveStopLevel = (
  config: MomentumConfig,
  entryPrice: Decimal,
  effectiveHigh: Decimal,
  profitHigh: Decimal | null,
  tradingCandles: readonly Candle[],
  bandContext: StopBandContext,
  previousStop: Decimal | null,
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

  const profitDistance = profitLegDistance(config, profitHigh, entryPrice);
  const profitStop =
    profitHigh === null || profitDistance === null
      ? null
      : Decimal.max(entryPrice, profitHigh.mul(new Decimal(1).minus(profitDistance)));

  // The max of whichever legs resolved; null only when neither did.
  const stop =
    hard !== null && profitStop !== null ? Decimal.max(hard, profitStop) : (hard ?? profitStop);

  // Optional chaining throughout: the live worker ticks RAW stored config, so a
  // profile saved before this leaf existed carries no `onBandBlock` key at all.
  // With no order resting at Binance there is no band to satisfy, so a disabled
  // protective stop never tightens the in-app trail.
  const ps = config.protectiveStop;
  const clampMode = ps?.enabled === true && ps.onBandBlock === 'clamp';
  let resolved: StopResolution = { effectiveHigh, profitHigh, stop, floorClamped: false };
  // The same window `computeProtectiveStopLevel` arms in. The clamp exists to
  // keep the in-process level and the resting order on one number, so an offset
  // that resolves to no order must not move the level: outside (0, 1) it would
  // tighten the operator's exit to satisfy a band nothing is ever judged against.
  if (clampMode) {
    const limitOffset = decOrNull(ps.limitOffsetPercentage ?? DEFAULT_LIMIT_OFFSET);
    if (limitOffset !== null && limitOffset.gt(0) && limitOffset.lt(1)) {
      const clamped = clampStopToExchangeFloor({
        stop,
        reference: bandContext.reference ?? '',
        band: bandContext.band,
        limitOffset,
      });
      resolved = {
        effectiveHigh,
        profitHigh,
        stop: clamped.stop,
        floorClamped: clamped.clamped,
      };
    }
  }

  const pinnedStop =
    resolved.stop === null || previousStop === null || clampMode
      ? resolved.stop
      : Decimal.max(resolved.stop, previousStop);
  return { ...resolved, stop: pinnedStop };
};
