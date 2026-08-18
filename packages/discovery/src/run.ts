import type { Candle } from '@app/strategy-core';
import { pearsonCorrelation } from '@app/indicators';
import Decimal from 'decimal.js';
import {
  heldLongEnough,
  inCooldown,
  isActive,
  matchesQuote,
  meetsLiquidity,
  notBlacklisted,
  oldEnough,
  passesAssetPolicy,
  trendConfirmed,
  withinChangeBand,
  withinSpread,
} from './filters.js';
import type {
  CurrentAutoSymbol,
  DiscoveryConfig,
  DiscoveryDiff,
  DiscoveryInput,
  DiscoverySkipReason,
  DiscoveryTicker,
  RankContext,
} from './types.js';

/** Sort tickers by 24h gain descending, ties broken by symbol for determinism. */
const byGainDesc = (a: DiscoveryTicker, b: DiscoveryTicker): number => {
  const byGain = new Decimal(b.priceChangePercent).cmp(new Decimal(a.priceChangePercent));
  return byGain !== 0 ? byGain : a.symbol.localeCompare(b.symbol);
};

/**
 * Rank every symbol of the quote universe by 24h change, 1 = biggest gainer.
 * The universe is the quote-matched set — the same one {@link marketBreadthOk}
 * measures — deliberately NOT the post-filter survivors: ranking against
 * survivors would make the change band depend on the volume and spread floors,
 * re-coupling knobs the split was meant to separate.
 */
export const buildRankContext = (
  tickers: readonly DiscoveryTicker[],
  cfg: DiscoveryConfig,
): RankContext => {
  const universe = tickers.filter((t) => matchesQuote(t, cfg)).sort(byGainDesc);
  const rankBySymbol = new Map(universe.map((t, i) => [t.symbol, i + 1]));
  return { rankBySymbol, universeSize: universe.length };
};

/** The ticker-stage filter names (stages 1-7), in evaluation order. */
export type TickerStageName =
  'quote' | 'assetPolicy' | 'blacklist' | 'liquidity' | 'activity' | 'spread' | 'changeBand';

/**
 * The ordered ticker-stage chain (stages 1-7) — the single source of truth for both the stage set AND its evaluation order. `shortlistByTicker`, {@link tickerStageCounts}, `funnel.ts`'s stage list, and `explain.ts`'s per-candidate `evalFilters` all walk this one list, so the shortlist, the funnel's ticker segment, and the explain breakdown cannot drift on which filters run or in what order.
 */
export const TICKER_STAGE_CHAIN: readonly [
  TickerStageName,
  (t: DiscoveryTicker, cfg: DiscoveryConfig, ctx: RankContext) => boolean,
][] = [
  ['quote', matchesQuote],
  // Before the blocklist and before every tunable floor: the asset policy is the one cut no setting can relax, so a pegged asset must never be reported as dying at a filter the operator could widen.
  ['assetPolicy', passesAssetPolicy],
  ['blacklist', notBlacklisted],
  ['liquidity', meetsLiquidity],
  ['activity', isActive],
  ['spread', withinSpread],
  ['changeBand', withinChangeBand],
];

/**
 * Generator + ticker-stage filters (1-7): keep the tickers that pass quote-match,
 * asset policy, blacklist, liquidity, activity, spread, and the change band, then rank them by
 * 24h gain (descending; ties broken by symbol for determinism). Returns the
 * ranked symbol list. This is the cheap, kline-free prefix the Slice-3 cron runs
 * first so it only fetches klines for the shortlist.
 */
export const shortlistByTicker = (
  tickers: readonly DiscoveryTicker[],
  cfg: DiscoveryConfig,
): string[] => {
  const ctx = buildRankContext(tickers, cfg);
  const survivors = tickers.filter((t) => TICKER_STAGE_CHAIN.every(([, fn]) => fn(t, cfg, ctx)));
  return [...survivors].sort(byGainDesc).map((t) => t.symbol);
};

