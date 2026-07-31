import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GateStatusResponse } from '@app/contracts';

import { LiveGateStatusCard } from '@/features/dashboard/components/live-gate-status-card';
import { createQueryClient } from '@/shared/lib/query-client';

const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';
// Matches the global test-setup default active account; the card builds the
// backtest Link from useActiveAccountId.
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';

const jsonOf = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

// The card renders a router <Link> to the backtest workbench in the unproven
// state, so it needs a RouterProvider with the backtest route registered.
const renderCard = (status: GateStatusResponse): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonOf(status)),
  );
  const qc = createQueryClient();
  const root = createRootRoute({
    component: () => (
      <>
        <LiveGateStatusCard profileId={PROFILE_ID} />
        <Outlet />
      </>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/', component: () => null }),
      createRoute({
        getParentRoute: () => root,
        path: '/accounts/$accountId/profiles/$profileId/backtest',
        component: () => null,
      }),
    ]),
    context: { queryClient: qc },
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
};

describe('LiveGateStatusCard', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows a validated (up) state when the current config clears the gate', async () => {
    renderCard({
      applicability: 'gated',
      ok: true,
      failure: null,
      detail: 'current config is validated by a recent passing backtest',
    });
    const el = await screen.findByTestId('gate-status-state');
    expect(el).toHaveTextContent('Live trading validated.');
    expect(el).toHaveAttribute('data-gate-tone', 'up');
  });

  it('shows an advisory warning (never paused) when the config is unproven', async () => {
    renderCard({
      applicability: 'gated',
      ok: false,
      failure: 'thresholds',
      detail: 'the backtest does not clear the gate — profit factor 1.00 (need >= 1.1)',
    });
    const el = await screen.findByTestId('gate-status-state');
    expect(el).toHaveTextContent('Unproven config.');
    expect(el).toHaveTextContent(/heads-up/);
    expect(el).toHaveAttribute('data-gate-tone', 'warning');
    // The unproven state offers a one-click path to prove the current config,
    // landing on the Configure step (not Results) via ?view=configure.
    const run = await screen.findByTestId('gate-run-current-config');
    expect(run).toHaveTextContent('Run backtest on current config');
    expect(run).toHaveAttribute(
      'href',
      `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/backtest?view=configure`,
    );
  });

  it('offers no run-backtest action when the config is already validated', async () => {
    renderCard({
      applicability: 'gated',
      ok: true,
      failure: null,
      detail: 'current config is validated by a recent passing backtest',
    });
    await screen.findByTestId('gate-status-state');
    expect(screen.queryByTestId('gate-run-current-config')).not.toBeInTheDocument();
  });

  it('shows the gate-off state', async () => {
    renderCard({
      applicability: 'gate-off',
      ok: true,
      failure: null,
      detail: 'off',
    });
    const el = await screen.findByTestId('gate-status-state');
    expect(el).toHaveTextContent('Live gate off.');
  });

  it('renders nothing for a testnet (not-live) profile', async () => {
    renderCard({
      applicability: 'not-live',
      ok: true,
      failure: null,
      detail: 'testnet',
    });
    await waitFor(() =>
      expect(screen.queryByTestId('live-gate-status-card')).not.toBeInTheDocument(),
    );
  });
});
