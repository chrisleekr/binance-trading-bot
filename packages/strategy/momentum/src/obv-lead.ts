import { Decimal } from '@app/money';
import type { Candle } from '@app/strategy-core';

import { coerceDec, coerceInt } from './config-coerce.js';
import { choppiness, MA_CLUSTER_CHOP_PERIOD } from './ma-cluster.js';

/**
 * The obvLead block's leaves with the defaults the research selected. Live config is unparsed, so every leaf is coerced.
 *
 * @param raw - The unparsed `obvLead` config block; absent or malformed leaves fall back to the researched defaults.
 * @returns The candle range OBV and price are compared over, and the choppiness ceiling.
 */
export const obvLeadSettings = (raw: unknown): { lookback: number; maxChoppiness: Decimal } => {
  const c = (raw ?? {}) as { lookback?: unknown; maxChoppiness?: unknown };
  return {
    lookback: coerceInt(c.lookback, { min: MA_CLUSTER_CHOP_PERIOD, fallback: 168 }),
    maxChoppiness: coerceDec(c.maxChoppiness, { fallback: '50' }),
  };
};

/**
 * Candles the trigger reads: the judged candle plus the `lookback` before it. OBV highs only depend on volume differences inside that range, so no earlier history is needed; the choppiness window fits inside because `lookback` is at least its period.
 *
 * @param raw - The unparsed `obvLead` config block.
 * @returns The window length the trigger needs before it can judge a candle.
 */
export const obvLeadNeed = (raw: unknown): number => obvLeadSettings(raw).lookback + 1;

/** What the trigger measured on the last closed candle, for the tick trace. */
export interface ObvLeadReading {
  readonly fired: boolean;
  /** On-balance volume above its highest value of the prior `lookback` candles: buying volume has made a new high. */
  readonly obvNewHigh: boolean;
  /** How far the close must still rise to reach the prior `lookback` candles' highest close, as a fraction; zero or negative means price has already made the new high, so OBV is no longer leading. */
  readonly priceToHigh: Decimal;
  /** Choppiness Index on the judged candle. */
  readonly choppiness: Decimal;
}

/**
 * OBV lead: on-balance volume (a running total that adds a candle's volume when it closes up and subtracts it when it closes down) makes a new `lookback` high while the close is still under its own `lookback` high, and the Choppiness Index is under `maxChoppiness`. Read as buyers accumulating before price breaks out. In the 2025-26 1h research, with a 3 ATR trail, it made money over the last 90 days and the April-October 2026 half after 2.5x costs on both the majors and nine pre-chosen large caps, beating random entries, but lost from October 2025 to April 2026, so it is meant for a small probation profile, not the main one.
 *
 * @param candles - Closed candles on the strategy interval, oldest first, ending with the candle being judged.
 * @param raw - The unparsed `obvLead` config block.
 * @returns The reading, or null while the window is shorter than {@link obvLeadNeed}.
 */
export const obvLeadReading = (candles: readonly Candle[], raw: unknown): ObvLeadReading | null => {
  const s = obvLeadSettings(raw);
  if (candles.length < s.lookback + 1) return null;
  const w = candles.slice(-(s.lookback + 1));
  // OBV relative to the first candle of the range; index n is the judged candle, 0..n-1 the prior range.
  const n = w.length - 1;
  const obv: Decimal[] = [new Decimal(0)];
  for (let i = 1; i <= n; i++) {
    const c = new Decimal(w[i]!.close);
    const p = new Decimal(w[i - 1]!.close);
    const v = new Decimal(w[i]!.volume);
    obv.push(c.gt(p) ? obv[i - 1]!.plus(v) : c.lt(p) ? obv[i - 1]!.minus(v) : obv[i - 1]!);
  }
  const priorObvHigh = Decimal.max(...obv.slice(0, n));
  const priorCloseHigh = Decimal.max(...w.slice(0, n).map((x) => x.close));
  const close = new Decimal(w[w.length - 1]!.close);
  const obvNewHigh = obv[n]!.gt(priorObvHigh);
  const priceToHigh = priorCloseHigh.div(close).minus(1);
  const chop = choppiness(candles);
  return {
    fired: obvNewHigh && priceToHigh.gt(0) && chop.lt(s.maxChoppiness),
    obvNewHigh,
    priceToHigh,
    choppiness: chop,
  };
};
