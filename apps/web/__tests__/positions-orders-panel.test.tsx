// PositionsOrdersPanel — the overview "Your money now" block: held positions
// and the actual resting open orders across visible profiles. The cross-profile
// fan-out (useSymbolRows) is mocked so the test drives the rendered rows
// directly; a memory router satisfies the per-row <Link>.

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const useSymbolRows = vi.fn();
vi.mock('@/features/dashboard/lib/use-symbol-rows', () => ({
  useSymbolRows: (...a: unknown[]) => useSymbolRows(...a),
}));

const { PositionsOrdersPanel } =
  await import('@/features/dashboard/components/positions-orders-panel');

const PA = '00000000-0000-4000-8000-0000000000a1';

const sym = (over: Record<string, unknown> & { symbol: string }) => ({
  enabled: true,
  source: 'manual',
  avgEntryPrice: null,
  currentPrice: null,
  quantity: null,
  openOrderCount: 0,
  openOrders: [],
  entryBlocker: null,
  ...over,
});

const row = (s: ReturnType<typeof sym>) => ({
  profileId: PA,
  profileName: 'RealNet',
  binanceMode: 'live' as const,
  sym: s,
});

const merged = (items: unknown[]) => ({
  items,
  isLoading: false,
  isError: false,
  isPartial: false,
});

async function renderPanel(): Promise<void> {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <PositionsOrdersPanel rows={[]} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <RouterProvider router={router as unknown as Parameters<typeof RouterProvider>[0]['router']} />,
  );
  await act(async () => {
    await router.load();
  });
}

afterEach(() => vi.clearAllMocks());

