// The symbol WORKSPACE: the tabbed detail surface that opens beside the
// overview when `?sym=<profileId>:<SYMBOL>` is set on the dashboard. It owns the
// per-symbol queries and live socket, renders an always-visible header (the
// "why is/isn't it trading" cluster plus the operator's read-mostly actions),
// and a four-tab body (trade / orders / market / logs). Only the active tab's
// panels mount, so book/trades subscriptions and the chart chunk are deferred
// until their tab is first opened.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type ChartOverlays,
  type ChartPriceLine,
} from '@/features/symbol/components/symbol-candle-chart';
import { SymbolDisableBanner } from '@/features/symbol/components/symbol-disable-banner';
import { SymbolEntryBlocker } from '@/features/symbol/components/symbol-entry-blocker';
import { SymbolProtectiveStopBlocker } from '@/features/symbol/components/symbol-protective-stop-blocker';
import { SymbolPositionStrip } from '@/features/symbol/components/symbol-position-strip';
import { SymbolStatsStrip } from '@/features/symbol/components/symbol-stats-strip';
import { SymbolTickChips } from '@/features/symbol/components/symbol-tick-chips';
import { SymbolSwitcher } from '@/features/symbol/components/symbol-switcher';
import {
  fetchProfileDashboard,
  profileDashboardQueryKey,
} from '@/features/profile/api/profile-dashboard';
import { isRawShape, orderPrice, orderQty } from '@/features/symbol/lib/order-raw';
import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { FormActions } from '@/shared/components/form-actions';
import { BackLink } from '@/shared/components/page';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import { useProfileSocketHandlers, type SocketFrame } from '@/features/profile/socket';
import { errorMessage } from '@/shared/lib/api';
import { formatAmount, formatPrice } from '@/shared/lib/format';
import { fetchExchangeInfo } from '@/features/symbol/api/exchange-info';
import { getStrategyView } from '@/features/symbol/strategies/registry';
import { usePreviewModel } from '@/features/symbol/preview/use-preview-model';
import { deriveChartLines } from '@/features/symbol/preview/preview-chart-lines';
import { queryDefaults } from '@/shared/lib/query-client';
import {
  cancelOrder,
  fetchSymbolCandles,
  fetchSymbolState,
  intervalSpanMs,
  symbolCandleBucketMs,
  symbolCandlesQueryKey,
  symbolLogsQueryKey,
  symbolStateQueryKey,
  symbolTickerQuery,
  SYMBOL_CANDLE_INTERVAL,
  type CandleInterval,
} from '@/features/symbol/api/symbol';
import { buildProfileWsUrl } from '@/shared/lib/ws';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { cn } from '@/shared/lib/cn';

import type {
  CandleList,
  OrderResponse,
  SymbolLogEntry,
  SymbolStateResponse,
} from '@app/contracts';

// Per-tab bodies are lazy so each tab's chunk (and its socket subscriptions,
// for market) loads only when that tab first activates.
const WorkspaceTradeTab = lazy(() =>
  import('@/features/symbol/components/symbol-workspace-trade').then((m) => ({
    default: m.WorkspaceTradeTab,
  })),
);
const WorkspaceOrdersTab = lazy(() =>
  import('@/features/symbol/components/symbol-workspace-orders').then((m) => ({
    default: m.WorkspaceOrdersTab,
  })),
);
const WorkspaceMarketTab = lazy(() =>
  import('@/features/symbol/components/symbol-workspace-market').then((m) => ({
    default: m.WorkspaceMarketTab,
  })),
);
const WorkspaceLogsTab = lazy(() =>
  import('@/features/symbol/components/symbol-workspace-logs').then((m) => ({
    default: m.WorkspaceLogsTab,
  })),
);

export type WorkspaceTab = 'trade' | 'orders' | 'market' | 'logs';
const TABS: readonly { id: WorkspaceTab; label: string }[] = [
  { id: 'trade', label: 'Trade' },
  { id: 'orders', label: 'Orders' },
  { id: 'market', label: 'Market' },
  { id: 'logs', label: 'Logs' },
];

/**
 * Workspace entry point. Keying the inner subtree by profile+symbol forces a
 * full remount on a symbol swap, which gives a clean query/socket teardown for
 * the old symbol and a fresh mount for the new one.
 */
