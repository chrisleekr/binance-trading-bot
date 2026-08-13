// The Results tab: the anchored run's live progress (or its finished result),
// the metrics + charts (via BacktestResults), and the "What next?" zone — refine
// the config, apply it, or pin a baseline. An "Adjust & re-run" control jumps
// back to the Configure tab, which is already pre-seeded from this run.

import { type BacktestPhase } from '@app/contracts';
import { Button } from '@/shared/components/ui/button';
import { BacktestResults } from '@/features/backtest/components/backtest-results';
import { BacktestPriceCharts } from '@/features/backtest/components/backtest-price-charts';
import { BacktestApplyConfig } from '@/features/backtest/components/backtest-apply-config';
import { BacktestRecommendations } from '@/features/backtest/components/backtest-recommendations';
import { BacktestLlmAdvisor } from '@/features/backtest/components/backtest-llm-advisor';
import type { BacktestWorkbench } from './use-backtest-workbench';

/** Plain-language label for each running-backtest phase. */
const PHASE_LABEL: Record<BacktestPhase, string> = {
  backfill: 'Loading price history',
  warmup: 'Warming up indicators',
  replay: 'Replaying strategy',
  finalize: 'Finalizing results',
};

export function ResultsTab({ wb }: { wb: BacktestWorkbench }): React.JSX.Element {
  const { profileId, setTab } = wb;
  const {
    activeRunId,
    status,
    activeRunData,
    progress,
    progressDetail,
    etaLabel,
    result,
    attributionConfig,
    testedConfig,
    applyWarning,
    descriptor,
    profileData,
  } = wb.run;
  const { parentAnchor, baselineAnchor, pinBaseline } = wb.compare;
  const { seedConfigForRetest } = wb.config;

  const runActions = result ? (
    <section
      aria-labelledby="bt-actions-h"
      className="space-y-3 rounded-md border border-border bg-bg-elevated p-3"
    >
      <div className="space-y-1">
        <h3 id="bt-actions-h" className="text-sm font-semibold text-fg">
          Use this run
        </h3>
        <p className="text-xs text-muted-fg">
          Commit this run to your live profile — overwrite its config, or pin it as the baseline you
          measure live performance against.
        </p>
      </div>
      {testedConfig && (
        <BacktestApplyConfig
          profileId={profileId}
          testedConfig={testedConfig}
          warning={applyWarning}
        />
      )}
      {activeRunId && (
        <div className="space-y-1.5 border-t border-border pt-3">
          <p className="text-xs text-muted-fg">
            Pin this run as the live baseline to compare your live win-rate and profit factor
            against it on the dashboard.
          </p>
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full"
            disabled={pinBaseline.isPending}
            onClick={() => pinBaseline.mutate(activeRunId)}
            data-testid="backtest-pin-baseline"
          >
            {pinBaseline.isPending ? 'Pinning…' : 'Pin as live baseline'}
          </Button>
        </div>
      )}
    </section>
  ) : null;

  return (
    <section className="space-y-4">
      {!activeRunId && (
        <section className="rounded-md border border-border bg-bg-elevated p-6 text-center text-sm text-muted-fg">
          No run yet. Configure one in the Configure tab, or pick a past run from History, to see
          its results here.
        </section>
      )}

      {activeRunId && (
        <section
          aria-labelledby="bt-progress-h"
          className="space-y-2 rounded-md border border-border bg-bg-elevated p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="bt-progress-h" className="text-sm font-semibold text-fg">
              Run {activeRunId.slice(0, 8)} — {status ?? 'loading'}
            </h2>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setTab('configure')}
              data-testid="backtest-adjust-rerun"
            >
              Adjust &amp; re-run
            </Button>
          </div>
          {(status === 'queued' || status === 'running') && progressDetail && (
            <p className="text-xs text-muted-fg" data-testid="bt-progress-detail">
              {PHASE_LABEL[progressDetail.phase]}
              {progressDetail.symbol ? ` · ${progressDetail.symbol}` : ''}
              {progressDetail.phase === 'replay' && progressDetail.total
                ? ` · candle ${(progressDetail.processed ?? 0).toLocaleString()} of ${progressDetail.total.toLocaleString()}`
                : ''}
              {etaLabel ? ` · ~${etaLabel} left` : ''}
            </p>
          )}
          <div className="h-2 w-full overflow-hidden rounded-md border border-border bg-surface-alt">
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${status === 'done' ? 100 : progress}%` }}
              role="progressbar"
              aria-labelledby="bt-progress-h"
              aria-valuenow={status === 'done' ? 100 : progress}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
          {status === 'error' && (
            <p className="text-sm text-down">
              {activeRunData?.error ?? 'Backtest failed. Review your parameters and try again.'}
            </p>
          )}
        </section>
      )}

      {result && (
        <BacktestResults
          result={result}
          config={attributionConfig}
          reasonAttribution={descriptor?.reasonAttribution}
          parentAnchor={parentAnchor}
          baselineAnchor={baselineAnchor}
          priceCharts={<BacktestPriceCharts result={result} profileId={profileId} />}
          recommendations={
            <div className="space-y-3">
              <div className="space-y-1">
                <p className="text-[11px] font-semibold tracking-wider text-muted-fg uppercase">
                  Refine the config
                </p>
                <p className="text-xs text-muted-fg">
                  Find a better config from this run. Each option below loads changes into the
                  Configure tab for you to review and run yourself — nothing here touches your live
                  config, and the out-of-sample gate still stands before going live.
                </p>
              </div>
              <BacktestRecommendations
                key={activeRunId ?? undefined}
                breakdown={result.decisionBreakdown}
                config={attributionConfig}
                onApply={seedConfigForRetest}
              />
              {activeRunId ? (
                <BacktestLlmAdvisor
                  key={`llm-${activeRunId}`}
                  profileId={profileId}
                  runId={activeRunId}
                  config={attributionConfig}
                  onApply={seedConfigForRetest}
                />
              ) : null}
            </div>
          }
          actions={runActions}
          {...(profileData ? { enablementPolicy: profileData.enablementPolicy } : {})}
        />
      )}
    </section>
  );
}