/**
 * Survivor counts at each ticker stage, computed over the FULL quote-matched
 * ticker set (NOT the ~few kline candidates). `universe` is every ticker the
 * cron saw this cycle; each subsequent field is how many remain AFTER that stage
 * ran, so the vector is monotone non-increasing and `changeBand` equals
 * `shortlistByTicker(tickers, cfg).length`. This is the funnel's ticker segment
 * (issue #636): it answers "how much of the whole exchange did each filter cut"
 * rather than "how many of the handful of candidates survived".
 */
export interface TickerStageCounts {
  readonly universe: number;
  readonly quote: number;
  readonly assetPolicy: number;
  readonly blacklist: number;
  readonly liquidity: number;
  readonly activity: number;
  readonly spread: number;
  readonly changeBand: number;
}

/**
 * One pass over the full ticker set, tallying survivors after each ticker stage.
 * Reuses {@link TICKER_STAGE_CHAIN} (the same predicates and order as the
 * shortlist), short-circuiting at a ticker's first failure exactly as the chain
 * does. Pure: reads only the injected tickers + config.
 */
export const tickerStageCounts = (
  tickers: readonly DiscoveryTicker[],
  cfg: DiscoveryConfig,
): TickerStageCounts => {
  const ctx = buildRankContext(tickers, cfg);
  const counts = {
    universe: tickers.length,
    quote: 0,
    assetPolicy: 0,
    blacklist: 0,
    liquidity: 0,
    activity: 0,
    spread: 0,
    changeBand: 0,
  };
  for (const t of tickers) {
    for (const [name, fn] of TICKER_STAGE_CHAIN) {
      if (!fn(t, cfg, ctx)) break;
      counts[name] += 1;
    }
  }
  return counts;
};

/**
 * Market-breadth gate, evaluated once per cycle before the add-set. Breadth =
 * the percent of the quote universe (symbols quoted in `cfg.quoteAsset`) with a
 * positive 24h change. Returns true (adds allowed) when breadth is at or above
 * the configured floor. A single coin's 1h trend can be a dead-cat bounce while
 * the broad tape bleeds, so when breadth is risk-off this short-circuits NEW
 * adds; existing holds still follow min-hold/reap.
 *
 * Off when the floor is <= 0 (the default '0', so existing configs and the
 * golden replay are unchanged). An empty universe is not blocked: there is
 * nothing to add anyway, and 0/0 percent is undefined.
 */
export const marketBreadthOk = (
  tickers: readonly DiscoveryTicker[],
  cfg: DiscoveryConfig,
): boolean => {
  const min = new Decimal(cfg.marketBreadthMinPercent);
  if (min.lte(0)) return true;
  const universe = tickers.filter((t) => matchesQuote(t, cfg));
  if (universe.length === 0) return true;
  const positive = universe.filter((t) => new Decimal(t.priceChangePercent).gt(0)).length;
  const pct = new Decimal(positive).div(universe.length).mul(100);
  return pct.gte(min);
};

/**
 * Index-aligned return pair for two candle windows, or null when they cannot be
 * compared (different length, a mismatched candle period, or fewer than two
 * usable returns). Returns are built PAIRWISE so element `i` of both arrays is
 * the same candle pair: the windows are co-fetched at the same interval so they
 * align by index, the close-time equality check enforces it, and a zero prior
 * close (degenerate/garbage candle) drops that step from BOTH series at once —
 * never from one independently, which would silently misalign the periods.
 */
