import type { CandidateExplain, DiscoveryFilterName } from './explain.js';
import { TICKER_STAGE_CHAIN, type TickerStageCounts } from './run.js';
import type { DiscoveryDiff } from './types.js';

/**
 * Per-cycle survivor counts across the two-segment filter funnel, plus the
 * resolved diff outcome. A single-row observability projection: it answers "where
 * did the universe collapse this cycle" without re-reading every per-candidate row.
 *
 * The funnel has TWO segments with DIFFERENT denominators:
 *
 * - Ticker segment (`universe` … `changeBand`): survivor counts over the FULL
 *   quote-matched ticker set — every symbol the cron saw this cycle, not just the
 *   handful it fetched klines for. Monotone non-increasing within the segment.
 * - Candidate/kline segment (`probed` … `eligible`): counts over the kline
 *   candidates (the shortlist ∪ held auto, minus pinned) — except `probed`,
 *   which counts only those a window was actually fetched for. Monotone
 *   non-increasing within the segment: a candidate with no window fails the age
 *   cut for want of data, so `age <= probed` still holds.
 *
 * There is NO monotonicity across the boundary: `changeBand` counts the whole
 * exchange's change-band survivors while `probed` counts only the few candidates
 * whose klines were fetched, so `probed` is normally far smaller than `changeBand`.
 * `breadthOk` is the market-breadth gate verdict the cycle evaluated.
 */
export interface DiscoveryFunnel {
  /** Full quote-matched ticker set this cycle (the ticker segment's denominator). */
  readonly universe: number;
  readonly quote: number;
  /** Survivors of the non-configurable stablecoin/fiat cut. No setting can move this rung, which is exactly why it is reported: an operator staring at a collapsed funnel must be able to see that this is not a knob they failed to widen. */
  readonly assetPolicy: number;
  readonly blacklist: number;
  readonly liquidity: number;
  readonly activity: number;
  readonly spread: number;
  readonly changeBand: number;
  /**
   * Candidates whose price history was actually fetched (the candidate segment's
   * denominator). Without it `age` is the segment's first entry and so can only
   * ever be a denominator, which hides a collapse AT the age filter and makes
   * the choke search blame a ticker filter that is working fine.
   *
   * Counts fetched windows, not candidates: a candidate with no window fails the
   * age cut for want of data, so counting it here would render a fetch failure
   * as an age-filter failure and point the operator at the wrong setting.
   */
  readonly probed: number;
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

// Evaluation order of the whole filter chain. The ticker segment is DERIVED from TICKER_STAGE_CHAIN rather than restated: a hand-kept copy silently disagrees the first time a stage is added, and the only symptom would be `eligible` counting a candidate that skipped the new rung.
const STAGES: readonly DiscoveryFilterName[] = [
  ...TICKER_STAGE_CHAIN.map(([name]) => name),
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
 * The CANDIDATE segment (`probed` … `eligible`) is derived from `candidates`, the
 * kline-stage rows: a candidate "survived" stage S iff S is in its `passed`
 * list (the chain truncated at its first failure), and `eligible` requires a FULL
 * pass (`passed.length === STAGES.length`), not merely `failedAt === null` — a
 * held symbol that vanished from the ticker feed also has `failedAt === null` but
 * an empty `passed`, and it is not eligible. `kept` = desired minus new adds =
 * retained survivors.
 *
 * @param candidates - Per-candidate filter traces for the kline segment. Every candidate the cycle considered, including ones no window was fetched for.
 * @param diff - The cycle's resolved add/remove/desired sets, source of the `added` / `kept` / `removed` tail.
 * @param breadthOk - The market-breadth gate's verdict this cycle. Recorded, not applied: it gates admission elsewhere and is surfaced here for the reader.
 * @param ticker - Survivor counts for the ticker segment, over a different denominator than everything derived from `candidates`.
 * @param probed - How many candidates a window was actually fetched for. Passed in rather than taken as `candidates.length` because a candidate with no window still appears in `candidates`, scored as failing the age cut, so using the length would attribute the caller's fetch cap or a kline outage to a filter.
 * @returns The single-row funnel projection for this cycle.
 */
export const projectFunnel = (
  candidates: readonly CandidateExplain[],
  diff: DiscoveryDiff,
  breadthOk: boolean,
  ticker: TickerStageCounts,
  probed: number,
): DiscoveryFunnel => {
  const survived = (stage: DiscoveryFilterName): number =>
    candidates.filter((c) => c.passed.includes(stage)).length;
  const eligible = candidates.filter(
    (c) => c.failedAt === null && c.passed.length === STAGES.length,
  ).length;
  return {
    universe: ticker.universe,
    quote: ticker.quote,
    assetPolicy: ticker.assetPolicy,
    blacklist: ticker.blacklist,
    liquidity: ticker.liquidity,
    activity: ticker.activity,
    spread: ticker.spread,
    changeBand: ticker.changeBand,
    probed,
    age: survived('age'),
    trend: survived('trend'),
    eligible,
    added: diff.add.length,
    kept: diff.desired.length - diff.add.length,
    removed: diff.remove.length,
    breadthOk,
  };
};
