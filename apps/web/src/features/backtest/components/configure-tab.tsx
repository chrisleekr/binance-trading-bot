// The Configure tab: symbol picker, window presets, backtest-only params, the
// Advanced cost/realism fold, and the strategy config AutoForm with the Run
// button. Titled "Adjust & re-run" when a run is anchored, else "Configure a
// backtest". All fields are full-width single-column so each control has room
// for its plain-English help beneath it.

import { ChevronDown } from 'lucide-react';

import { BACKTEST_INTERVALS } from '@app/contracts';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { CostModelFields } from '@/shared/components/cost-model-fields';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { AutoForm } from '@/shared/forms';
import { PanelStackSkeleton } from '@/shared/components/page-skeleton';
import { SymbolPicker } from '@/features/backtest/components/symbol-picker';
import { StrategyPreviewPanel } from '@/features/symbol/preview/strategy-preview-panel';
import { Select } from '@/shared/components/ui/select';
import type { BacktestWorkbench, ParamState } from './use-backtest-workbench';

/** One-click backtest windows ending "now", labelled by length. */
const WINDOW_PRESETS: readonly { readonly label: string; readonly days: number }[] = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '6m', days: 182 },
  { label: '1y', days: 365 },
];

/** Compact one-line gloss of the cost model, shown on the collapsed Advanced summary. */
const costSummary = (p: ParamState): string => {
  const cap = p.volumeCapPct.trim() === '' ? 'off' : `${p.volumeCapPct}%`;
  return `start ${p.initialQuoteBalance} · maker ${p.makerBps} · taker ${p.takerBps} · slippage ${p.slippageBps} · spread ${p.spreadBps} bps · vol cap ${cap}`;
};

