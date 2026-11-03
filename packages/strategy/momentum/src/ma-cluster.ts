import { Decimal } from '@app/money';
import { sma } from '@app/indicators';
import type { Candle } from '@app/strategy-core';

import { coerceDec } from './config-coerce.js';

/** Moving-average periods the cluster is built from. Fixed because the research only held up with the 200-candle line in the set (20/50/100 alone lost money), and an untested knob is a way to overfit live. */
export const MA_CLUSTER_PERIODS = [20, 50, 100, 200] as const;

const LONGEST = MA_CLUSTER_PERIODS[MA_CLUSTER_PERIODS.length - 1]!;

/** ATR period behind the volatility gate. Fixed at the 14 the research used, like the choppiness period. */
export const MA_CLUSTER_ATR_PERIOD = 14;

/** Candles the judged ATR is ranked against: 480 is 20 days of 1h candles. Fixed because 240, 480 and 960 all held in the research, so the knob would only invite fitting. */
export const MA_CLUSTER_ATR_LOOKBACK = 480;

/**
 * Candles the trigger reads: the longest average on the judged candle and again on the candle before it, so the cross can be told from a close that was already above. With the volatility gate on it also needs an ATR on each of the {@link MA_CLUSTER_ATR_LOOKBACK} candles before the judged one, and the first ATR needs `period + 1` candles.
 *
 * @param raw - The unparsed `maCluster` config block; `maxAtrPercentile` and `confirmBreak` change the answer, the second by one candle because the break is judged on the candle before.
 * @returns The window length the trigger needs before it can judge a candle.
 */
export const maClusterNeed = (raw?: unknown): number =>
  (maClusterMaxAtrPercentile(raw) === null
    ? LONGEST + 1
    : MA_CLUSTER_ATR_PERIOD + MA_CLUSTER_ATR_LOOKBACK + 1) + (maClusterConfirmBreak(raw) ? 1 : 0);

/**
 * Whether a break must hold for one more closed candle before it is bought. Only a literal `true` turns it on, so an absent leaf on an older config keeps buying on the break candle.
 *
 * @param raw - The unparsed `maCluster` config block.
 * @returns True when the buy waits for the candle after the break to close above the cluster top as well.
 */
export const maClusterConfirmBreak = (raw: unknown): boolean =>
  (raw as { confirmBreak?: unknown } | undefined)?.confirmBreak === true;

/**
 * The widest spread between the averages that still counts as a cluster. Live config is unparsed, so the leaf is coerced.
 *
 * @param raw - The unparsed `maCluster` config block; an absent or malformed leaf falls back to the researched 1%.
 * @returns The spread limit as a fraction of the judged close.
 */
export const maClusterMaxSpread = (raw: unknown): Decimal =>
  coerceDec((raw as { maxSpread?: unknown } | undefined)?.maxSpread, { fallback: '0.01' });

/** Candles the choppiness reading spans. Fixed like the cluster periods: 14 is the period the research tested, and 24 and 48 gave the same verdict. */
export const MA_CLUSTER_CHOP_PERIOD = 14;

/**
 * The choppiness ceiling for a cluster break, or null when the gate is off. The schema stores off as an empty string; any leaf that is not a number in (0, 100] also reads as off, matching a config that never set it.
 *
 * @param raw - The unparsed `maCluster` config block.
 * @returns The ceiling on the Choppiness Index (0 to 100), or null when no ceiling applies.
 */
export const maClusterMaxChoppiness = (raw: unknown): Decimal | null => {
  // An absent, null or empty leaf stringifies to something Decimal refuses, so the catch is the off path.
  try {
    const d = new Decimal(String((raw as { maxChoppiness?: unknown } | undefined)?.maxChoppiness));
    return d.gt(0) && d.lte(100) ? d : null;
  } catch {
    return null;
  }
};

/**
 * Choppiness Index over the last {@link MA_CLUSTER_CHOP_PERIOD} candles: the summed true ranges against the net high-to-low range, on a log scale from 0 to 100. Near 100 means the candles kept reversing inside a narrow band; low means they travelled in one direction. A window with no range at all reads as 100, the choppiest value, since nothing has moved.
 *
 * @param candles - Closed candles, oldest first, at least one longer than the period so the first true range has a previous close.
 * @returns The index on the candle being judged.
 */
