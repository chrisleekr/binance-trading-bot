import { Decimal, roundToTick } from '@app/money';
import { clampStopToExchangeFloor, decOrNull } from '@app/strategy-core';
import type {
  MarketSnapshot,
  ProtectiveStopBandSettings,
  StopBandContext,
} from '@app/strategy-core';

import { safeDecimal } from './branches/safe-decimal.js';
import type { TTConfig, TTState } from './schema.js';

// Default limit offset when a stored config predates the field. Kept beside the
// resolver because the exchange price floor is derived from it: a second copy
// elsewhere would floor at a different price than the one the order carries.
export const DEFAULT_LIMIT_OFFSET = '0.995';

/**
 * The `protectiveStop` block as a reader may trust it, narrowed off a raw stored
 * config. Every field is `unknown` on purpose: the live worker ticks RAW stored
 * config, so the block may be absent entirely and a profile saved before
 * `onBandBlock` existed carries no such key. `null` means there is nothing to
 * read, which every caller answers by leaving the band alone.
 */
interface RawProtectiveStop {
  readonly enabled?: unknown;
  readonly limitOffsetPercentage?: unknown;
  readonly onBandBlock?: unknown;
}

/** Narrow a raw `protectiveStop` block, or null when it is not an object at all. */
export const narrowProtectiveStop = (raw: unknown): RawProtectiveStop | null =>
  typeof raw === 'object' && raw !== null ? (raw as RawProtectiveStop) : null;

/** Resolve the limit offset used by trailing-trade's protective-stop sell floor. Missing, unparseable, or non-positive offsets mean the exchange arm rests no limit leg, so 1 models the in-process MARKET sell at the trigger. An offset above 1 would make the arm rest a limit above the trigger; capping it at 1 prices the sell no higher than the trigger and demands at least as much quantity as the arm's real limit, keeping the floor conservative. A disabled protective stop also has no limit leg and therefore uses 1.
 * @param protectiveStop - The protective-stop settings, or undefined when the stored config has no block.
 * @returns The parsed offset in (0, 1], or 1 when no protective-stop limit leg is the effective exit.
 */
export const ttStopLimitOffset = (
  protectiveStop: TTConfig['sell']['protectiveStop'] | undefined,
): Decimal => {
  if (protectiveStop?.enabled !== true) return new Decimal(1);
  const rawLimitOffset = protectiveStop.limitOffsetPercentage;
  if (typeof rawLimitOffset !== 'string') return new Decimal(1);
  const limitOffset = safeDecimal(rawLimitOffset);
  return limitOffset !== null && limitOffset.gt(0) && limitOffset.lte(1)
    ? limitOffset
    : new Decimal(1);
};

/** The loss-side stop level, and whether the exchange band raised it off the configured one. */
export interface TTStopResolution {
  readonly stop: Decimal;
  /**
   * True when `stop` is the lowest trigger Binance's price band accepts rather
   * than `avgEntry × stopLossPercentage`. Reported so a caller can say the level
   * shown belongs to the exchange, not to the config.
   */
  readonly floorClamped: boolean;
}

/**
 * The ONE resolution point for trailing-trade's loss-side stop: `avgEntry ×
 * stopLossPercentage`, then raised to the exchange's price floor under
 * `onBandBlock: 'clamp'`.
 *
 * Three consumers must report the same number — the in-process sell gate, the
 * resting protective stop, and the operator preview — and they computed the
 * product independently. That was survivable while the expression was a bare
 * multiply; it stops being survivable with a clamp, because the protective stop
 * rounds its result onto the tick grid and the other two do not. Two independent
 * clamps would round on opposite sides of the floor and disagree by a tick, and
 * the replay drift gate fails any tick where the emitted level cleared a preview
 * row the projection left behind.
 *
 * `protectiveStop` is typed `unknown` on purpose: the live worker ticks RAW
 * stored config, so the block may be absent entirely, and a profile saved before
 * `onBandBlock` existed carries no such key. Every read here narrows first, and
 * anything that does not narrow means "do not clamp".
 */
export const resolveTTStopLevel = (params: {
  readonly avgEntry: Decimal;
  readonly stopPct: Decimal;
  readonly protectiveStop: unknown;
  readonly bandContext: StopBandContext;
}): TTStopResolution => {
  const { avgEntry, stopPct, protectiveStop, bandContext } = params;
  const stop = avgEntry.mul(stopPct);
  const unclamped = { stop, floorClamped: false };

  const ps = narrowProtectiveStop(protectiveStop);
  // With no order resting at Binance there is no band to satisfy, so a disabled
  // protective stop never moves the in-process stop-loss.
  if (ps === null || ps.enabled !== true || ps.onBandBlock !== 'clamp') return unclamped;

  const limitOffset = decOrNull(ps.limitOffsetPercentage ?? DEFAULT_LIMIT_OFFSET);
  if (limitOffset === null) return unclamped;

  const clamped = clampStopToExchangeFloor({
    stop,
    reference: bandContext.reference ?? '',
    band: bandContext.band,
    limitOffset,
  });
  return { stop: clamped.stop, floorClamped: clamped.clamped };
};