const alignedReturns = (
  a: readonly Candle[],
  b: readonly Candle[],
): { readonly a: Decimal[]; readonly b: Decimal[] } | null => {
  if (a.length !== b.length) return null;
  const ra: Decimal[] = [];
  const rb: Decimal[] = [];
  for (let i = 1; i < a.length; i++) {
    const ca = a[i] as Candle;
    const cb = b[i] as Candle;
    // Same candle period in both, or the windows are not aligned — bail.
    if (ca.closeTimeMs !== cb.closeTimeMs) return null;
    const aPrev = new Decimal((a[i - 1] as Candle).close);
    const bPrev = new Decimal((b[i - 1] as Candle).close);
    if (aPrev.isZero() || bPrev.isZero()) continue;
    ra.push(new Decimal(ca.close).dividedBy(aPrev).minus(1));
    rb.push(new Decimal(cb.close).dividedBy(bPrev).minus(1));
  }
  return ra.length < 2 ? null : { a: ra, b: rb };
};

/**
 * Highest POSITIVE return-correlation of `candidate` against any of `peers`,
 * over the last `lookback` candles, or null when no peer has >= 2 aligned
 * returns to compare (fail-open: a thin, absent, or misaligned window never
 * vetoes an add). Negative correlation diversifies, so it is not a reason to
 * veto — only the positive max matters. Pure: reads only the injected windows.
 */
export const maxPeerCorrelation = (
  candidate: string,
  peers: readonly string[],
  klinesBySymbol: Readonly<Record<string, readonly Candle[]>>,
  lookback: number,
): Decimal | null => {
  const candWindow = (klinesBySymbol[candidate] ?? []).slice(-lookback);
  if (candWindow.length < 2) return null;
  let best: Decimal | null = null;
  for (const peer of peers) {
    const aligned = alignedReturns(candWindow, (klinesBySymbol[peer] ?? []).slice(-lookback));
    if (aligned === null) continue;
    const corr = pearsonCorrelation(aligned.a, aligned.b);
    if (corr === null) continue;
    if (best === null || corr.gt(best)) best = corr;
  }
  return best;
};

/**
 * Kline-stage filters (8-9) + the diff. Given the ranked ticker shortlist and
 * the per-symbol kline windows, applies age + trend-confirm to get the eligible
 * set, then resolves the desired auto-set against the current one under the slot
 * cap, the re-add cooldown, and the min-hold-before-reap rule.
 *
 * Rules:
 * - A current auto symbol that still qualifies KEEPS its slot (no churn), even
 *   if that pushes the live set over a since-lowered `maxAutoSymbols` — we never
 *   force-evict a still-good symbol; the cap only bounds NEW adds.
 * - A faded current symbol within its min-hold stays (not removed yet) and keeps
 *   occupying a slot; past min-hold it is proposed for removal.
 * - New adds fill the remaining slots in rank order, skipping symbols on the
 *   flatten cooldown.
 */
