// The symbol WORKSPACE route: /profiles/$profileId/symbols/$symbol.
//
// It is a tabbed page (trade / orders / market / logs), defaulting to the trade
// tab; switching tabs writes `?tab=` on the route. Back goes up one level, to
// the profile that owns the symbol.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetChartLoader,
  __setChartLoader,
  type ChartModule,
} from '@/features/symbol/components/symbol-candle-chart';
import { createQueryClient } from '@/shared/lib/query-client';
import { rootRoute } from '@/app/__root';
import { accountScopeRoute } from '@/features/account/routes/account-scope';
import {
  profileDetailIndexRoute,
  profileDetailRoute,
} from '@/features/profile/routes/profiles.$profileId';
import { symbolDetailRoute } from '@/features/symbol/routes/profiles.$profileId.symbols.$symbol';
import { symbolStateQueryKey } from '@/features/symbol/api/symbol';

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const TEST_ACCOUNT = {
  id: ACCOUNT_ID,
  name: 'Main',
  binanceMode: 'test' as const,
  apiKeyConfigured: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

// `<uuid>:<SYMBOL>` — the workspace selector. The uuid here is the profileId the
// dashboard-aggregate row and the per-symbol fetch mocks below are all keyed to.
// It must be a contract-valid UUID: the home fetches `/dashboard-aggregate` over
// the mocked fetch and runs it through `DashboardAggregateResponse`, whose
// `profileId` is `z.uuid()` — a non-UUID id fails the response parse and the
// home renders an error card instead of the workspace under test.
const PROFILE_ID = '00000000-0000-4000-8000-00000000d101';

// lightweight-charts stub — the trade tab renders the candle chart, which lazily
// imports the real charting lib. Reused verbatim from symbol-detail-route.test.
const setData = vi.fn();
let priceLineSeq = 0;
const createPriceLine = vi.fn(() => ({ id: priceLineSeq++ }));
const removePriceLine = vi.fn();
const remove = vi.fn();
const subscribeCrosshairMove = vi.fn();
const addSeries = vi.fn(() => ({ setData, createPriceLine, removePriceLine }));
const createChart = vi.fn(() => ({ addSeries, subscribeCrosshairMove, remove }));
const setMarkers = vi.fn();
const createSeriesMarkers = vi.fn(() => ({ setMarkers }));
const chartModuleStub: ChartModule = {
  createChart: createChart as unknown as ChartModule['createChart'],
  CandlestickSeries: { id: 'candlestick' },
  createSeriesMarkers,
};
const loadStub = vi.fn(() => Promise.resolve(chartModuleStub));

beforeEach(() => {
  __setChartLoader(loadStub);
});

type Json = unknown;

const json = (body: Json, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const stub = (path: string) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => null });

// One held profile so the dashboard renders its layout (HomePage shows a
// loading state until the aggregate resolves and the empty-state when the list
// is empty). profileId matches the workspace path so the rail keeps it visible.
const aggregate = {
  profiles: [
    {
      profileId: PROFILE_ID,
      name: 'Main',
      enabled: true,
      binanceMode: 'live' as const,
      lastTickAt: '2026-05-10T05:00:00.000Z',
      lastTickLatencyMs: 120,
      apiKeyConfigured: true,
      lastTickError: null,
      killSwitch: false,
      openOrderCount: 0,
      openPositionCount: 0,
      positions: [],
    },
  ],
};

const sampleState = {
  strategy: {
    name: 'trailing-trade',
    operatorActions: [
      'manual-order',
      'trigger-buy',
      'trigger-sell',
      'avg-entry-price',
      'archive-grid',
      'reset-grid',
    ],
    config: {
      buy: {
        gridLevels: [{ triggerPercentage: '1.0', maxPurchaseAmount: '50' }],
      },
    },
    state: { currentGridTradeIndex: null },
  },
  avgEntryPrice: null,
  openOrders: [],
  disable: null,
  entryBlocker: null,
};

