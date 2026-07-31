import Decimal from 'decimal.js';
import { oldEnough, trendConfirmed } from './filters.js';
import {
  buildRankContext,
  marketBreadthOk,
  resolveDiscovery,
  shortlistByTicker,
  TICKER_STAGE_CHAIN,
} from './run.js';
import type {
  DiscoveryConfig,
  DiscoveryDiff,
  DiscoveryInput,
  DiscoverySkipReason,
  DiscoveryTicker,
  RankContext,
} from './types.js';
import type { Candle } from '@app/strategy-core';

/**
 * The filter chain's named stages, in evaluation order. The first six are the
 * ticker-stage filters (no klines); `age` + `trend` are the kline stage. A
 * candidate's `passed` list is this sequence truncated at its first failure.
 */
export type DiscoveryFilterName =
  | 'quote'
  | 'blacklist'
  | 'liquidity'
  | 'activity'
  | 'spread'
  | 'changeBand'
  | 'age'
  | 'trend';

/**
 * A candidate blocked by account-level symbol exclusivity: a sibling profile on
 * the same wallet already trades the base (`sibling-owns-base`) or settles in it
 * (`sibling-quotes-base`). The pure chain never decides this — it is an overlay
 * the cron passes to {@link explainDiscovery} — but it is a terminal disposition,
 * so it lives in the union.
 */
export type SiblingConflictDisposition = 'sibling-owns-base' | 'sibling-quotes-base';

/**
 * What the cycle did with a candidate. `added`/`kept` are in the live set;
 * `faded-held` is held past eligibility but within min-hold (a pending removal
 * the flat-guard still protects); `faded-removed` is proposed for reaping this
 * cycle; `cooldown`/`slot-capped`/`correlation-high` passed every filter but
 * were not rotated in; `sibling-owns-base`/`sibling-quotes-base` passed but
 * collide with a sibling on the shared wallet; `rejected` failed a filter (see
 * `failedAt`).
 */
export type DiscoveryDisposition =
  | 'added'
  | 'kept'
  | 'faded-held'
  | 'faded-removed'
  | 'cooldown'
  | 'slot-capped'
  | 'correlation-high'
  | SiblingConflictDisposition
  | 'rejected';

/**
 * Per-candidate explain row: why a symbol is in or out of the universe this
 * cycle. `gainerScore` is the 24h change percent (decimal-string), or null when
 * the symbol is a held auto symbol that vanished from the ticker feed (delisted
 * / not returned), in which case `passed` is empty and `failedAt` is null — the
 * `disposition` carries the reason.
 */
export interface CandidateExplain {
  readonly symbol: string;
  readonly gainerScore: string | null;
  readonly passed: readonly DiscoveryFilterName[];
  readonly failedAt: DiscoveryFilterName | null;
  readonly disposition: DiscoveryDisposition;
}

/** The diff plus a per-candidate breakdown of the live universe (shortlist + held). */
export interface DiscoveryExplain {
  readonly diff: DiscoveryDiff;
  readonly candidates: readonly CandidateExplain[];
}

/**
 * Run the eight filters in order, short-circuiting at the first failure exactly
 * as the chain does. Returns the filters passed and the one that failed (null =
 * all passed = eligible). The ticker stages (1-6) walk the shared
 * {@link TICKER_STAGE_CHAIN} so this breakdown cannot drift from the shortlist /
 * funnel on which filters run or in what order.
 */
const evalFilters = (
  t: DiscoveryTicker,
  klines: readonly Candle[],
  cfg: DiscoveryConfig,
  ctx: RankContext,
  nowMs: number,
): { passed: DiscoveryFilterName[]; failedAt: DiscoveryFilterName | null } => {
  const passed: DiscoveryFilterName[] = [];
  for (const [name, fn] of TICKER_STAGE_CHAIN) {
    if (!fn(t, cfg, ctx)) return { passed, failedAt: name };
    passed.push(name);
  }
  if (!oldEnough(klines, cfg, nowMs)) return { passed, failedAt: 'age' };
  passed.push('age');
  if (!trendConfirmed(klines, cfg)) return { passed, failedAt: 'trend' };
  passed.push('trend');
  return { passed, failedAt: null };
};

const dispositionOf = (s: {
  eligible: boolean;
  inCurrent: boolean;
  inAdd: boolean;
  inRemove: boolean;
  // Skip reason for an eligible, non-held, non-added symbol — read from
  // `resolveDiscovery`'s emitted trace, so it matches the cron's precedence.
  notAddedReason: DiscoverySkipReason;
  // Account-level exclusivity verdict, if any. Wins over every add/keep label:
  // the symbol qualified but a sibling on the shared wallet blocks admission, so
  // the operator sees why instead of a misleading "added".
  siblingConflict?: SiblingConflictDisposition | undefined;
}): DiscoveryDisposition => {
  if (s.siblingConflict !== undefined) return s.siblingConflict;
  if (s.inAdd) return 'added';
  if (s.inRemove) return 'faded-removed';
  if (s.inCurrent) return s.eligible ? 'kept' : 'faded-held';
  if (!s.eligible) return 'rejected';
  return s.notAddedReason;
};

