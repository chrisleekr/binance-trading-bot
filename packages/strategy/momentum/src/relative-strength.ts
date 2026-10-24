import { Decimal } from '@app/money';
import type { Candle, Decision } from '@app/strategy-core';

import { coerceInt } from './config-coerce.js';

/** Profile KV key prefix each symbol publishes its score under, followed by the symbol. Namespaced so another strategy's keys on the same profile never collide. */
export const RELATIVE_STRENGTH_KV_PREFIX = 'momentum:relative-strength:';

/** Floor under the standard deviation, so a perfectly steady riser scores far above every noisy coin instead of dividing by zero. */
const SD_FLOOR = new Decimal('1e-12');

/**
 * The relativeStrength block's leaves. Live config is unparsed, so every leaf is coerced.
 *
 * @param raw - The unparsed `relativeStrength` config block; absent or malformed leaves fall back to the researched defaults.
 * @returns Whether the gate is on, how many candles of returns the score reads, and how many of the profile's symbols may buy at once by rank.
 */
export const relativeStrengthSettings = (
  raw: unknown,
): { enabled: boolean; lookbackBars: number; topK: number } => {
  const c = (raw ?? {}) as { enabled?: unknown; lookbackBars?: unknown; topK?: unknown };
  return {
    enabled: c.enabled === true,
    lookbackBars: coerceInt(c.lookbackBars, { min: 2, fallback: 720 }),
    topK: coerceInt(c.topK, { min: 1, fallback: 3 }),
  };
};

/**
 * Candles the score reads: `lookbackBars` returns need one more close than that.
 *
 * @param raw - The unparsed `relativeStrength` config block.
 * @returns The window length the gate needs, or 0 when the gate is off and reads nothing.
 */
export const relativeStrengthNeed = (raw: unknown): number => {
  const s = relativeStrengthSettings(raw);
  return s.enabled ? s.lookbackBars + 1 : 0;
};

/**
 * Risk-adjusted trend of one coin: the mean of its last `lookbackBars` candle-to-candle returns divided by their standard deviation (a Sharpe ratio without the risk-free rate). Comparable across coins of different volatility, which raw return is not.
 *
 * @param candles - Closed candles on the strategy interval, oldest first.
 * @param lookbackBars - How many returns the score averages.
 * @returns The score (0 for a flat price), or null while the window is shorter than `lookbackBars + 1` or holds a non-positive close.
 */
export const relativeStrengthScore = (
  candles: readonly Candle[],
  lookbackBars: number,
): Decimal | null => {
  if (candles.length < lookbackBars + 1) return null;
  const returns: Decimal[] = [];
  for (let i = candles.length - lookbackBars; i < candles.length; i++) {
    const prev = new Decimal(candles[i - 1]!.close);
    if (!prev.gt(0)) return null;
    returns.push(new Decimal(candles[i]!.close).div(prev).minus(1));
  }
  const mean = Decimal.sum(...returns).div(lookbackBars);
  const variance = Decimal.sum(...returns.map((r) => r.minus(mean).pow(2))).div(lookbackBars);
  const sd = variance.sqrt();
  return mean.div(sd.gt(SD_FLOOR) ? sd : SD_FLOOR);
};

/** What one symbol publishes: its score as a decimal string, stamped with the close time of the candle and the lookback it was computed with. Scores over different lookbacks are not comparable, so the lookback is part of the score's identity. */
interface Published {
  readonly score: Decimal;
  readonly candleCloseMs: number;
  readonly lookbackBars: number;
}

/** Revive one KV value, or null when it is not a well-formed published score (KV values come back as plain JSON). */
const readPublished = (value: unknown): Published | null => {
  const v = value as { score?: unknown; candleCloseMs?: unknown; lookbackBars?: unknown } | null;
  if (
    typeof v?.score !== 'string' ||
    typeof v.candleCloseMs !== 'number' ||
    typeof v.lookbackBars !== 'number'
  )
    return null;
  try {
    const score = new Decimal(v.score);
    return score.isFinite()
      ? { score, candleCloseMs: v.candleCloseMs, lookbackBars: v.lookbackBars }
      : null;
  } catch {
    return null;
  }
};

/**
 * The KV write that keeps this symbol's published score current, made once per closed candle: a tick on a candle whose score is already published under the same lookback neither rescores nor writes, so the per-second ticks between closes cost no Decimal pass and no store write. A lookback change re-publishes on the next tick. A window too short to score drops a previously published value, so siblings never rank a stale one.
 *
 * @param candles - Closed candles on the strategy interval, oldest first.
 * @param raw - The unparsed `relativeStrength` config block.
 * @param symbol - The symbol this tick is for; its own KV key.
 * @param profileKv - The profile's merged KV snapshot, absent when the worker did not load it.
 * @returns A `set-kv` or `delete-kv` decision, or null when the gate is off or nothing changed.
 */
