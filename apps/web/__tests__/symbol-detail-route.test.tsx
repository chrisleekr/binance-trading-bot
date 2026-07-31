// The per-symbol surface is a real route (`/profiles/:id/symbols/:SYMBOL`).
// These tests mount `SymbolWorkspace` on that route and assert the panels render
// in their tabs. Each test selects the tab whose panels it asserts via the `tab`
// prop (the route's `?tab` search); the default tab is `trade`. The grid ladder
// and open-orders live on the orders tab; the chart and operator-action panels
// on the trade tab.

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
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
import { SymbolWorkspace } from '@/features/symbol/components/symbol-workspace';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
  Toaster: () => null,
}));

const PROFILE_ID = '00000000-0000-4000-8000-00000000aa01';

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

const empty = (status = 204): Response => new Response(null, { status });

const sampleOrder = {
  id: '00000000-0000-4000-8000-000000000001',
  symbol: 'BTCUSDT',
  side: 'BUY' as const,
  intent: 'grid-buy' as const,
  binanceOrderId: '12345',
  clientOrderId: 'cli-1',
  status: 'PARTIALLY_FILLED',
  currentGridTradeIndex: 0,
  raw: { origQty: '0.0010', price: '49500.00' },
  createdAt: '2026-05-10T05:00:00.000Z',
  updatedAt: '2026-05-10T05:00:01.000Z',
  closedAt: null,
};

// Trailing-trade config + state. currentGridTradeIndex 0 = entry (rung 0)
// reached, rungs 1 and 2 still pending — the route derives the ladder and the
// per-rung `reached` flags from these.
// Full trailing-trade operator-action surface — the route gates its
// Manual/Force/Technicals panels and the advanced-drawer grid actions off this.
const TT_OPERATOR_ACTIONS = [
  'manual-order',
  'trigger-buy',
  'trigger-sell',
  'avg-entry-price',
  'archive-grid',
  'reset-grid',
];

const sampleState = {
  strategy: {
    name: 'trailing-trade',
    operatorActions: TT_OPERATOR_ACTIONS,
    config: {
      buy: {
        gridLevels: [
          { triggerPercentage: '1.0', maxPurchaseAmount: '50' },
          { triggerPercentage: '0.98', maxPurchaseAmount: '50' },
          { triggerPercentage: '0.95', maxPurchaseAmount: '50' },
        ],
      },
    },
    state: { currentGridTradeIndex: 0 },
  },
  avgEntryPrice: null,
  openOrders: [sampleOrder],
  disable: null,
  entryBlocker: null,
};

const sampleCandles = [
  {
    time: '2026-05-10T05:00:00.000Z',
    open: '50000.00',
    high: '50100.00',
    low: '49900.00',
    close: '50050.00',
    volume: '1.0',
  },
  {
    time: '2026-05-10T05:01:00.000Z',
    open: '50050.00',
    high: '50200.00',
    low: '50000.00',
    close: '50150.00',
    volume: '1.5',
  },
];

const symbolBase = `/profiles/${PROFILE_ID}/symbols/BTCUSDT`;
const candlesRouteRe = new RegExp(`${symbolBase}/candles(\\?|$)`);

// Mounts the workspace on a minimal `/` index route. `tab` seeds the active tab
// (the workspace reads `?tab` and defaults to `trade`).
const mountWorkspace = (
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
  queryClient = createQueryClient(),
  tab?: 'trade' | 'orders' | 'market' | 'logs',
): { fetchMock: ReturnType<typeof vi.fn> } => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  const rootRoute = createRootRoute();
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null });
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/profiles/$profileId/symbols/$symbol',
    component: () => (
      <SymbolWorkspace profileId={PROFILE_ID} symbol="BTCUSDT" tab={tab ?? 'trade'} />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      stub('/'),
      workspaceRoute,
      stub('/profiles/$profileId/symbols/$symbol/config'),
    ]),
    context: { queryClient },
    history: createMemoryHistory({
      initialEntries: [`/profiles/${PROFILE_ID}/symbols/BTCUSDT`],
    }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return { fetchMock };
};