/** Resolve the actual stop-limit sell price used to assess a held position, including any exchange-band clamp and protective-stop limit offset. The protective-stop arm rests no limit leg when an enabled stop's offset is missing, unparseable, or non-positive, so 1 models the in-process MARKET sell at the trigger. An offset above 1 would make the arm rest a limit above the trigger; capping it at 1 prices the sell no higher than the trigger and demands at least as much quantity as the arm's real limit, keeping the exit-blocker floor conservative. A disabled protective stop also has no limit leg and therefore uses 1.
 *
 * The result is quantised onto the symbol's price grid twice, trigger then limit, because the arm quantises at both of those points and Binance judges the minimum on the bytes the order carries, not on the exact product. Both quantisations FLOOR, so the unquantised product sits up to two ticks HIGH: on a coarse-tick pair that is enough for this rung to call a position sellable at its stop while the arm, pricing the same position on the grid, refuses it as below the exchange minimum and rests nothing. Naming the same price here is what makes the two answers one answer.
 * @param config - The raw trailing-trade configuration containing the loss stop and protective-stop settings.
 * @param state - The current trailing-trade state containing the average entry price.
 * @param market - The symbol snapshot supplying the live price, percent-price band and price grid.
 * @returns The grid-aligned stop-limit sell price, or null when the entry, stop percentage or tick size is not a positive valid decimal, or when the quantised price floors to zero.
 */
export const ttStopSellPrice = (
  config: TTConfig,
  state: TTState,
  market: MarketSnapshot,
): Decimal | null => {
  const avgEntry = decOrNull(state.avgEntryPrice);
  const stopPct = decOrNull(config.sell.stopLossPercentage);
  // An unusable tick leaves the arm unable to build a level at all, so it rests nothing. Claiming a sell price here would be claiming a price no order can carry.
  const tick = decOrNull(market.symbolInfo.filters.tickSize);
  if (
    avgEntry === null ||
    !avgEntry.gt(0) ||
    stopPct === null ||
    !stopPct.gt(0) ||
    !stopPct.lte(1) ||
    tick === null ||
    !tick.gt(0)
  ) {
    return null;
  }

  const { stop } = resolveTTStopLevel({
    avgEntry,
    stopPct,
    protectiveStop: config.sell.protectiveStop,
    bandContext: {
      reference: market.currentPrice,
      band: market.symbolInfo.filters.percentPriceBySide,
    },
  });
  const limitOffset = ttStopLimitOffset(config.sell.protectiveStop);
  const sellPrice = roundToTick(roundToTick(stop, tick).mul(limitOffset), tick);
  return sellPrice.gt(0) ? sellPrice : null;
};

/**
 * What this config asks of a symbol's price band, for a caller checking a bind
 * before any position exists.
 *
 * `stopLossPercentage` is a fraction OF the entry price (`0.97` = stop 3% under
 * it), so the distance is its complement. Measured against the entry rather than
 * the live market, which is the tightest the stop ever sits: a position under
 * water puts the stop further below the market still, so a warning derived from
 * this never over-reports. Null when no exchange-side stop rests, or when the
 * fraction is outside the range the sell gate itself honours.
 */
export const ttStopBandSettings = (config: TTConfig): ProtectiveStopBandSettings | null => {
  const sell = config.sell;
  const ps = sell?.protectiveStop;
  if (ps?.enabled !== true) return null;
  const stopPct = decOrNull(sell.stopLossPercentage);
  // A fraction at or above 1 stops at or above entry, which is not a loss-side
  // stop; the sell gate reads it as unset and so must this.
  if (stopPct === null || stopPct.lte(0) || stopPct.gte(1)) return null;
  const limitOffsetPct = decOrNull(ps.limitOffsetPercentage ?? DEFAULT_LIMIT_OFFSET);
  if (limitOffsetPct === null || limitOffsetPct.lte(0)) return null;
  return {
    stopDistancePct: new Decimal(1).minus(stopPct),
    limitOffsetPct,
    onBandBlock: ps.onBandBlock ?? 'notify',
    path: ['sell', 'stopLossPercentage'],
  };
};
