// TRADE tab of the symbol workspace: the chart, the strategy's "what is it
// about to do" signal, the operator's manual-trade and force-trigger actions,
// and a compact balances readout. The chart's heavy lightweight-charts chunk
// loads lazily inside SymbolCandleChart, so mounting this tab is the first time
// that chunk is fetched.

import {
  SymbolCandleChart,
  type ChartOverlays,
} from '@/features/symbol/components/symbol-candle-chart';
import { ChartIntervalSelector } from '@/features/symbol/components/chart-interval-selector';
import { SymbolBalancesPanel } from '@/features/symbol/components/symbol-balances-panel';
import {
  ForceTriggerPanel,
  ManualTradePanel,
} from '@/features/symbol/components/symbol-trade-panels';
import { SymbolCancelOverridePanel } from '@/features/symbol/components/symbol-cancel-override-panel';
import { SymbolPausePanel } from '@/features/symbol/components/symbol-pause-panel';
import { SymbolStopTrackingPanel } from '@/features/symbol/components/symbol-stop-tracking-panel';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Card } from '@/shared/components/ui/card';
import { Panel } from '@/shared/components/panel';
import { type CandleInterval } from '@/features/symbol/api/symbol';
import { type StrategyView } from '@/features/symbol/strategies/types';

import { isHeldPosition, type CandleList, type SymbolStateResponse } from '@app/contracts';