export const choppiness = (candles: readonly Candle[]): Decimal => {
  const n = MA_CLUSTER_CHOP_PERIOD;
  const w = candles.slice(-(n + 1));
  let sumTr = new Decimal(0);
  let hi = new Decimal(w[1]!.high);
  let lo = new Decimal(w[1]!.low);
  for (let i = 1; i < w.length; i++) {
    const h = new Decimal(w[i]!.high);
    const l = new Decimal(w[i]!.low);
    const pc = new Decimal(w[i - 1]!.close);
    sumTr = sumTr.plus(Decimal.max(h.minus(l), h.minus(pc).abs(), l.minus(pc).abs()));
    hi = Decimal.max(hi, h);
    lo = Decimal.min(lo, l);
  }
  const range = hi.minus(lo);
  if (range.lte(0)) return new Decimal(100);
  return sumTr.div(range).log(10).div(new Decimal(n).log(10)).times(100);
};

/**
 * The highest ATR percentile a cluster break may be bought at, or null when the gate is off. Empty, absent or anything outside (0, 1] reads as off, like `maxChoppiness`.
 *
 * @param raw - The unparsed `maCluster` config block.
 * @returns The ceiling as a fraction (0.4 means the judged ATR must sit in the calmest 40% of the lookback), or null.
 */
export const maClusterMaxAtrPercentile = (raw: unknown): Decimal | null => {
  // An absent, null or empty leaf stringifies to something Decimal refuses, so the catch is the off path.
  try {
    const d = new Decimal(
      String((raw as { maxAtrPercentile?: unknown } | undefined)?.maxAtrPercentile),
    );
    return d.gt(0) && d.lte(1) ? d : null;
  } catch {
    return null;
  }
};

/**
 * Where the judged candle's volatility sits against the recent past: the share of the previous {@link MA_CLUSTER_ATR_LOOKBACK} candles whose ATR as a fraction of their close was below the judged candle's. 0 means calmer than all of them, 1 means more volatile than all of them. ATR is Wilder's, built in one pass over the window (the same seed and smoothing as `atr` in `@app/indicators`), because calling that per candle would cost a full pass each time.
 *
 * @param candles - Closed candles, oldest first, ending with the judged one; at least `period + lookback + 1` long.
 * @returns The percentile as a fraction in [0, 1].
 */
export const atrPercentile = (candles: readonly Candle[]): Decimal => {
  const n = MA_CLUSTER_ATR_PERIOD;
  const w = candles.slice(-(n + MA_CLUSTER_ATR_LOOKBACK + 1));
  const tr = (i: number): Decimal => {
    const h = new Decimal(w[i]!.high);
    const l = new Decimal(w[i]!.low);
    const pc = new Decimal(w[i - 1]!.close);
    return Decimal.max(h.minus(l), h.minus(pc).abs(), l.minus(pc).abs());
  };
  let acc = new Decimal(0);
  for (let i = 1; i <= n; i++) acc = acc.plus(tr(i));
  let value = acc.div(n);
  // ATR as a fraction of the close, so a coin that halved in price is not read as calmer.
  const rel: Decimal[] = [value.div(w[n]!.close)];
  for (let i = n + 1; i < w.length; i++) {
    value = value
      .times(n - 1)
      .plus(tr(i))
      .div(n);
    rel.push(value.div(w[i]!.close));
  }
  const judged = rel[rel.length - 1]!;
  const below = rel.slice(0, -1).filter((x) => x.lt(judged)).length;
  return new Decimal(below).div(rel.length - 1);
};

/** What the trigger measured on the last closed candle, for the tick trace. */
export interface MaClusterReading {
  readonly fired: boolean;
  /** The close broke above bunched averages but the choppiness gate refused it. */
  readonly choppy: boolean;
  /** The close broke above bunched averages but volatility sat above `maxAtrPercentile`. */
  readonly volatile: boolean;
  /** With `confirmBreak` on: this candle broke out and passed every gate, so the buy waits for the next close to stay above the cluster top. */
  readonly unconfirmed: boolean;
  /** ATR percentile on the judged candle, or null while the gate is off; see {@link atrPercentile}. */
  readonly atrPercentile: Decimal | null;
  /** Choppiness Index on the judged candle; see {@link choppiness}. */
  readonly choppiness: Decimal;
  /** The highest of the averages on the judged candle: the level the close must clear. */
  readonly top: Decimal;
  /** Highest minus lowest average over the judged close; the averages count as bunched together when this is under `maxSpread`. */
  readonly spread: Decimal;
  /** The spread is under `maxSpread`, so a cross above the top would count. */
  readonly bunched: boolean;
}