const setUp = (
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
  tab?: 'trade' | 'orders' | 'market' | 'logs',
): { fetchMock: ReturnType<typeof vi.fn> } => {
  return mountWorkspace(responder, createQueryClient(), tab);
};

afterEach(() => {
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

describe('symbol workspace (panels integration)', () => {
  it('renders the buy ladder, highlights the next-pending rung', async () => {
    setUp((url) => {
      if (url.endsWith('/profiles/00000000-0000-4000-8000-00000000aa01/symbols/BTCUSDT/state'))
        return json(sampleState);
      if (candlesRouteRe.test(url)) return json([]);
      return new Response('not found', { status: 404 });
    }, 'orders');

    const ladder = await screen.findByTestId('grid-buy-ladder', undefined, { timeout: 5000 });
    const rows = within(ladder).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    // Index 1 is the first not-yet-reached rung — that's the active one.
    expect(rows[1]).toHaveAttribute('aria-current', 'true');
    expect(rows[0]).not.toHaveAttribute('aria-current');
    // The workspace carries only symbol-scoped actions — the profile-wide tab
    // bar was removed. Config is always visible in the workspace header.
    expect(screen.queryByTestId('profile-sections-nav')).not.toBeInTheDocument();
    expect(screen.getByTestId('symbol-config-open')).toBeInTheDocument();
  });

  it('derives per-rung executed flags from the strategy currentGridTradeIndex', async () => {
    // currentGridTradeIndex 1 means rungs 0 and 1 are filled; rung 2 is the
    // first pending entry and must be the highlighted one.
    const stateAtRung1 = {
      ...sampleState,
      strategy: { ...sampleState.strategy, state: { currentGridTradeIndex: 1 } },
    };
    setUp((url) => {
      if (url.endsWith('/profiles/00000000-0000-4000-8000-00000000aa01/symbols/BTCUSDT/state'))
        return json(stateAtRung1);
      if (candlesRouteRe.test(url)) return json([]);
      return new Response('not found', { status: 404 });
    }, 'orders');

    const ladder = await screen.findByTestId('grid-buy-ladder', undefined, { timeout: 5000 });
    const rows = within(ladder).getAllByRole('listitem');
    expect(rows[2]).toHaveAttribute('aria-current', 'true');
    expect(rows[1]).not.toHaveAttribute('aria-current');
  });

  it('marks every rung pending and highlights rung 0 when the profile is flat', async () => {
    // currentGridTradeIndex null = no position held — the default state for a
    // fresh profile. Nothing is reached; rung 0 is the entry target.
    const stateFlat = {
      ...sampleState,
      strategy: { ...sampleState.strategy, state: { currentGridTradeIndex: null } },
    };
    setUp((url) => {
      if (url.endsWith('/profiles/00000000-0000-4000-8000-00000000aa01/symbols/BTCUSDT/state'))
        return json(stateFlat);
      if (candlesRouteRe.test(url)) return json([]);
      return new Response('not found', { status: 404 });
    }, 'orders');

    const ladder = await screen.findByTestId('grid-buy-ladder', undefined, { timeout: 5000 });
    const rows = within(ladder).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute('aria-current', 'true');
    for (const row of rows) expect(within(row).getByText(/pending/)).toBeInTheDocument();
  });

  it('shows the empty-grid message when the strategy config has no gridLevels', async () => {
    const stateNoGrid = {
      ...sampleState,
      strategy: { ...sampleState.strategy, config: { buy: { gridLevels: [] } } },
    };
    setUp((url) => {
      if (url.endsWith('/profiles/00000000-0000-4000-8000-00000000aa01/symbols/BTCUSDT/state'))
        return json(stateNoGrid);
      if (candlesRouteRe.test(url)) return json([]);
      return new Response('not found', { status: 404 });
    }, 'orders');

    const panel = await screen.findByTestId('grid-ladder-panel', undefined, { timeout: 5000 });
    expect(
      within(panel).getByText('No grid configured yet. Open Config above to set up a buy ladder.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('grid-buy-ladder')).not.toBeInTheDocument();
  });

  it('renders open orders with status badge and Cancel button', async () => {
    setUp((url) => {
      if (url.endsWith('/profiles/00000000-0000-4000-8000-00000000aa01/symbols/BTCUSDT/state'))
        return json(sampleState);
      if (candlesRouteRe.test(url)) return json([]);
      return new Response('not found', { status: 404 });
    }, 'orders');

    const panel = await screen.findByTestId('open-orders-panel', undefined, { timeout: 5000 });
    expect(within(panel).getByText('PARTIALLY_FILLED')).toBeInTheDocument();
    // qty uses `formatAmount` — strips the trailing zero from `0.0010` →
    // `0.001`. Price uses `formatPrice` — adds the thousands separator and
    // keeps a 2dp floor for values >= 1, so `49500.00` → `49,500.00`.
    expect(within(panel).getByText('qty 0.001')).toBeInTheDocument();
    expect(within(panel).getByText('@ 49,500.00')).toBeInTheDocument();
    expect(within(panel).getByTestId(`order-cancel-${sampleOrder.id}`)).toBeInTheDocument();
  });

  it('Cancel confirmation calls POST /cancel-order with the orderId', async () => {
    let cancelBody: unknown;
    mountWorkspace(
      (url, init) => {
        const method = init?.method ?? 'GET';
        if (
          url.endsWith('/profiles/00000000-0000-4000-8000-00000000aa01/symbols/BTCUSDT/state') &&
          method === 'GET'
        )
          return json(sampleState);
        if (candlesRouteRe.test(url) && method === 'GET') return json([]);
        if (
          url.endsWith(
            '/profiles/00000000-0000-4000-8000-00000000aa01/symbols/BTCUSDT/cancel-order',
          ) &&
          method === 'POST'
        ) {
          if (init?.body && typeof init.body === 'string') cancelBody = JSON.parse(init.body);
          return empty(202);
        }
        return new Response('not found', { status: 404 });
      },
      createQueryClient(),
      'orders',
    );

    await screen.findByTestId('open-orders-panel', undefined, { timeout: 5000 });
    await userEvent.click(screen.getByTestId(`order-cancel-${sampleOrder.id}`));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: /Confirm cancel/ }));

    await waitFor(() => expect(cancelBody).toBeDefined());
    expect((cancelBody as { orderId: string }).orderId).toBe(sampleOrder.id);
  });

  it('surfaces a 4xx cancel error in the workspace banner', { timeout: 15_000 }, async () => {
    mountWorkspace(
      (url, init) => {
        const method = init?.method ?? 'GET';
        if (
          url.endsWith('/profiles/00000000-0000-4000-8000-00000000aa01/symbols/BTCUSDT/state') &&
          method === 'GET'
        )
          return json(sampleState);
        if (candlesRouteRe.test(url) && method === 'GET') return json([]);
        if (
          url.endsWith(
            '/profiles/00000000-0000-4000-8000-00000000aa01/symbols/BTCUSDT/cancel-order',
          ) &&
          method === 'POST'
        ) {
          return new Response(
            JSON.stringify({ error: { code: 'NOT_FOUND', message: 'order not found' } }),
            { status: 404, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 });
      },
      createQueryClient(),
      'orders',
    );

    await screen.findByTestId('open-orders-panel', undefined, { timeout: 5000 });
    await userEvent.click(screen.getByTestId(`order-cancel-${sampleOrder.id}`));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: /Confirm cancel/ }));

    // 4xx cancel must surface a toast — silent failure here would leave
    // operators thinking a stuck order was successfully cancelled.
    await waitFor(
      () =>
        expect(toastError).toHaveBeenCalledWith(
          expect.stringMatching(/NOT_FOUND: order not found/i),
        ),
      { timeout: 5000 },
    );
  });

  it('shows the empty-orders message when openOrders is empty', async () => {
    setUp((url) => {
      if (url.endsWith('/profiles/00000000-0000-4000-8000-00000000aa01/symbols/BTCUSDT/state'))
        return json({ ...sampleState, openOrders: [] });
      if (candlesRouteRe.test(url)) return json([]);
      return new Response('not found', { status: 404 });
    }, 'orders');

    await waitFor(() => expect(screen.getByText('No open orders.')).toBeInTheDocument(), {
      timeout: 5000,
    });
  });

  it('mounts lightweight-charts via dynamic import and seeds the candle series', async () => {
    setUp((url) => {
      if (url.endsWith('/profiles/00000000-0000-4000-8000-00000000aa01/symbols/BTCUSDT/state'))
        return json({
          ...sampleState,
          avgEntryPrice: {
            avgEntryPrice: '49000.00',
            quantity: '0.01',
            updatedAt: '2026-05-10T04:55:00.000Z',
          },
        });
      if (candlesRouteRe.test(url)) return json(sampleCandles);
      return new Response('not found', { status: 404 });
    });

    const chart = await screen.findByTestId('symbol-candle-chart', undefined, { timeout: 5000 });
    expect(within(chart).getByTestId('symbol-candle-chart-canvas')).toBeInTheDocument();
    await waitFor(() => expect(loadStub).toHaveBeenCalled(), { timeout: 5000 });
    await waitFor(() => expect(createChart).toHaveBeenCalled());
    expect(addSeries).toHaveBeenCalledWith({ id: 'candlestick' }, expect.anything());
    const lastSetData = setData.mock.calls.at(-1)?.[0] as { close: number }[] | undefined;
    expect(lastSetData).toHaveLength(2);
    expect(lastSetData?.[1]?.close).toBe(50150);
    await waitFor(() =>
      expect(createPriceLine).toHaveBeenCalledWith(
        expect.objectContaining({ price: 49000, title: 'ENTRY' }),
      ),
    );
  });

  it('keeps the chart mounted but shows the empty note when no candles returned', async () => {
    setUp((url) => {
      if (url.endsWith('/profiles/00000000-0000-4000-8000-00000000aa01/symbols/BTCUSDT/state'))
        return json(sampleState);
      if (candlesRouteRe.test(url)) return json([]);
      return new Response('not found', { status: 404 });
    });

    // The trade tab keeps the chart as its primary surface even with an empty
    // window, overlaying a note rather than swapping the whole surface out.
    await screen.findByTestId('symbol-candle-chart', undefined, { timeout: 5000 });
    expect(screen.getByTestId('symbol-chart-empty')).toBeInTheDocument();
  });

  // The operator-action panels (Manual trade, Force trigger, and the Technicals
  // buy-gate) gate off the strategy's operatorActions so a control whose write
  // the strategy would silently drop never renders. Manual + Force carry stable
  // synchronous headings; asserting those proves the gate both ways.
  it('renders the operator-action panels when the strategy supports them', async () => {
    setUp((url) => {
      if (url.endsWith('/profiles/00000000-0000-4000-8000-00000000aa01/symbols/BTCUSDT/state'))
        return json(sampleState);
      if (candlesRouteRe.test(url)) return json([]);
      return new Response('not found', { status: 404 });
    });

    expect(
      await screen.findByText('Manual trade', undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Force trigger')).toBeInTheDocument();
  });

  it('hides the operator-action panels for a strategy that declares none', async () => {
    const momentumState = {
      ...sampleState,
      strategy: { ...sampleState.strategy, name: 'momentum', operatorActions: [] },
    };
    setUp((url) => {
      if (url.endsWith('/profiles/00000000-0000-4000-8000-00000000aa01/symbols/BTCUSDT/state'))
        return json(momentumState);
      if (candlesRouteRe.test(url)) return json([]);
      return new Response('not found', { status: 404 });
    });

    // The chart is ungated on the trade tab — use it as the "settled" sync
    // point, then assert the gated operator panels are absent.
    await screen.findByTestId('symbol-candle-chart', undefined, { timeout: 5000 });
    expect(screen.queryByText('Manual trade')).not.toBeInTheDocument();
    expect(screen.queryByText('Force trigger')).not.toBeInTheDocument();
  });
});