export function WorkspaceTradeTab({
  profileId,
  symbol,
  candles,
  candlesLoading,
  candlesError,
  overlays,
  filterTickSize,
  interval,
  onIntervalChange,
  state,
  stateLoading,
  currentPrice,
  view,
  operatorActions,
  onSymbolWiped,
}: {
  profileId: string;
  symbol: string;
  candles: CandleList | undefined;
  candlesLoading: boolean;
  candlesError: unknown;
  overlays: ChartOverlays;
  filterTickSize: string | null;
  interval: CandleInterval;
  onIntervalChange: (interval: CandleInterval) => void;
  state: SymbolStateResponse | undefined;
  stateLoading: boolean;
  currentPrice: string | null;
  view: StrategyView;
  operatorActions: ReadonlySet<string>;
  /** Navigate away after "stop tracking" wipes the symbol. */
  onSymbolWiped: () => void;
}): React.JSX.Element {
  const canForce = operatorActions.has('trigger-buy') || operatorActions.has('trigger-sell');
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="order-2 min-w-0 space-y-4 lg:order-1">
          <ChartPanel
            candles={candles}
            isLoading={candlesLoading}
            error={candlesError}
            overlays={overlays}
            filterTickSize={filterTickSize}
            interval={interval}
            onIntervalChange={onIntervalChange}
          />

          {stateLoading ? (
            <Card>
              <p className="text-muted-fg text-sm">Loading symbol state…</p>
            </Card>
          ) : null}

          {state ? (
            <Card>
              <view.SignalPanel
                profileId={profileId}
                symbol={symbol}
                state={state}
                currentPrice={currentPrice}
              />
            </Card>
          ) : null}
        </div>

        {/* Below lg the rail stacks first so the everyday controls sit above the
            chart; desktop keeps chart-left / rail-right. */}
        <div className="order-1 space-y-4 lg:order-2">
          <Card>
            <SymbolBalancesPanel profileId={profileId} symbol={symbol} />
          </Card>
          {operatorActions.has('manual-order') ? (
            <Card>
              <ManualTradePanel profileId={profileId} symbol={symbol} />
            </Card>
          ) : null}
        </div>
      </div>

      {/* Emergency actions — force a trade, cancel a queued one, pause trading,
          stop tracking — are rare, deliberate writes, so they live in one
          collapsed disclosure at the bottom instead of always-open rail cards
          that crowd the everyday view. Panel is a native <details>: the actions
          stay mounted and keyboard-reachable while collapsed. Rendered once the
          symbol state has loaded (stop-tracking and cancel always apply then);
          force-trigger and pause show inside only when they apply. */}
      {state ? (
        <Panel
          title="Emergency actions"
          description="Force a trade, cancel a queued one, pause trading, or stop tracking this symbol."
          collapsible
          defaultOpen={false}
          summaryTestId="symbol-emergency-actions"
        >
          <div className="space-y-4">
            {canForce ? (
              <ForceTriggerPanel
                profileId={profileId}
                symbol={symbol}
                canBuy={operatorActions.has('trigger-buy')}
                canSell={operatorActions.has('trigger-sell')}
                held={isHeldPosition(
                  state.avgEntryPrice?.avgEntryPrice,
                  state.avgEntryPrice?.quantity,
                )}
              />
            ) : null}
            {!state.disable ? <SymbolPausePanel profileId={profileId} symbol={symbol} /> : null}
            {/* Not gated on `canForce`, which only covers the trigger actions: a
                profile with `manual-order` and no triggers still queues
                symbol-scoped overrides, and this is the only way to revoke one. */}
            <SymbolCancelOverridePanel profileId={profileId} symbol={symbol} />
            <SymbolStopTrackingPanel
              profileId={profileId}
              symbol={symbol}
              onWiped={onSymbolWiped}
            />
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

/**
 * Chart panel. Presentational — the workspace owns the candles query and
 * overlay derivation; this renders the interval selector (always visible so the
 * operator can switch away from an empty window) above a body that maps the
 * query's loading/error/empty/ready states onto the lightweight-charts component.
 */
function ChartPanel({
  candles,
  isLoading,
  error,
  overlays,
  filterTickSize,
  interval,
  onIntervalChange,
}: {
  readonly candles: CandleList | undefined;
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly overlays: ChartOverlays;
  readonly filterTickSize: string | null;
  readonly interval: CandleInterval;
  readonly onIntervalChange: (interval: CandleInterval) => void;
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-fg text-sm font-semibold">Candle chart</h2>
        <ChartIntervalSelector value={interval} onChange={onIntervalChange} />
      </div>
      <ChartBody
        candles={candles}
        isLoading={isLoading}
        error={error}
        overlays={overlays}
        filterTickSize={filterTickSize}
      />
    </div>
  );
}

/** State-mapped body of {@link ChartPanel}: loading / error / empty / chart. */
function ChartBody({
  candles,
  isLoading,
  error,
  overlays,
  filterTickSize,
}: {
  readonly candles: CandleList | undefined;
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly overlays: ChartOverlays;
  readonly filterTickSize: string | null;
}): React.JSX.Element {
  if (isLoading) {
    return (
      <section
        aria-label="Candle chart loading"
        data-testid="symbol-chart-loading"
        className="border-border bg-bg-elevated flex h-[300px] items-center justify-center rounded-md border border-dashed text-sm sm:h-[440px]"
      >
        Loading chart…
      </section>
    );
  }

  if (error) {
    return (
      <Alert variant="danger">
        <AlertTitle>Chart unavailable</AlertTitle>
        <AlertDescription>{error instanceof Error ? error.message : 'unknown'}</AlertDescription>
      </Alert>
    );
  }

  // The chart is the trade tab's primary surface, so it stays mounted even with
  // an empty window: lightweight-charts renders an empty grid, and an in-chart
  // note tells the operator there were no candles in the last window rather than
  // swapping the whole surface out (which churned the chart on every gap).
  return (
    <div className="relative">
      <SymbolCandleChart
        candles={candles ?? []}
        overlays={overlays}
        filterTickSize={filterTickSize}
        height={440}
      />
      {!candles || candles.length === 0 ? (
        <p
          data-testid="symbol-chart-empty"
          className="text-muted-fg pointer-events-none absolute inset-x-0 top-2 text-center text-xs"
        >
          No candles in the last window.
        </p>
      ) : null}
    </div>
  );
}