const averages = (candles: readonly Candle[]): Decimal[] =>
  MA_CLUSTER_PERIODS.map((p) => sma(candles, p));

/**
 * MA cluster: the 20, 50, 100 and 200 candle averages sit within `maxSpread` of each other (price has gone flat long enough for every horizon to agree), and the last closed candle crosses from at or below the highest of them to above it. It fires only on the crossing candle, so a close that stays above does not re-buy. In the 2025-26 1h research on the five majors this entry with a 4 ATR trail was positive in both six-month halves on every nearby setting and in 2024, but it did not replicate on nine pre-chosen large caps, so treat it as a majors rule. With `maxChoppiness` set, a break is also refused while the Choppiness Index is at or above it: on the majors a ceiling of 50 cut the Aug-Oct 2026 losing breaks from 25 to 16 and raised profit at 2.5x costs in every window from 90 days to a year. With `maxAtrPercentile` set, a break is also refused while volatility sits above that share of the last 20 days: on the majors breaks out of a calm market held better than breaks during a volatile one. With `confirmBreak` on, a break that passed every gate is bought one candle later, and only if that candle also closes above the cluster top: on the majors this skipped breaks that fell straight back into the cluster and made more after 2.5x costs in every window from 60 days to 18 months, while two confirming candles made less.
 *
 * @param candles - Closed candles on the strategy interval, oldest first, ending with the candle being judged.
 * @param raw - The unparsed `maCluster` config block.
 * @returns The reading, or null while the window is shorter than {@link maClusterNeed}, which reads as no signal.
 */
export const maClusterReading = (
  candles: readonly Candle[],
  raw: unknown,
): MaClusterReading | null => {
  if (candles.length < maClusterNeed(raw)) return null;
  const now = breakReading(candles, raw);
  if (!maClusterConfirmBreak(raw)) return { ...now, unconfirmed: false };
  // The candle before was a qualifying break, so this one buys if it still closes above the top. Stateless, so a restart between the two candles changes nothing.
  const prev = breakReading(candles.slice(0, -1), raw);
  const close = new Decimal(candles[candles.length - 1]!.close);
  return { ...now, fired: prev.fired && close.gt(now.top), unconfirmed: now.fired };
};

/**
 * The cluster break judged on the last candle alone, before any confirmation; the caller has checked the window length.
 *
 * @param candles - Closed candles, oldest first, ending with the candle being judged; must be at least {@link maClusterNeed} long minus any confirmation candle.
 * @param raw - The unparsed `maCluster` config block.
 * @returns The reading for that candle, with `fired` meaning the break passed every gate on its own.
 */
const breakReading = (
  candles: readonly Candle[],
  raw: unknown,
): Omit<MaClusterReading, 'unconfirmed'> => {
  const close = new Decimal(candles[candles.length - 1]!.close);
  const now = averages(candles);
  const top = Decimal.max(...now);
  const spread = top.minus(Decimal.min(...now)).div(close);
  const prior = candles.slice(0, -1);
  const prevTop = Decimal.max(...averages(prior));
  const prevClose = new Decimal(prior[prior.length - 1]!.close);
  const bunched = spread.lt(maClusterMaxSpread(raw));
  const broke = close.gt(top) && prevClose.lte(prevTop) && bunched;
  const chop = choppiness(candles);
  const ceiling = maClusterMaxChoppiness(raw);
  const choppy = broke && ceiling !== null && chop.gte(ceiling);
  const atrCeiling = maClusterMaxAtrPercentile(raw);
  let pct: Decimal | null = null;
  let volatile = false;
  if (atrCeiling !== null) {
    pct = atrPercentile(candles);
    volatile = broke && pct.gt(atrCeiling);
  }
  return {
    fired: broke && !choppy && !volatile,
    choppy,
    volatile,
    atrPercentile: pct,
    choppiness: chop,
    top,
    spread,
    bunched,
  };
};
