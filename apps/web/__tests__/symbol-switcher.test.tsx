// SymbolSwitcher — header symbol picker: option list, navigation, guards.

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SymbolSwitcher } from '../src/features/symbol/components/symbol-switcher.js';
import { createQueryClient } from '../src/shared/lib/query-client.js';

import { type ProfileDashboardResponse } from '@app/contracts';

const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';
// Matches the global test-setup default active account; the switcher builds its
// navigate target from useActiveAccountId.
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';

const dashboardSymbol = (symbol: string): ProfileDashboardResponse['symbols'][number] => ({
  symbol,
  enabled: true,
  avgEntryPrice: null,
  currentPrice: null,
  quantity: null,
  openOrderCount: 0,
  openOrders: [],
});

const dashboard = (symbols: string[]): ProfileDashboardResponse => ({
  profileId: PROFILE_ID,
  enabled: true,
  binanceMode: 'test',
  balances: [],
  totalProfit: '0',
  enabledNotifierCount: 0,
  symbols: symbols.map(dashboardSymbol),
  cachedAt: '2026-05-19T00:00:00.000Z',
});

// Selecting a symbol navigates to that symbol's workspace page. The switcher is
// mounted on the workspace route so its `useNavigate` target resolves and the
// assertions can read the resulting pathname.
const renderSwitcher = (currentSymbol: string, symbols: string[]) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(dashboard(symbols)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
  const rootRoute = createRootRoute();
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/accounts/$accountId/profiles/$profileId/symbols/$symbol',
    component: () => <SymbolSwitcher profileId={PROFILE_ID} symbol={currentSymbol} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workspaceRoute]),
    history: createMemoryHistory({
      initialEntries: [`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/symbols/${currentSymbol}`],
    }),
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return router;
};

afterEach(() => vi.unstubAllGlobals());

describe('SymbolSwitcher', () => {
  it('lists every symbol the profile tracks', async () => {
    renderSwitcher('BTCUSDT', ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    const select = await screen.findByTestId('symbol-switcher');
    expect(select).toHaveValue('BTCUSDT');
    expect(screen.getByRole('option', { name: 'ETHUSDT' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'SOLUSDT' })).toBeInTheDocument();
  });

  it('navigates to the chosen symbol workspace on selection', async () => {
    const router = renderSwitcher('BTCUSDT', ['BTCUSDT', 'ETHUSDT']);
    const select = await screen.findByTestId('symbol-switcher');
    await userEvent.selectOptions(select, 'ETHUSDT');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/symbols/ETHUSDT`,
      );
    });
  });

  it('renders nothing when the profile tracks only one symbol', async () => {
    renderSwitcher('BTCUSDT', ['BTCUSDT']);
    // Give the query a tick to resolve, then confirm the switcher stayed absent.
    await waitFor(() => {
      expect(screen.queryByTestId('symbol-switcher')).not.toBeInTheDocument();
    });
  });

  it('renders nothing when the current symbol is absent from the list', async () => {
    renderSwitcher('DOGEUSDT', ['BTCUSDT', 'ETHUSDT']);
    await waitFor(() => {
      expect(screen.queryByTestId('symbol-switcher')).not.toBeInTheDocument();
    });
  });
});
