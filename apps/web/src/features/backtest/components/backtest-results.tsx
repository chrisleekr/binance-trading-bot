import type { BacktestResult, EnablementPolicy } from '@app/contracts';

import { useMemo } from 'react';

import type { ReasonAttributionMap } from '@/features/backtest/lib/decision-breakdown';
import { buildDiagnosisSpine } from '@/features/backtest/lib/diagnosis-spine';
import { useTimezone } from '@/shared/context/timezone-context';
import { ComparisonHeader, type BacktestComparisonAnchor } from './comparison-header';
import { DiagnosisSpine } from './diagnosis-spine-view';
import type { AreaChartModule } from './equity-area-chart';
import { ResultsActionsSection } from './results-actions-section';
import { ResultsBannersSection } from './results-banners-section';
import { ResultsChartsSection } from './results-charts-section';
import type { ConfigShape } from './results-format';
import { ResultsMetricsSection } from './results-metrics-section';
import { ResultsTablesSection } from './results-tables-section';

export type { BacktestComparisonAnchor };

export interface BacktestResultsProps {
  readonly result: BacktestResult;
  /** Test seam forwarded to the charts. */
  readonly loadChartModule?: () => Promise<AreaChartModule>;
  /**
   * Optional per-symbol price-chart section (candles + trade markers). The
   * route composes it so this component stays pure presentation — the price
   * charts fetch candles and own their own query state.
   */
  readonly priceCharts?: React.ReactNode;
  /**
   * The profile's live-enablement policy. When present, a gate scorecard shows
   * whether these results clear the gate's quality thresholds. Omitted while the
   * profile is still loading; the scorecard then simply doesn't render.
   */
  readonly enablementPolicy?: EnablementPolicy;
  /**
   * Optional guarded-recommendations panel (composed by the route, which owns
   * the form-seed callback). Rendered in the "Next steps" zone at the foot of
   * the results, so the operator reads the outcome before deciding what to test.
   * Kept as a slot so this component stays pure presentation.
   */
  readonly recommendations?: React.ReactNode;
  /**
   * Optional run-level actions (apply the tested config, pin a baseline),
   * composed by the route. Rendered alongside `recommendations` in the same
   * "Next steps" zone so every next-step control sits in one place.
   */
  readonly actions?: React.ReactNode;
  /**
   * The strategy config this run tested, used by the "Why it traded" panel to
   * name which config setting armed each entry blocker. Omitted (treated as `{}`)
   * when the route can't resolve it; attribution then degrades to the bare label.
   */
  readonly config?: ConfigShape;
  /**
   * The active strategy's reason-code → config-setting attribution map (from its
   * public descriptor). Names the config lever behind each entry-blocker in the
   * diagnosis spine and the "Why it traded" evidence. Omitted (treated as `{}`)
   * while the strategy descriptor is still loading; attribution then degrades to
   * the bare blocker label.
   */
  readonly reasonAttribution?: ReasonAttributionMap | undefined;
  /**
   * Comparison anchors for the Verdict header. `parentAnchor` is the run this run
   * forked from; `baselineAnchor` is the profile's pinned live baseline. Each is
   * resolved by the route and present only when it is a done run with a result;
   * null/omitted hides that anchor. With neither, no comparison strip renders.
   */
  readonly parentAnchor?: BacktestComparisonAnchor | null;
  readonly baselineAnchor?: BacktestComparisonAnchor | null;
}

/**
 * The completed-run view: headline metrics, the equity + underwater curves,
 * a per-trade table, and the standing disclaimer that a backtest overstates
 * live performance. Composed from per-section views; each section owns its own
 * derived state so this component only routes props and orders the sections.
 */
export function BacktestResults({
  result,
  loadChartModule,
  priceCharts,
  enablementPolicy,
  recommendations,
  actions,
  config = {},
  reasonAttribution = {},
  parentAnchor = null,
  baselineAnchor = null,
}: BacktestResultsProps): React.JSX.Element {
  const timeZone = useTimezone();
  const diagnosisItems = useMemo(
    () => buildDiagnosisSpine(result, reasonAttribution, config, enablementPolicy),
    [result, reasonAttribution, config, enablementPolicy],
  );

  return (
    <div className="space-y-6">
      <ResultsBannersSection result={result} />
      <ComparisonHeader
        viewed={result}
        parentAnchor={parentAnchor}
        baselineAnchor={baselineAnchor}
      />
      {/* ── The deterministic diagnosis spine: provable causes, read before the
          numbers and the evidence. Hidden only when there is nothing provable to
          state (a clean winning run). ── */}
      {diagnosisItems.length > 0 ? (
        <DiagnosisSpine items={diagnosisItems} hasNextSteps={Boolean(recommendations || actions)} />
      ) : null}
      <ResultsMetricsSection result={result} enablementPolicy={enablementPolicy} />
      <ResultsChartsSection result={result} loadChartModule={loadChartModule} />

      {priceCharts}

      <ResultsTablesSection
        result={result}
        timeZone={timeZone}
        config={config}
        reasonAttribution={reasonAttribution}
      />

      {/* Methodology caveat — always true, so it reads as a quiet footnote, not a
          second loud warning competing with the run's actual verdict above. */}
      <p className="text-muted-fg text-xs leading-relaxed">
        <span className="text-fg font-medium">Backtests overstate live performance</span> — fills
        are idealized (limit orders fill at the order price, market at the candle open), the
        intra-candle price path is unknown, and infinite liquidity at the fill price is assumed.
        Slippage and fees are modeled but latency and order-book depth are not. Past performance
        does not guarantee future results.
      </p>

      <ResultsActionsSection recommendations={recommendations} actions={actions} />
    </div>
  );
}