/**
 * Annotate a discovery cycle with a per-candidate breakdown for the operator
 * dashboard. The diff is taken verbatim from {@link runDiscovery} (the single
 * source of truth — the explain never re-decides), and each candidate's
 * disposition is derived from that diff, so the breakdown cannot drift from what
 * the cron actually applied. Candidates are the live universe: the ticker
 * shortlist plus every currently-held auto symbol, ranked by 24h gain
 * (descending; null scores last; ties by symbol). Pure — no `Date`/`Math.random`.
 */
export const explainDiscovery = (
  input: DiscoveryInput,
  // Account-level exclusivity overlay, keyed by symbol. Empty for the pure case.
  // A conflicted symbol is removed from the effective add/desired sets and takes
  // the conflict disposition, so the returned diff, the snapshot, and the
  // per-candidate rows are one truth: it is never reported as added.
  siblingConflictBySymbol: ReadonlyMap<string, SiblingConflictDisposition> = new Map(),
): DiscoveryExplain => {
  const { tickers, klinesBySymbol, currentAuto, lastFlattenAtMsBySymbol, config, nowMs } = input;
  const shortlist = shortlistByTicker(tickers, config);
  const manualMembers = input.manualMembers ?? [];
  const allowAdds = marketBreadthOk(tickers, config);
  // Same universe ranking `shortlistByTicker` built internally, so a candidate's
  // per-filter breakdown cannot disagree with the shortlist it produced.
  const rankCtx = buildRankContext(tickers, config);

  // Resolve the diff and capture the per-candidate skip reasons in ONE pass: the
  // explain reads the cron's real add-loop decision instead of replaying it. The
  // diff is byte-identical to `runDiscovery(input)` (same args), so the universe
  // breakdown can never drift from what the cron applied.
  const skipReasons = new Map<string, DiscoverySkipReason>();
  const diff = resolveDiscovery(
    shortlist,
    klinesBySymbol,
    currentAuto,
    lastFlattenAtMsBySymbol,
    config,
    nowMs,
    manualMembers,
    allowAdds,
    skipReasons,
  );

  // Subtract sibling-conflicted symbols from the add/desired sets so the diff the
  // cron applies and the explain it persists agree. `remove` is untouched: a
  // conflict only blocks a new add, never a reap.
  const effectiveDiff: DiscoveryDiff =
    siblingConflictBySymbol.size === 0
      ? diff
      : {
          add: diff.add.filter((s) => !siblingConflictBySymbol.has(s)),
          remove: diff.remove,
          desired: diff.desired.filter((s) => !siblingConflictBySymbol.has(s)),
        };

  const tickerBySymbol = new Map(tickers.map((t) => [t.symbol, t]));
  const addSet = new Set(effectiveDiff.add);
  const removeSet = new Set(effectiveDiff.remove);
  const currentSet = new Set(currentAuto.map((c) => c.symbol));
  // Pinned (manual) symbols are operator-managed, not discovery candidates:
  // exclude them from the universe so they never read as "slot-capped"/"rejected".
  const manualSet = new Set(manualMembers);

  const symbols = [...new Set([...shortlist, ...currentAuto.map((c) => c.symbol)])].filter(
    (s) => !manualSet.has(s),
  );
  const candidates: CandidateExplain[] = symbols.map((symbol) => {
    const t = tickerBySymbol.get(symbol);
    let passed: DiscoveryFilterName[] = [];
    let failedAt: DiscoveryFilterName | null = null;
    let eligible = false;
    if (t !== undefined) {
      const r = evalFilters(t, klinesBySymbol[symbol] ?? [], config, rankCtx, nowMs);
      passed = r.passed;
      failedAt = r.failedAt;
      eligible = r.failedAt === null;
    }
    const disposition = dispositionOf({
      eligible,
      inCurrent: currentSet.has(symbol),
      inAdd: addSet.has(symbol),
      inRemove: removeSet.has(symbol),
      // resolveDiscovery labels every eligible non-held non-added candidate, so
      // the `?? 'slot-capped'` is a defensive default that is unreachable for any
      // symbol whose disposition actually reads this (dispositionOf filters the
      // rest out first).
      notAddedReason: skipReasons.get(symbol) ?? 'slot-capped',
      siblingConflict: siblingConflictBySymbol.get(symbol),
    });
    return { symbol, gainerScore: t?.priceChangePercent ?? null, passed, failedAt, disposition };
  });

  // Scored candidates rank by 24h gain (desc, ties by symbol); scoreless ones
  // (held auto symbols that vanished from the feed) sort by symbol and trail.
  const scored = candidates.filter((c) => c.gainerScore !== null);
  const scoreless = candidates.filter((c) => c.gainerScore === null);
  scored.sort((a, b) => {
    const byGain = new Decimal(b.gainerScore as string).cmp(new Decimal(a.gainerScore as string));
    return byGain !== 0 ? byGain : a.symbol.localeCompare(b.symbol);
  });
  scoreless.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { diff: effectiveDiff, candidates: [...scored, ...scoreless] };
};
