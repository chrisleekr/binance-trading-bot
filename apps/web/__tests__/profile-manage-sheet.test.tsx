import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { ProfileManageSheet } from '@/features/profile/components/profile-manage-sheet';

import type { DashboardAggregateResponse } from '@app/contracts';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const PID = '00000000-0000-4000-8000-0000000000c1';

const aggregate = (): DashboardAggregateResponse => ({
  profiles: [
    {
      profileId: PID,
      name: 'btc-real',
      enabled: true,
      binanceMode: 'live',
      quoteAsset: 'USDT',
      lastTickAt: null,
      lastTickLatencyMs: null,
      apiKeyConfigured: true,
      lastTickError: null,
      killSwitch: false,
      openOrderCount: 0,
      openOrders: [],
      openPositionCount: 0,
      positions: [],
    },
  ],
});

const setUp = (): void => {
  const qc = createQueryClient();
  qc.setQueryData(['dashboard-aggregate'], aggregate());
  const root = createRootRoute({
    component: () => (
      <>
        <ProfileManageSheet profileId={PID} />
        <Outlet />
      </>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/', component: () => null }),
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

describe('ProfileManageSheet', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the action set off the page until the slide-over is opened', async () => {
    setUp();
    expect(await screen.findByTestId('open-manage-sheet')).toBeInTheDocument();
    // Radix only mounts the sheet content when open, so the card is absent first.
    expect(screen.queryByTestId('manage-sheet')).toBeNull();

    await userEvent.click(screen.getByTestId('open-manage-sheet'));

    expect(await screen.findByTestId('manage-sheet')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Manage profile' })).toBeInTheDocument();
  });
});
