import { Decimal } from '@app/money';
import { clampStopToExchangeFloor, decOrNull } from '@app/strategy-core';
import type { ProtectiveStopBandSettings, StopBandContext } from '@app/strategy-core';

import type { TTConfig } from './schema.js';

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