export const resolveDiscovery = (
  shortlist: readonly string[],
  klinesBySymbol: Readonly<Record<string, readonly Candle[]>>,
  currentAuto: readonly CurrentAutoSymbol[],
  lastFlattenAtMsBySymbol: Readonly<Record<string, number>>,
  cfg: DiscoveryConfig,
  nowMs: number,
  manualMembers: readonly string[] = [],
  // When false (breadth risk-off), propose NO new adds this cycle; `remove` and
  // the kept-survivor `desired` set are unaffected. Defaults true so every
  // existing caller stays byte-identical.
  allowAdds = true,
  // Optional out-param: when supplied, the add-loop records why each eligible
  // candidate it did not add was skipped (cooldown / slot-capped). The explain
  // layer passes one instead of replaying this loop. The `add`/`remove`/`desired`
  // result is identical whether or not it is supplied.
  skipReasons?: Map<string, DiscoverySkipReason>,
): DiscoveryDiff => {
  const eligible = shortlist.filter((symbol) => {
    const klines = klinesBySymbol[symbol] ?? [];
    return oldEnough(klines, cfg, nowMs) && trendConfirmed(klines, cfg);
  });
  const eligibleSet = new Set(eligible);
  const currentSet = new Set(currentAuto.map((c) => c.symbol));
  // Pinned (manual) symbols are off-limits: never re-adopted to auto. They are
  // not in `currentAuto`, so they never reach the slot-cap or reap math — only
  // the add loop below needs to skip them.
  const manualSet = new Set(manualMembers);

  // Faded current symbols (no longer eligible) split by min-hold: those still
  // within it stay and hold their slot; those past it are reaped.
  const faded = currentAuto.filter((c) => !eligibleSet.has(c.symbol));
  const protectedFaded = faded.filter((c) => !heldLongEnough(c.addedAtMs, cfg, nowMs));
  const remove = faded.filter((c) => heldLongEnough(c.addedAtMs, cfg, nowMs)).map((c) => c.symbol);

  const keptCount = eligible.filter((s) => currentSet.has(s)).length;
  // No `Math` global in pure code (the RNG ban catches it); clamp by hand.
  // Breadth risk-off zeroes the add budget: no new symbols this cycle.
  const rawSlots = allowAdds ? cfg.maxAutoSymbols - keptCount - protectedFaded.length : 0;
  const availableSlots = rawSlots < 0 ? 0 : rawSlots;

  // Correlation cap (default-off): when armed (`maxPairwise > 0`), a candidate
  // whose returns track an already-desired symbol too closely is skipped so the
  // auto-set is not one beta factor held N times. Inert (and byte-identical)
  // when absent or 0. `keptSurvivors` are the held symbols still eligible.
  const corrMaxRaw = cfg.correlation ? new Decimal(cfg.correlation.maxPairwise) : new Decimal(0);
  const corrCfg = corrMaxRaw.gt(0) && cfg.correlation ? cfg.correlation : null;
  const corrMax = corrCfg ? corrMaxRaw : null;
  const keptSurvivors = corrCfg ? eligible.filter((s) => currentSet.has(s)) : [];

  const add: string[] = [];
  for (const symbol of eligible) {
    // Kept survivors and pinned symbols are not "candidates the cycle declined
    // to add", so they get no skip reason. Order of these two guards before the
    // slot/cooldown checks keeps `add` byte-identical to the prior break-loop.
    if (currentSet.has(symbol)) continue;
    if (manualSet.has(symbol)) continue;
    if (add.length >= availableSlots) {
      skipReasons?.set(symbol, 'slot-capped');
      continue;
    }
    if (inCooldown(lastFlattenAtMsBySymbol[symbol], cfg, nowMs)) {
      skipReasons?.set(symbol, 'cooldown');
      continue;
    }
    if (corrCfg && corrMax) {
      // Compare against the symbols that would be held alongside this add:
      // kept survivors plus the adds already accepted this cycle.
      const corr = maxPeerCorrelation(
        symbol,
        [...keptSurvivors, ...add],
        klinesBySymbol,
        corrCfg.lookbackCandles,
      );
      if (corr !== null && corr.gte(corrMax)) {
        skipReasons?.set(symbol, 'correlation-high');
        continue;
      }
    }
    add.push(symbol);
  }

  const addSet = new Set(add);
  // Desired = kept survivors + new adds, in rank order.
  const desired = eligible.filter((s) => currentSet.has(s) || addSet.has(s));
  return { add, remove, desired };
};

/**
 * Full pure discovery cycle: rank + ticker filters, then kline filters + diff.
 * Deterministic — replaying a fixed ticker + kline snapshot yields the same
 * add/remove diff. No `Date`/`Math.random`/I/O; `nowMs` is injected.
 */
export const runDiscovery = (input: DiscoveryInput): DiscoveryDiff => {
  const shortlist = shortlistByTicker(input.tickers, input.config);
  const allowAdds = marketBreadthOk(input.tickers, input.config);
  return resolveDiscovery(
    shortlist,
    input.klinesBySymbol,
    input.currentAuto,
    input.lastFlattenAtMsBySymbol,
    input.config,
    input.nowMs,
    input.manualMembers ?? [],
    allowAdds,
  );
};