describe('<PositionsOrdersPanel>', () => {
  it('lists held positions with P/L and the actual resting orders', async () => {
    useSymbolRows.mockReturnValue(
      merged([
        row(
          sym({
            symbol: 'XPLUSDT',
            avgEntryPrice: '0.0860',
            currentPrice: '0.0893',
            quantity: '169.8',
            openOrders: [
              {
                id: 'o1',
                symbol: 'XPLUSDT',
                side: 'BUY',
                raw: { origQty: '120', price: '0.0850', type: 'LIMIT' },
              },
            ],
          }),
        ),
      ]),
    );
    await renderPanel();

    const pos = screen.getByTestId('money-position-XPLUSDT');
    expect(pos).toHaveTextContent('169.8');
    expect(pos).toHaveTextContent('0.086');
    expect(within(pos).getByText(/\+0/)).toBeInTheDocument(); // positive unrealised P/L

    const order = screen.getByTestId('money-order-o1');
    expect(order).toHaveTextContent('XPLUSDT');
    expect(order).toHaveTextContent('BUY');
    expect(order).toHaveTextContent('120');
  });

  it('describes a protective stop by where it fires, in words', async () => {
    useSymbolRows.mockReturnValue(
      merged([
        row(
          sym({
            symbol: 'BTCUSDT',
            avgEntryPrice: '82865.76',
            currentPrice: '82867.00',
            quantity: '0.00146',
            openOrders: [
              {
                id: 'o-stop',
                symbol: 'BTCUSDT',
                side: 'SELL',
                intent: 'protective-stop',
                raw: {
                  origQty: '0.00146',
                  price: '80235.15',
                  stopPrice: '81872.61',
                  type: 'STOP_LOSS_LIMIT',
                },
              },
            ],
          }),
        ),
      ]),
    );
    await renderPanel();
    const order = screen.getByTestId('money-order-o-stop');
    // The trigger, not the limit leg the Price column would show.
    expect(order).toHaveTextContent(
      'Stop-loss sells 0.00146 if price falls to 81,872.61 (1.20% below now)',
    );
    expect(order).not.toHaveTextContent('80,235.15');
  });

  it.each([
    {
      name: 'a stop-limit names the limit its sell rests at',
      raw: {
        origQty: '0.00146',
        price: '80235.15',
        stopPrice: '81872.61',
        type: 'STOP_LOSS_LIMIT',
      },
      text: 'Stop-loss triggered at 81,872.61; its sell is resting at 80,235.15 and may not fill if price keeps falling.',
    },
    {
      name: 'a market stop says it sells at market',
      raw: { origQty: '0.00146', price: '0', stopPrice: '81872.61', type: 'STOP_LOSS' },
      text: 'Stop-loss triggered at 81,872.61; its sell goes out at market.',
    },
  ])('says a stop has triggered once price is at or below it: $name', async ({ raw, text }) => {
    // Price at the trigger exactly: the stop has fired, so "sells if price falls to" would promise an exit a falling price can skip past.
    useSymbolRows.mockReturnValue(
      merged([
        row(
          sym({
            symbol: 'BTCUSDT',
            avgEntryPrice: '82865.76',
            currentPrice: '81872.61',
            quantity: '0.00146',
            openOrders: [
              { id: 'o-stop', symbol: 'BTCUSDT', side: 'SELL', intent: 'protective-stop', raw },
            ],
          }),
        ),
      ]),
    );
    await renderPanel();
    const order = screen.getByTestId('money-order-o-stop');
    expect(order).toHaveTextContent(text);
    expect(order).not.toHaveTextContent('if price falls to');
    expect(within(order).getByText('Stop-loss triggered')).toHaveClass('text-warning');
  });

  it('omits a refused position seed while still listing its resting order', async () => {
    // "Your money now" means positions the strategy is actually running. The cost-basis row survives a refused seed by design and carries both an entry price and a quantity, so an unfiltered panel lists it here and prices it — a gain on something that will never be sold, beside the real ones. The order is the control: it is a live order on the exchange either way, so its presence proves the row reached the panel and only the POSITION was withheld.
    useSymbolRows.mockReturnValue(
      merged([
        row(
          sym({
            symbol: 'XPLUSDT',
            avgEntryPrice: '0.0860',
            currentPrice: '0.0893',
            quantity: '169.8',
            positionSeedRefusal: { code: 'no-sellable-position', since: '2026-08-27T00:00:00Z' },
            openOrders: [
              {
                id: 'o1',
                symbol: 'XPLUSDT',
                side: 'BUY',
                raw: { origQty: '120', price: '0.0850', type: 'LIMIT' },
              },
            ],
          }),
        ),
      ]),
    );
    await renderPanel();

    expect(screen.queryByTestId('money-position-XPLUSDT')).not.toBeInTheDocument();
    expect(screen.getByTestId('money-order-o1')).toBeInTheDocument();
  });

  it('trims the order quantity to match the positions panel (no 8-decimal padding)', async () => {
    // Binance ships origQty zero-padded ("82.70000000"); render it trimmed via
    // formatAmount so it reads like the positions panel ("82.7"), not raw.
    useSymbolRows.mockReturnValue(
      merged([
        row(
          sym({
            symbol: 'ADAUSDT',
            currentPrice: '0.1802',
            openOrders: [
              {
                id: 'o2',
                symbol: 'ADAUSDT',
                side: 'BUY',
                raw: { origQty: '82.70000000', price: '0.1839', type: 'LIMIT' },
              },
            ],
          }),
        ),
      ]),
    );
    await renderPanel();

    const order = screen.getByTestId('money-order-o2');
    expect(order).toHaveTextContent('82.7');
    expect(order).not.toHaveTextContent('82.70000000');
  });

  it('renders nothing when there are no positions and no orders', async () => {
    useSymbolRows.mockReturnValue(
      merged([row(sym({ symbol: 'ICPUSDT', currentPrice: '2.42' }))]), // flat, no orders
    );
    await renderPanel();
    expect(screen.queryByTestId('positions-orders-panel')).not.toBeInTheDocument();
  });

  it('shows "None." per column for the mixed state (a resting order on a flat symbol)', async () => {
    // A BUY that hasn't filled = an open order with no position. Positions
    // column is empty, orders column is not — covers both "None." branches.
    useSymbolRows.mockReturnValue(
      merged([
        row(
          sym({
            symbol: 'ICPUSDT',
            currentPrice: '2.42',
            openOrders: [
              {
                id: 'o9',
                symbol: 'ICPUSDT',
                side: 'BUY',
                raw: { origQty: '5', price: '2.30', type: 'LIMIT' },
              },
            ],
          }),
        ),
      ]),
    );
    await renderPanel();

    expect(within(screen.getByTestId('money-positions')).getByText('None.')).toBeInTheDocument();
    expect(screen.getByTestId('money-order-o9')).toHaveTextContent('ICPUSDT');
  });
});