export const relativeStrengthPublish = (
  candles: readonly Candle[],
  raw: unknown,
  symbol: string,
  profileKv: Readonly<Record<string, unknown>> | undefined,
): Decision | null => {
  const s = relativeStrengthSettings(raw);
  const last = candles.at(-1);
  if (!s.enabled || last === undefined) return null;
  const key = `${RELATIVE_STRENGTH_KV_PREFIX}${symbol}`;
  const current = profileKv?.[key];
  const published = readPublished(current);
  // Same closed candles and lookback scored before, so the score is unchanged; the length check covers a window that shrank since.
  if (
    published?.candleCloseMs === last.closeTimeMs &&
    published.lookbackBars === s.lookbackBars &&
    candles.length >= s.lookbackBars + 1
  )
    return null;
  const score = relativeStrengthScore(candles, s.lookbackBars);
  if (score === null) return current === undefined ? null : { type: 'delete-kv', key };
  return {
    type: 'set-kv',
    key,
    value: {
      score: score.toFixed(),
      candleCloseMs: last.closeTimeMs,
      lookbackBars: s.lookbackBars,
    },
  };
};

/** The gate's answer for one entry, with the numbers the tick trace logs. */
export interface RelativeStrengthReading {
  readonly gate: 'pass' | 'relative-strength' | 'relative-strength-insufficient-history';
  /** This symbol's score, null while the window is too short. */
  readonly score: Decimal | null;
  /** 0 is the strongest; the count of current siblings scoring strictly higher. */
  readonly rank: number;
  /** Current siblings counted in the ranking, excluding this symbol. */
  readonly siblings: number;
}

/**
 * Relative-strength entry gate: allow a buy only while this coin is among the `topK` strongest of the profile's symbols by {@link relativeStrengthScore}, so a profile trading many coins spends its slots on the ones trending best. Siblings rank by the scores they published to the profile KV store; a sibling whose score is more than one candle older than this symbol's last close is skipped, so a disabled or removed symbol stops counting, and so is one scored over a different lookback, since its score is not comparable. Ties do not count against this symbol. Siblings that have not published yet do not count either, so a newly started profile is permissive until they do. Fail-closed on this symbol's own score: a window too short to score refuses the entry. In the 2025-26 1h research, gating the dual breakout (main 400-candle breakout above SMA400 plus the 120-candle below-trend layer) to the top 3 of nine pre-chosen large caps by 720-candle Sharpe made money in both six-month halves, which the ungated rule did not.
 *
 * @param candles - Closed candles on the strategy interval, oldest first.
 * @param raw - The unparsed `relativeStrength` config block.
 * @param symbol - The symbol this tick is for, excluded from its own siblings.
 * @param profileKv - The profile's merged KV snapshot; absent reads as no siblings.
 * @returns The gate verdict with the score, rank and sibling count; `pass` with rank 0 when the gate is off.
 */
export const relativeStrengthGate = (
  candles: readonly Candle[],
  raw: unknown,
  symbol: string,
  profileKv: Readonly<Record<string, unknown>> | undefined,
): RelativeStrengthReading => {
  const s = relativeStrengthSettings(raw);
  if (!s.enabled) return { gate: 'pass', score: null, rank: 0, siblings: 0 };
  const score = relativeStrengthScore(candles, s.lookbackBars);
  if (score === null)
    return { gate: 'relative-strength-insufficient-history', score: null, rank: 0, siblings: 0 };
  // One candle of slack: at a candle close the siblings that have not ticked yet still carry the previous candle's score. A score implies at least lookbackBars + 1 >= 3 candles, so the previous one exists.
  const oldest = candles[candles.length - 2]!.closeTimeMs;
  let rank = 0;
  let siblings = 0;
  for (const [key, value] of Object.entries(profileKv ?? {})) {
    if (!key.startsWith(RELATIVE_STRENGTH_KV_PREFIX)) continue;
    if (key.slice(RELATIVE_STRENGTH_KV_PREFIX.length) === symbol) continue;
    const sib = readPublished(value);
    if (sib === null || sib.candleCloseMs < oldest || sib.lookbackBars !== s.lookbackBars) continue;
    siblings++;
    if (sib.score.gt(score)) rank++;
  }
  return { gate: rank < s.topK ? 'pass' : 'relative-strength', score, rank, siblings };
};