export function ConfigureTab({ wb }: { wb: BacktestWorkbench }): React.JSX.Element {
  const { profileId } = wb;
  const { activeRunId } = wb.run;
  const {
    isBasket,
    symbol,
    setSymbol,
    params,
    setParam,
    applyWindowPreset,
    decisionInterval,
    detailIntervalTooCoarse,
    configSchema,
    strategyKey,
    configResetNonce,
    effectiveConfigDefaults,
    onConfigSubmit,
    setConfigDrifted,
    runConfigSeed,
    configDrifted,
    resetToLiveConfig,
    strategyName,
    previewPrice,
    previewAccount,
    previewQuoteAsset,
    profileLoading,
    profileError,
    strategiesLoading,
    launchPending,
  } = wb.config;

  return (
    <section id="bt-adjust-rerun" className="rounded-md border border-border bg-bg-elevated">
      <div className="border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold text-fg">
          {activeRunId ? 'Adjust & re-run' : 'Configure a backtest'}
        </h2>
        <p className="text-xs text-muted-fg">
          {activeRunId
            ? 'Change any setting below and run again. Your live config is unchanged until you apply a result.'
            : 'Set the window, costs, and strategy config, then run.'}
        </p>
      </div>
      <div className="space-y-4 p-3">
        {isBasket ? (
          <p className="text-sm text-muted-fg" data-testid="backtest-basket-note">
            This strategy trades a basket. Set the symbols and their weights under{' '}
            <span className="font-medium text-fg">Strategy config</span> below; the backtest runs
            over all of them.
          </p>
        ) : (
          <SymbolPicker value={symbol} onChange={setSymbol} />
        )}
        <div className="space-y-1.5">
          <span className="text-xs text-muted-fg">Quick window (ending now)</span>
          <div className="flex flex-wrap gap-2">
            {WINDOW_PRESETS.map((w) => (
              <Button
                key={w.label}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => applyWindowPreset(w.days)}
                data-testid={`backtest-window-${w.label}`}
              >
                {w.label}
              </Button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="bt-from">From</Label>
            <Input
              id="bt-from"
              type="datetime-local"
              value={params.from}
              onChange={setParam('from')}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bt-to">To</Label>
            <Input id="bt-to" type="datetime-local" value={params.to} onChange={setParam('to')} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bt-detail-interval">Detail interval</Label>
            <Select
              id="bt-detail-interval"
              className="w-full"
              value={params.detailInterval}
              onChange={setParam('detailInterval')}
            >
              {BACKTEST_INTERVALS.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-fg">
              Finer candles used to simulate price movement inside each strategy candle, for more
              realistic fills. Must be the same as or finer than your{' '}
              <span className="font-medium">Candle Interval</span> ({decisionInterval}), set in
              Strategy config below.
            </p>
            {detailIntervalTooCoarse && (
              <p className="text-xs text-down">
                Detail interval must be the same as or finer than your Candle Interval (
                {decisionInterval}).
              </p>
            )}
          </div>
        </div>

        {/* Costs & realism are expert knobs set once; fold them away with a
            summary of the current values so nothing is hidden, just quieted. */}
        <details className="group rounded-md border border-border bg-surface-alt">
          <summary className="flex cursor-pointer list-none flex-col gap-0.5 px-3 py-2 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none [&::-webkit-details-marker]:hidden">
            <span className="flex items-center justify-between gap-2 text-sm font-medium text-fg">
              Advanced — fees, slippage &amp; realism
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-fg transition-transform group-open:rotate-180" />
            </span>
            <span className="text-xs text-muted-fg tabular-nums">{costSummary(params)}</span>
          </summary>
          <div className="grid grid-cols-1 gap-4 p-3 pt-1 sm:grid-cols-2">
            <CostModelFields
              idPrefix="bt"
              values={params}
              onChange={setParam}
              realism={{ values: params, onChange: setParam }}
            />
          </div>
        </details>

        <div aria-labelledby="bt-config-h" className="space-y-3 border-t border-border pt-4">
          <h3 id="bt-config-h" className="text-sm font-medium text-fg">
            Strategy config
          </h3>
          <p className="text-sm text-muted-fg">
            Prefilled from this profile's live config. Edit any field to test a different setup; the
            run uses these values, not the saved config.
          </p>
          {configSchema ? (
            <>
              <AutoForm<Record<string, unknown>>
                key={`${strategyKey}:${configResetNonce}`}
                jsonSchema={configSchema}
                defaultValues={effectiveConfigDefaults}
                onSubmit={onConfigSubmit}
                onDirtyChange={setConfigDrifted}
                defaultOpenGroups={runConfigSeed !== null}
                formId="backtest-config-form"
                aside={
                  <StrategyPreviewPanel
                    strategyName={strategyName}
                    profileId={profileId}
                    symbol={symbol || undefined}
                    currentPrice={previewPrice}
                    account={previewAccount}
                    quoteAsset={previewQuoteAsset}
                  />
                }
              >
                <Button
                  type="submit"
                  variant="primary"
                  disabled={detailIntervalTooCoarse || launchPending}
                  className="h-11 w-full"
                >
                  {launchPending ? 'Queuing…' : 'Run backtest'}
                </Button>
              </AutoForm>
              {configDrifted || runConfigSeed !== null ? (
                <div className="space-y-2 border-t border-border pt-3">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={launchPending}
                    onClick={resetToLiveConfig}
                    className="h-11 w-full"
                    data-testid="backtest-reset-live"
                  >
                    Reset to current live config
                  </Button>
                  <p className="text-xs text-muted-fg">
                    {runConfigSeed !== null
                      ? 'This form is showing a loaded config (a past run or a suggested change). Reset to restore the profile’s saved live config.'
                      : 'Restores the profile’s saved live config, discarding your edits above.'}
                  </p>
                </div>
              ) : null}
            </>
          ) : profileError ? (
            <Alert variant="danger">
              <AlertTitle>Couldn't load this profile</AlertTitle>
              <AlertDescription>Reload the page or reopen this profile.</AlertDescription>
            </Alert>
          ) : profileLoading || strategiesLoading ? (
            // Mirrors the generated backtest form: the window/cost panels above
            // the strategy's own grouped config fields.
            <PanelStackSkeleton shape={[3, 4, 5]} />
          ) : (
            <Alert variant="danger">
              <AlertTitle>Config form unavailable</AlertTitle>
              <AlertDescription>No config schema for strategy {strategyKey}.</AlertDescription>
            </Alert>
          )}
        </div>
      </div>
    </section>
  );
}
