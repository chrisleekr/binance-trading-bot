// The deterministic diagnosis spine: a ranked list of PROVABLE causes for a
// backtest's outcome, shown above the evidence. Every item is a fact the run's
// own data states — a counted entry-blocker, a live-gate threshold the metrics
// miss, or a segment read (zero trades, lost to hold, a losing regime, a weak
// holdout). It NEVER guesses from a PnL or drawdown heuristic: a deep drawdown
// or a red number is an outcome, not a cause. When a run lost and nothing
// provable explains it, the spine says exactly that and routes the operator to
// the advisor instead of inventing a reason.

import { recommendTradeOrHold, type BacktestResult, type EnablementPolicy } from '@app/contracts';

import { failedGateChecks } from '@/features/backtest/lib/gate-candidate';
import {
  attributeBlocker,
  summarizeDecisionBreakdown,
  type BlockerAttribution,
  type ReasonAttributionMap,
} from '@/features/backtest/lib/decision-breakdown';

/** A single provable diagnosis item. */
export interface DiagnosisItem {
  /** Stable key. */
  readonly id: string;
  readonly kind: 'blocker' | 'gate-fail' | 'segment' | 'none';
  readonly title: string;
  /** Optional supporting line (attribution note, gate actual-vs-need, routing copy). */
  readonly detail?: string;
  /** Entries / failed-check count, for ordering and copy. */
  readonly count?: number;
  /** The config lever behind a blocker, resolved off the strategy's attribution map. */
  readonly lever?: BlockerAttribution | null;
}

/**
 * Compose the ranked diagnosis spine for a finished run. Order: funnel blockers
 * (by count desc) → live-gate failures (grouped) → factual segment reads →
 * the single "no deterministic cause" fallback. The fallback fires only when the
 * run is a loss AND nothing provable was found, so a losing run is never left
 * silent and a winning run with no issues yields an empty spine. Pure.
 */
export function buildDiagnosisSpine(
  result: BacktestResult,
  attribution: ReasonAttributionMap,
  config: Record<string, unknown>,
  policy?: EnablementPolicy,
): DiagnosisItem[] {
  const items: DiagnosisItem[] = [];
  const m = result.metrics;

  // 1. Funnel blockers, already ranked by count desc, each naming its config
  //    lever off the strategy's attribution map (null when the strategy maps no
  //    lever to that code).
  const summary = summarizeDecisionBreakdown(result.decisionBreakdown, attribution);
  if (summary) {
    for (const b of summary.blockers) {
      items.push({
        id: `blocker:${b.code}`,
        kind: 'blocker',
        title: b.label,
        count: b.count,
        lever: attributeBlocker(b.code, attribution, config),
      });
    }
  }

  // 2. Live-gate threshold failures, grouped into one item (the scorecard owns
  //    the per-check detail; the spine states only that the bar is missed).
  if (policy) {
    const failed = failedGateChecks(m, result.outOfSample ?? null, result.dataWarnings, policy);
    if (failed.length > 0) {
      const labels = failed.map((c) => c.label);
      items.push({
        id: 'gate-fail',
        kind: 'gate-fail',
        title: `Live-gate checks not cleared: ${labels.join(', ')}`,
        detail: failed.map((c) => `${c.label}: ${c.actual} (need ${c.need})`).join('; '),
        count: failed.length,
      });
    }
  }

  // 3. Factual segment reads — each a fact the metrics state outright.
  if (m.totalTrades === 0) {
    items.push({
      id: 'segment:zero-trades',
      kind: 'segment',
      title: 'No closed trades over the window',
    });
  }
  if (m.alphaVsHoldPct < 0) {
    items.push({
      id: 'segment:alpha',
      kind: 'segment',
      title: `Lost to buy-and-hold by ${Math.abs(m.alphaVsHoldPct).toFixed(2)}% (negative alpha vs hold)`,
    });
  }
  for (const r of result.regimeBreakdown) {
    if (r.alphaVsHoldPct < 0) {
      items.push({
        id: `segment:regime:${r.regime}`,
        kind: 'segment',
        title: `${r.regime} regime: negative alpha vs hold (${r.alphaVsHoldPct.toFixed(2)}%)`,
      });
    }
  }
  const oos = result.outOfSample;
  if (oos) {
    if (oos.trades === 0) {
      items.push({
        id: 'segment:oos-short',
        kind: 'segment',
        title: 'Out-of-sample holdout was too short to trade',
      });
    } else if (oos.alphaVsHoldPct < 0) {
      items.push({
        id: 'segment:oos-under',
        kind: 'segment',
        title: `Out-of-sample holdout underperformed hold (${oos.alphaVsHoldPct.toFixed(2)}%)`,
      });
    }
  }

  // 4. No provable cause on a losing run: say so and route to the next steps
  //    rather than fabricate a PnL/drawdown heuristic.
  const isLoss =
    m.totalReturnPct < 0 || m.alphaVsHoldPct < 0 || recommendTradeOrHold(m).recommend === 'hold';
  if (items.length === 0 && isLoss) {
    items.push({
      id: 'none',
      kind: 'none',
      title: 'No deterministic cause found',
      detail:
        'Nothing in this run provably explains the result. Try the advisor in “What next?” below.',
    });
  }

  return items;
}