const symbolBase = `/profiles/${PROFILE_ID}/symbols/BTCUSDT`;
const candlesRouteRe = new RegExp(`${symbolBase}/candles(\\?|$)`);

// Per-test overrides for the three responses the mark-price case varies. Reset
// in afterEach, so every other test still runs against the flat defaults.
let stateResponse: Json = sampleState;
let candlesResponse: Json = [];
let tickerResponse: Json | null = null;

// Serves the dashboard rollup plus the per-symbol surfaces the workspace reads.
const responder = (url: string): Response => {
  if (url.endsWith('/dashboard-aggregate')) return json(aggregate);
  if (url.endsWith(`${symbolBase}/state`)) return json(stateResponse);
  // Unset falls through to the 404 below, which is what every test that does not
  // care about the ticker wants: the workspace degrades to the candle close.
  if (tickerResponse != null && url.endsWith(`${symbolBase}/ticker`)) return json(tickerResponse);
  if (candlesRouteRe.test(url)) return json(candlesResponse);
  if (url.endsWith('/exchange-info'))
    return json({
      symbols: [
        {
          symbol: 'BTCUSDT',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          status: 'TRADING',
          filterTickSize: '0.01000000',
        },
      ],
      fetchedAt: '2026-05-10T00:00:00.000Z',
      technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy' },
    });
  return new Response('not found', { status: 404 });
};

// Mounts the REAL workspace route at the given URL so the test proves the
// route → workspace integration, not an isolated component.
const mountWorkspace = (path: string) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
  queryClient.setQueryData(['accounts'], [TEST_ACCOUNT]);
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      stub('/'),
      stub('/onboarding'),
      stub('/login'),
      accountScopeRoute.addChildren([
        // The Back control targets the profile detail page, so its index route
        // must exist in the tree for the navigation to resolve.
        profileDetailRoute.addChildren([profileDetailIndexRoute, symbolDetailRoute]),
      ]),
    ]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return { router, queryClient };
};

const WORKSPACE_PATH = `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/symbols/BTCUSDT`;

afterEach(() => {
  stateResponse = sampleState;
  candlesResponse = [];
  tickerResponse = null;
  vi.unstubAllGlobals();
  __resetChartLoader();
  loadStub.mockClear();
  createChart.mockClear();
  addSeries.mockClear();
  setData.mockClear();
  createPriceLine.mockClear();
  removePriceLine.mockClear();
  subscribeCrosshairMove.mockClear();
  createSeriesMarkers.mockClear();
  setMarkers.mockClear();
  remove.mockClear();
  priceLineSeq = 0;
});