export function SymbolWorkspace({
  profileId,
  symbol,
  tab,
}: {
  profileId: string;
  symbol: string;
  tab: WorkspaceTab;
}): React.JSX.Element {
  return (
    <SymbolWorkspaceInner
      key={`${profileId}:${symbol}`}
      profileId={profileId}
      symbol={symbol}
      activeTab={tab}
    />
  );
}

function SymbolWorkspaceInner({
  profileId,
  symbol,
  activeTab,
}: {
  profileId: string;
  symbol: string;
  activeTab: WorkspaceTab;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const routeNavigate = useNavigate();
  const accountId = useActiveAccountId() ?? '';
  const queryKey = symbolStateQueryKey(profileId, symbol);

  const state = useQuery({
    queryKey,
    queryFn: () => fetchSymbolState(profileId, symbol),
  });

  // Operator-selected candle interval (Binance-style tabs). Local state —
  // switching it re-keys the candles query below and refetches.
  const [chartInterval, setChartInterval] = useState<CandleInterval>(SYMBOL_CANDLE_INTERVAL);

  // Compute the candle bucket once per render and pass the same value to both
  // the query key and the request URL. Without this, render and execution can
  // straddle an interval boundary and the freshly fetched window would be
  // cached under the previous bucket's key, forcing an immediate refetch.
  const candleBucketMs = symbolCandleBucketMs(chartInterval);
  const candles = useQuery({
    queryKey: symbolCandlesQueryKey(profileId, symbol, chartInterval, candleBucketMs),
    queryFn: () =>
      fetchSymbolCandles(profileId, symbol, {
        interval: chartInterval,
        now: new Date(candleBucketMs),
      }),
    // The window is immutable within a bucket — a new bucket re-keys the query
    // anyway — so it stays fresh for the full interval span.
    staleTime: intervalSpanMs(chartInterval),
    // Keep the prior bucket's bars on screen while the next bucket fetches.
    // Without this, every interval boundary (each minute on 1m) re-keys the
    // query to `data: undefined` / `isLoading: true`, which swaps ChartBody to
    // the loading skeleton and unmounts the whole chart canvas — a visible
    // flicker once a window — and empties the `markPrice` fallback mid-refetch.
    placeholderData: keepPreviousData,
  });

  const exchangeInfo = useQuery({
    ...queryDefaults.exchangeInfo(),
    queryFn: fetchExchangeInfo,
  });
  const filterTickSize: string | null =
    exchangeInfo.data?.symbols.find((s) => s.symbol === symbol)?.filterTickSize ?? null;

  // Resolve the strategy's view module by name; an unknown strategy gets the
  // generic fallback. getStrategyView returns a stable object per name.
  const view = getStrategyView(state.data?.strategy.name ?? '');
  // Operator actions this profile's strategy honors. The action panels gate off
  // this set so a control whose write the strategy would silently drop never
  // renders. Empty until state loads.
  const operatorActions = new Set<string>(state.data?.strategy.operatorActions ?? []);
  // The one "what is it worth right now" for this screen: unrealised P/L, the
  // order panels' distance-to-price, and the ladder projection when flat.
  //
  // Ticker first, because that is the price the stats strip renders at the top
  // of this same header — marking P/L against anything else contradicts a number
  // the operator is looking at. The candle close is only the fallback until the
  // ticker resolves: on a 1h chart it can be most of an hour old.
  //
  // Gated on `isSuccess`, the same predicate the strip renders on, NOT on
  // `data != null`: a ticker that fails after one success keeps its last good
  // `data` while the strip switches to "24h stats unavailable", which would go
  // straight back to marking P/L at a price the header is no longer showing.
  const ticker = useQuery(symbolTickerQuery(profileId, symbol));
  const markPrice = ticker.isSuccess ? ticker.data.lastPrice : lastClosePrice(candles.data ?? []);
  // The chart's ladder lines come from the strategy's PreviewModel (its lazy
  // preview module), so any strategy draws its levels with no bespoke web code.
  // Held: project off the real avg entry; flat: off the live price.
  const strategyName = state.data?.strategy.name ?? '';
  const entryPrice = state.data?.avgEntryPrice?.avgEntryPrice ?? markPrice;
  const { model: previewModel } = usePreviewModel({
    strategyName,
    profileId,
    symbol,
    config: (state.data?.strategy.config ?? {}) as Record<string, unknown>,
    state: state.data?.strategy.state ?? null,
    entryPrice,
    currentPrice: markPrice,
  });
  const previewLines = useMemo(() => deriveChartLines(previewModel), [previewModel]);
  const overlays = useMemo(
    () => deriveOverlays(state.data, previewLines),
    [state.data, previewLines],
  );

  const [confirming, setConfirming] = useState<OrderResponse | null>(null);
  const [banner, setBanner] = useState<ActionBannerState | null>(null);

  // Latest WS `logs` frame, surfaced to the logs tab. Carried across renders
  // rather than mutating panel state from the hook so the panel owns its
  // bounded ring buffer without leaking into workspace state.
  const [liveLog, setLiveLog] = useState<SymbolLogEntry | null>(null);

  // Coalesce bursts of WS frames (symbol-state / orders fire many times per
  // second during a fill or grid-buy cascade) into a single trailing refetch.
  // Without this, an open-fill burst can flood the browser connection pool with
  // `/state` requests. 200ms is short enough to feel real-time while collapsing
  // same-frame bursts.
  const stateInvalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleStateInvalidate = useCallback((): void => {
    if (stateInvalidateTimer.current !== null) return;
    stateInvalidateTimer.current = setTimeout(() => {
      stateInvalidateTimer.current = null;
      void queryClient.invalidateQueries({ queryKey });
    }, 200);
  }, [queryClient, queryKey]);
  // Cancel a pending timer on unmount so a debounce queued under this symbol
  // does not fire an invalidate after teardown.
  useEffect(
    () => () => {
      if (stateInvalidateTimer.current !== null) {
        clearTimeout(stateInvalidateTimer.current);
        stateInvalidateTimer.current = null;
      }
    },
    [profileId, symbol],
  );

  const handleFrame = useCallback(
    (frame: SocketFrame): void => {
      if (frame.topic === 'symbol-state' || frame.topic === 'orders') {
        scheduleStateInvalidate();
        return;
      }
      if (frame.topic === 'logs') {
        const payload = frame.payload;
        // Normalise the contract's ISO `ts` through `new Date()` so the panel
        // de-dups cleanly against REST rows; fall back to client wall-clock
        // only when the field is absent.
        const time = frame.ts ? new Date(frame.ts).toISOString() : new Date().toISOString();
        setLiveLog({
          time,
          symbol: payload.symbol,
          level: payload.level,
          msg: payload.msg,
          ctx: payload.ctx,
        });
      }
    },
    [scheduleStateInvalidate],
  );

  const onResyncRequired = useCallback((): void => {
    // The logs panel maintains its own bounded ring fed by REST + WS, so a gap
    // notice has to invalidate both keys.
    void queryClient.invalidateQueries({ queryKey });
    void queryClient.invalidateQueries({ queryKey: symbolLogsQueryKey(profileId, symbol) });
  }, [profileId, queryClient, queryKey, symbol]);

  // Handlers-only: the workspace reacts to frames (debounced query invalidation)
  // but never renders connection state, so it must not subscribe to the snapshot
  // store or run the liveness ticker — both would re-render this whole subtree on
  // every frame and once a second for a value it never reads.
  useProfileSocketHandlers({
    profileId,
    url: (since) => buildProfileWsUrl(accountId, profileId, since),
    onMessage: handleFrame,
    onResyncRequired,
  });

  const cancel = useMutation({
    mutationFn: (orderId: string) => cancelOrder(profileId, symbol, { orderId }),
    onSuccess: async () => {
      setBanner({ kind: 'ok', message: 'Cancel scheduled.' });
      setConfirming(null);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => {
      // Close the confirm dialog on error so the banner is visible — leaving it
      // open hides a real 4xx (already-cancelled, rate-limited) behind the modal.
      setConfirming(null);
      setBanner({ kind: 'err', message: errorMessage(err) });
    },
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="symbol-workspace">
      <WorkspaceHeader
        profileId={profileId}
        symbol={symbol}
        state={state}
        currentPrice={markPrice}
      />

      <nav
        className="border-border bg-border flex shrink-0 gap-px border-b"
        aria-label="Workspace sections"
      >
        {TABS.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              data-testid={`workspace-tab-${tab.id}`}
              aria-current={active ? 'page' : undefined}
              onClick={() =>
                void routeNavigate({
                  to: '/accounts/$accountId/profiles/$profileId/symbols/$symbol',
                  params: { accountId, profileId, symbol },
                  search: { tab: tab.id },
                })
              }
              className={cn(
                'focus-visible:ring-focus flex-1 px-3 py-2 text-xs font-semibold uppercase tracking-wider focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
                active ? 'bg-bg text-fg' : 'bg-bg-elevated text-muted-fg hover:text-fg',
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      {/* Natural height, not flex-1: the outer pane owns the scroll, so the tab
          content flows at its own height. A bounded flex-1 box here would clip
          tall content. */}
      <div className="space-y-4 p-4">
        <Suspense fallback={<p className="text-muted-fg text-sm">Loading…</p>}>
          {activeTab === 'trade' ? (
            <WorkspaceTradeTab
              profileId={profileId}
              symbol={symbol}
              candles={candles.data}
              candlesLoading={candles.isLoading}
              candlesError={candles.error}
              overlays={overlays}
              filterTickSize={filterTickSize}
              interval={chartInterval}
              onIntervalChange={setChartInterval}
              state={state.data}
              stateLoading={state.isLoading}
              currentPrice={markPrice}
              view={view}
              operatorActions={operatorActions}
              onSymbolWiped={() => void routeNavigate({ to: '/' })}
            />
          ) : null}
          {activeTab === 'orders' ? (
            <WorkspaceOrdersTab
              profileId={profileId}
              symbol={symbol}
              state={state.data}
              currentPrice={markPrice}
              view={view}
              onCancel={(o) => setConfirming(o)}
            />
          ) : null}
          {activeTab === 'market' ? (
            <WorkspaceMarketTab
              profileId={profileId}
              symbol={symbol}
              lastPrice={markPrice}
              operatorActions={operatorActions}
              // undefined until state loads so the discovery panel does not show
              // a "holding" headline against a not-yet-known position.
              flat={
                state.isSuccess
                  ? state.data.avgEntryPrice === null && state.data.openOrders.length === 0
                  : undefined
              }
            />
          ) : null}
          {activeTab === 'logs' ? (
            <WorkspaceLogsTab
              profileId={profileId}
              symbol={symbol}
              liveLog={liveLog}
              operatorActions={operatorActions}
              onWiped={() => void routeNavigate({ to: '/' })}
            />
          ) : null}
        </Suspense>
      </div>

      <ActionBanner banner={banner} />

      <Dialog open={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel order?</DialogTitle>
            <DialogDescription>
              {confirming
                ? `${confirming.side} ${confirming.symbol} qty ${formatAmount(orderQty(confirming))} @ ${formatPrice(orderPrice(confirming))}. Cancellation is scheduled — fill confirmation arrives over WS.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <FormActions>
            <Button type="button" variant="ghost" onClick={() => setConfirming(null)}>
              Keep open
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={cancel.isPending}
              onClick={() => {
                if (confirming) cancel.mutate(confirming.id);
              }}
            >
              {cancel.isPending ? 'Cancelling…' : 'Confirm cancel'}
            </Button>
          </FormActions>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Always-visible workspace header. Carries the symbol identity, the switcher,
 * the Tier-1 "why is/isn't it trading" cluster (stats, ticks, entry blocker, and
 * the paused-state banner), and the symbol-scoped navigation (config drawer /
 * backtest) plus a close button. The pause-initiate form lives at the
 * foot of the workspace, not here — it is a rare action.
 */
function WorkspaceHeader({
  profileId,
  symbol,
  state,
  currentPrice,
}: {
  profileId: string;
  symbol: string;
  state: ReturnType<typeof useQuery<SymbolStateResponse>>;
  currentPrice: string | null;
}): React.JSX.Element {
  // The SymbolSwitcher already shows the current symbol when the profile has
  // ≥2 symbols, so a sibling <h1> would render the symbol twice. Read the same
  // cached dashboard query the switcher uses to know when it will render, and
  // keep the <h1> for the heading/a11y tree but visually hidden in that case.
  const accountId = useActiveAccountId() ?? '';
  const dashboard = useQuery({
    queryKey: profileDashboardQueryKey(profileId),
    queryFn: () => fetchProfileDashboard(profileId),
    staleTime: 5_000,
  });
  const symbols = dashboard.data?.symbols ?? [];
  const switcherShown = symbols.length >= 2 && symbols.some((s) => s.symbol === symbol);
  return (
    <header className="border-border bg-bg-elevated shrink-0 space-y-3 border-b p-4">
      {/* Back, not a close X: the workspace is a page under a profile, not a
          modal over the overview. The X dropped the operator at the account
          root, losing the profile they were working in. */}
      <BackLink to="/accounts/$accountId/profiles/$profileId" params={{ accountId, profileId }} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className={switcherShown ? 'sr-only' : 'text-fg text-xl font-semibold'}>{symbol}</h1>
          <SymbolSwitcher profileId={profileId} symbol={symbol} />
        </div>
        <nav className="flex flex-wrap items-center gap-1">
          {/* Config opens the symbol-config drawer over the workspace; `sym` is
              already set (the workspace is open), so only `edit` is added. The
              three nav links wear the shared outline-button treatment so they read
              as bordered buttons matching the profile header (Enabled / Manage
              profile), keeping one control family across the app. */}
          <Button asChild variant="outline" size="sm">
            <Link
              to="/accounts/$accountId/profiles/$profileId/symbols/$symbol/config"
              params={{ accountId, profileId, symbol }}
              data-testid="symbol-config-open"
            >
              Config
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link
              to="/accounts/$accountId/profiles/$profileId/backtest"
              params={{ accountId, profileId }}
              // Land on the Configure tab, not the auto-anchored latest result:
              // the operator clicked Backtest to test THIS symbol's config.
              search={{ symbol, view: 'configure' }}
            >
              Backtest
            </Link>
          </Button>
        </nav>
      </div>

      <SymbolStatsStrip profileId={profileId} symbol={symbol} />
      {state.isSuccess ? (
        <SymbolPositionStrip state={state.data} currentPrice={currentPrice} symbol={symbol} />
      ) : null}
      <SymbolTickChips profileId={profileId} />

      {state.error ? (
        <Alert variant="danger">
          <AlertTitle>Failed to load symbol</AlertTitle>
          <AlertDescription>
            {state.error instanceof Error ? state.error.message : 'unknown'}
          </AlertDescription>
        </Alert>
      ) : null}

      {state.isSuccess && state.data.disable ? (
        <SymbolDisableBanner profileId={profileId} symbol={symbol} disable={state.data.disable} />
      ) : null}

      {state.isSuccess && state.data.protectiveStopBlocker ? (
        <SymbolProtectiveStopBlocker protectiveStopBlocker={state.data.protectiveStopBlocker} />
      ) : null}

      {state.isSuccess && state.data.entryBlocker ? (
        <SymbolEntryBlocker entryBlocker={state.data.entryBlocker} />
      ) : null}
    </header>
  );
}

function lastClosePrice(candles: CandleList): string | null {
  return candles.length > 0 ? (candles[candles.length - 1]?.close ?? null) : null;
}

// Display-only chart overlay positions; never feeds an order. apps/web is
// barred from decimal.js, and any operator action that places an order goes
// through manual-orders / strategy code where math is done in Decimal upstream.
// `strategyLines` are the strategy's PreviewModel-derived ladder lines. The
// ENTRY line and the markers are strategy-agnostic.
export function deriveOverlays(
  state: SymbolStateResponse | undefined,
  strategyLines: readonly ChartPriceLine[],
): ChartOverlays {
  if (!state) return {};

  const buyMarkers: { time: string; price: string }[] = [];
  const sellMarkers: { time: string; price: string }[] = [];
  for (const o of state.openOrders) {
    const price = isRawShape(o.raw) ? o.raw.price : undefined;
    if (!price) continue;
    if (o.side === 'BUY') buyMarkers.push({ time: o.createdAt, price });
    else sellMarkers.push({ time: o.createdAt, price });
  }

  // ENTRY (average cost basis) is generic — drawn for any strategy that reports
  // a position; the strategy's own ladder lines sit on top.
  const priceLines: ChartPriceLine[] = [];
  const entry = state.avgEntryPrice?.avgEntryPrice;
  if (entry) priceLines.push({ price: entry, label: 'ENTRY', tone: 'entry' });
  priceLines.push(...strategyLines);

  return { priceLines, buyMarkers, sellMarkers };
}
