import type { CandidateExplain, DiscoveryFilterName } from './explain.js';
import type { TickerStageCounts } from './run.js';
import type { DiscoveryDiff } from './types.js';

/**
 * Per-cycle survivor counts across the two-segment filter funnel, plus the
 * resolved diff outcome. A single-row observability projection: it answers "where
 * did the universe collapse this cycle" without re-reading every per-candidate row.
 *
 * The funnel has TWO segments with DIFFERENT denominators (issue #636):
 *
 * - Ticker segment (`universe` … `changeBand`): survivor counts over the FULL
 *   quote-matched ticker set — every symbol the cron saw this cycle, not just the
 *   handful it fetched klines for. Monotone non-increasing within the segment.
 * - Candidate/kline segment (`age`, `trend`, `eligible`): counts over the kline
 *   candidates (the shortlist ∪ held auto, minus pinned). Monotone non-increasing
 *   within the segment.
 *
 * There is NO monotonicity across the boundary: `changeBand` counts the whole
 * exchange's change-band survivors while `age` counts only the few candidates
 * whose klines were fetched, so `age` is normally far smaller than `changeBand`.
 * `breadthOk` is the market-breadth gate verdict the cycle evaluated.
 */
export interface DiscoveryFunnel {
  /** Full quote-matched ticker set this cycle (the ticker segment's denominator). */
  readonly universe: number;
  readonly quote: number;
  readonly blacklist: number;
  readonly liquidity: number;
  readonly activity: number;
  readonly spread: number;
  readonly changeBand: number;
  readonly age: number;
  readonly trend: number;
  /** Candidates that cleared every filter stage. */
  readonly eligible: number;
  readonly added: number;
  readonly kept: number;
  readonly removed: number;
  /** The market-breadth gate verdict; false means NEW adds were blocked this cycle. */
  readonly breadthOk: boolean;
}

// Evaluation order of the filter chain, mirroring explain.ts's DiscoveryFilterName.
const STAGES: readonly DiscoveryFilterName[] = [
  'quote',
  'blacklist',
  'liquidity',
  'activity',
  'spread',
  'changeBand',
  'age',
  'trend',
];

/**
 * Project a per-cycle filter funnel from the two segments' inputs. Pure and total:
 * all-zero `ticker` counts + an empty candidate list + an empty diff yield an
 * all-zero funnel.
 *
 * The TICKER segment (`universe` … `changeBand`) is taken verbatim from `ticker`,
 * which {@link tickerStageCounts} computed over the full quote-matched ticker set.
 * The CANDIDATE segment (`age`, `trend`, `eligible`) is derived from `candidates`,
 * the kline-stage rows: a candidate "survived" stage S iff S is in its `passed`
 * list (the chain truncated at its first failure), and `eligible` requires a FULL
 * pass (`passed.length === STAGES.length`), not merely `failedAt === null` — a
 * held symbol that vanished from the ticker feed also has `failedAt === null` but
 * an empty `passed`, and it is not eligible. `kept` = desired minus new adds =
 * retained survivors.
 */
export const projectFunnel = (
  candidates: readonly CandidateExplain[],
  diff: DiscoveryDiff,
  breadthOk: boolean,
  ticker: TickerStageCounts,
): DiscoveryFunnel => {
  const survived = (stage: DiscoveryFilterName): number =>
    candidates.filter((c) => c.passed.includes(stage)).length;
  const eligible = candidates.filter(
    (c) => c.failedAt === null && c.passed.length === STAGES.length,
  ).length;
  return {
    universe: ticker.universe,
    quote: ticker.quote,
    blacklist: ticker.blacklist,
    liquidity: ticker.liquidity,
    activity: ticker.activity,
    spread: ticker.spread,
    changeBand: ticker.changeBand,
    age: survived('age'),
    trend: survived('trend'),
    eligible,
    added: diff.add.length,
    kept: diff.desired.length - diff.add.length,
    removed: diff.remove.length,
    breadthOk,
  };
};