describe('symbol workspace route', () => {
  it('renders the workspace tab bar with the trade tab active', async () => {
    mountWorkspace(WORKSPACE_PATH);

    // The four-tab bar replaces the slice-1 placeholder. Trade is the default.
    // `findBy*` waits inherit the 10 s RTL asyncUtilTimeout from setup.ts; a
    // shorter local override flakes on the oversubscribed CI runner, where the
    // lightweight-charts canvas can take >5 s to mount.
    expect(await screen.findByTestId('workspace-tab-trade')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-tab-orders')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-tab-market')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-tab-logs')).toBeInTheDocument();
    // A trade-tab surface is shown by default — the candle chart lives here.
    expect(await screen.findByTestId('symbol-candle-chart')).toBeInTheDocument();
  });

  it('marks unrealised P/L at the price the stats strip shows, not the last candle close', async () => {
    // The header renders a live 24h "Last price" and, directly beneath it, the
    // position's unrealised P/L. Marking that P/L against the last CANDLE close
    // instead put a number on screen that the price above it could not produce —
    // and on a 1h chart the close is up to an hour stale, so the two drifted far
    // apart. Both must come from one source.
    //
    // The two marks are set far apart so the assertion cannot pass by accident:
    // at the ticker price the position is +200, at the candle close it is −1800.
    tickerResponse = {
      symbol: 'BTCUSDT',
      lastPrice: '2000.00',
      priceChange: '100.00',
      priceChangePercent: '5.26',
      highPrice: '2010.00',
      lowPrice: '950.00',
      openPrice: '1900.00',
      volume: '12.5',
      quoteVolume: '24000.00',
    };
    candlesResponse = [
      {
        time: '2026-05-10T04:00:00.000Z',
        open: '1000.00',
        high: '1010.00',
        low: '990.00',
        close: '1000.00',
        volume: '3.5',
      },
    ];
    stateResponse = {
      ...sampleState,
      avgEntryPrice: {
        avgEntryPrice: '1900.00',
        quantity: '2',
        updatedAt: '2026-05-10T04:30:00.000Z',
      },
    };

    mountWorkspace(WORKSPACE_PATH);

    const strip = await screen.findByTestId('symbol-position-strip');
    await waitFor(() => expect(within(strip).getByText(/200/)).toBeInTheDocument());
    // The header's own price agrees, and the candle-close mark is nowhere.
    expect(await screen.findByTestId('symbol-last-price')).toHaveTextContent('2,000.00');
    expect(within(strip).queryByText(/1,800/)).toBeNull();
  });

  it('renders pause and stop-tracking on the trade tab', async () => {
    mountWorkspace(WORKSPACE_PATH);

    // Pause and stop-tracking were relocated out of the always-on footer into the
    // trade-tab rail beneath Force trigger; both surface here by default.
    expect(await screen.findByTestId('symbol-pause-panel')).toBeInTheDocument();
    expect(screen.getByTestId('symbol-stop-tracking-panel')).toBeInTheDocument();
    expect(screen.getByTestId('symbol-cancel-override-panel')).toBeInTheDocument();
  });

  it('does not render pause or stop-tracking off the trade tab', async () => {
    mountWorkspace(`${WORKSPACE_PATH}?tab=orders`);

    await waitFor(() =>
      expect(screen.getByTestId('workspace-tab-orders')).toHaveAttribute('aria-current', 'page'),
    );
    // They live in the trade tab now, so the orders tab must not show them.
    expect(screen.queryByTestId('symbol-pause-panel')).toBeNull();
    expect(screen.queryByTestId('symbol-stop-tracking-panel')).toBeNull();
    expect(screen.queryByTestId('symbol-cancel-override-panel')).toBeNull();
  });

  it('switching to the orders tab sets ?tab=orders on the route', async () => {
    const { router } = mountWorkspace(WORKSPACE_PATH);

    await userEvent.click(await screen.findByTestId('workspace-tab-orders'));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(WORKSPACE_PATH);
      const search = router.state.location.search as Record<string, unknown>;
      expect(search.tab).toBe('orders');
    });
  });

  it('does not load the chart chunk on a non-trade tab', async () => {
    mountWorkspace(`${WORKSPACE_PATH}?tab=orders`);

    // Wait for the workspace to settle on the orders tab, then prove the chart
    // loader was never invoked — the chart chunk is deferred until TRADE.
    await waitFor(() =>
      expect(screen.getByTestId('workspace-tab-orders')).toHaveAttribute('aria-current', 'page'),
    );
    expect(loadStub).not.toHaveBeenCalled();
  });

  it('renders a Back control that returns to the owning profile', async () => {
    const { router } = mountWorkspace(WORKSPACE_PATH);

    // The workspace is a page under a profile, not a modal over the overview.
    // A bare X dumped the operator at the account root, losing the profile they
    // were working in; Back goes up exactly one level.
    expect(screen.queryByTestId('workspace-close')).toBeNull();
    // Exact name, scoped to the workspace: a substring match would also hit the
    // workspace's own "Backtest" link and the shell sidebar's "Backup & restore".
    const workspace = await screen.findByTestId('symbol-workspace');
    await userEvent.click(await within(workspace).findByRole('link', { name: 'Back' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}`);
    });
  });

  it('clears the A-symbol debounce on swap+close, leaking no post-teardown invalidate', async () => {
    // Swapping symbols remounts the inner subtree (keyed by profile+symbol) and
    // leaving the workspace unmounts it. The unmount cleanup must clear any
    // pending 200ms state-invalidate debounce for symbol A, or it would fire an
    // invalidate after teardown. Spy on the prototype so we catch the call
    // regardless of which QueryClient instance the workspace holds.
    const keyA = symbolStateQueryKey(PROFILE_ID, 'BTCUSDT');
    const invalidateSpy = vi.spyOn(QueryClient.prototype, 'invalidateQueries');

    const { router } = mountWorkspace(WORKSPACE_PATH);
    await screen.findByTestId('workspace-tab-trade');

    // Swap to B (remounts A's subtree away) then leave (unmounts B). Both are the
    // router pushes the switcher / close button would issue.
    await router.navigate({
      to: '/accounts/$accountId/profiles/$profileId/symbols/$symbol',
      params: { accountId: ACCOUNT_ID, profileId: PROFILE_ID, symbol: 'ETHUSDT' },
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/symbols/ETHUSDT`,
      );
    });
    await router.navigate({ to: '/' });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });

    // Past the 200ms debounce window: a leaked A-side timer would fire here.
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(300);
    } finally {
      vi.useRealTimers();
    }

    const firedForA = invalidateSpy.mock.calls.some(([arg]) => {
      const queryKey = (arg as { queryKey?: readonly unknown[] } | undefined)?.queryKey;
      return (
        Array.isArray(queryKey) &&
        queryKey.length === keyA.length &&
        queryKey.every((v, i) => v === keyA[i])
      );
    });
    expect(firedForA).toBe(false);
    invalidateSpy.mockRestore();
  });

  // --- Emergency actions grouped into a collapsed disclosure (#659 C1/C6) ----

  it('groups the emergency actions into a collapsed disclosure on the trade tab', async () => {
    mountWorkspace(WORKSPACE_PATH);

    // The rare, deliberate write actions (force trigger / pause / stop tracking)
    // move out of always-visible rail Cards into ONE collapsible Panel at the
    // bottom, collapsed by default so the trade tab opens calm. `findBy*` inherits
    // the 10 s asyncUtilTimeout from setup.ts (this file is a chronic CI flake).
    const stop = await screen.findByTestId('symbol-stop-tracking-panel');
    const details = stop.closest('details');
    expect(details).not.toBeNull();
    // Collapsed on first paint: the disclosure must NOT carry `open`.
    expect(details).not.toHaveAttribute('open');
    // Pause shares the same disclosure — one group, not one-per-action.
    expect(screen.getByTestId('symbol-pause-panel').closest('details')).toBe(details);
    // Shares the disclosure and is NOT gated on the strategy's trigger actions: a
    // queued override can exist where no force button is shown.
    expect(screen.getByTestId('symbol-cancel-override-panel').closest('details')).toBe(details);
  });

  it('keeps the collapsed emergency actions mounted with a focusable summary', async () => {
    mountWorkspace(WORKSPACE_PATH);

    // <details> keeps its children mounted while collapsed, so the actions stay in
    // the DOM (query state / mutation guards survive) and the toggle is a real,
    // keyboard-focusable <summary>.
    const stop = await screen.findByTestId('symbol-stop-tracking-panel');
    expect(stop).toBeInTheDocument();
    const details = stop.closest('details');
    expect(details).not.toBeNull();
    const summary = details?.querySelector('summary') ?? null;
    expect(summary).not.toBeNull();
    expect(summary?.tagName).toBe('SUMMARY');
  });

  it('points the Backtest link at the Configure view (#659 C2)', async () => {
    mountWorkspace(WORKSPACE_PATH);

    // The header Backtest link must open the backtest Configure tab, not Results,
    // by carrying `view=configure` in its search alongside the symbol. Scope to the
    // workspace so the exact "Backtest" name doesn't collide with the shell nav.
    const workspace = await screen.findByTestId('symbol-workspace');
    const link = within(workspace).getByRole('link', { name: 'Backtest' });
    const href = link.getAttribute('href') ?? '';
    expect(href).toContain('/backtest');
    expect(href).toContain('view=configure');
  });
});
