import { Decimal } from '@app/money';
import type { Candle } from '@app/strategy-core';

import { coerceDec, coerceInt } from './config-coerce.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

// 1970-01-01 was a Thursday, so shifting by three days makes the remainder count from Monday 00:00 UTC.
const msSinceMondayUtc = (openTimeMs: number): number => (openTimeMs + 3 * DAY_MS) % WEEK_MS;

// Sunday 22:00 UTC: the hour CME bitcoin futures reopen.
const SUNDAY_OPEN_OFFSET_MS = 6 * DAY_MS + 22 * HOUR_MS;

// Friday 20:00 UTC, the hour CME closes, is 50 hours before the Sunday candle.
const FRIDAY_LEAD_MS = 50 * HOUR_MS;

// The Friday reference is 50 candles before the Sunday one; two more candles of slack keep it inside the window while the position is held.
const REFERENCE_SPAN = 52;

/**
 * The weekendGap block's leaves with the defaults the research selected. Live config is unparsed, so every leaf is coerced.
 *
 * @param raw - The unparsed `weekendGap` config block; absent or malformed leaves fall back to the researched defaults.
 * @returns The fraction the Sunday close must sit under the Friday close, and how many 1h candles a position may be held.
 */
export const weekendGapSettings = (raw: unknown): { minGap: Decimal; maxHoldBars: number } => {
  const c = (raw ?? {}) as { minGap?: unknown; maxHoldBars?: unknown };
  return {
    minGap: coerceDec(c.minGap, { fallback: '0.01' }),
    maxHoldBars: coerceInt(c.maxHoldBars, { min: 1, fallback: 72 }),
  };
};

/**
 * Candles a held position needs to recompute its Friday close: the hold limit plus the 50 candles back to the reference candle, plus slack.
 *
 * @param raw - The unparsed `weekendGap` config block.
 * @returns The window length the trigger needs.
 */
export const weekendGapNeed = (raw: unknown): number =>
  weekendGapSettings(raw).maxHoldBars + REFERENCE_SPAN;

/** What the trigger measured on the last closed candle, for the tick trace. */
export interface WeekendGapReading {
  /** The last closed candle opened on Sunday 22:00 UTC. */
  readonly isEntryCandle: boolean;
  /** Close of the Friday 20:00 UTC candle; null when that candle is not in the window or this is not the Sunday candle. */
  readonly refClose: string | null;
  /** How far the Sunday close sits under the Friday close, as a percent (positive means under); null when there is no reference. */
  readonly gapPercent: string | null;
  readonly fired: boolean;
}

/**
 * Weekend gap: on 1h candles, the Sunday 22:00 UTC candle closes more than `minGap` under the Friday 20:00 UTC candle's close. Read as the weekend dip that price tends to climb back out of within about three days. In the 2025-26 research on nine pre-chosen large caps it made money in every window while buying on Sundays without the gap lost in every window, but it lost in 2024, so it is meant for a small probation profile. A missing reference candle fails closed.
 *
 * @param candles - Closed candles on the strategy interval, oldest first, ending with the candle being judged.
 * @param cfg - The strategy config; only the interval and the unparsed `weekendGap` block are read.
 * @returns The reading, or null when the interval is not 1h, because the Sunday and Friday hours only exist exactly on 1h candles.
 */
export const weekendGapReading = (
  candles: readonly Candle[],
  cfg: { candleInterval?: unknown; weekendGap?: unknown },
): WeekendGapReading | null => {
  if (cfg.candleInterval !== '1h') return null;
  const last = candles.at(-1);
  if (last === undefined || msSinceMondayUtc(last.openTimeMs) !== SUNDAY_OPEN_OFFSET_MS) {
    return { isEntryCandle: false, refClose: null, gapPercent: null, fired: false };
  }
  const ref = candles.find((c) => c.openTimeMs === last.openTimeMs - FRIDAY_LEAD_MS);
  if (ref === undefined) {
    return { isEntryCandle: true, refClose: null, gapPercent: null, fired: false };
  }
  const refClose = new Decimal(ref.close);
  const close = new Decimal(last.close);
  return {
    isEntryCandle: true,
    refClose: ref.close,
    gapPercent: refClose.minus(close).div(refClose).times(100).toString(),
    fired: close.lt(
      refClose.times(new Decimal(1).minus(weekendGapSettings(cfg.weekendGap).minGap)),
    ),
  };
};

/**
 * Recomputes the take-profit target of a held position: the close of the Friday candle that preceded its Sunday signal candle. Derived from the entry stamp instead of persisted, so no state field is added.
 *
 * @param candles - Closed candles on the strategy interval, oldest first.
 * @param lastEntryCandleMs - Close time of the signal candle, as the entry tick stamps it (open time plus one hour minus one millisecond).
 * @returns The Friday close, or null when that candle has left the window.
 */
export const weekendGapTarget = (
  candles: readonly Candle[],
  lastEntryCandleMs: number,
): Decimal | null => {
  const refOpen = lastEntryCandleMs + 1 - HOUR_MS - FRIDAY_LEAD_MS;
  const ref = candles.find((c) => c.openTimeMs === refOpen);
  return ref === undefined ? null : new Decimal(ref.close);
};
