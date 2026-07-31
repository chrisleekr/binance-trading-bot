// LiveProfileProvider — resolves the account-wide `activeProfileId` that
// off-route pages (e.g. dust transfer) fall back to. Resolution order is:
// current profile route -> last profile route visited -> first profile.

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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveProfileProvider } from '@/features/profile/components/live-profile-provider';
import { useProfiles } from '@/features/profile/lib/profile-context';
import { createQueryClient } from '@/shared/lib/query-client';
import { setActiveAccountId } from '@/shared/lib/account-scope';

import type { DashboardAggregateResponse } from '@app/contracts';

const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const LAST_ACTIVE_KEY = 'profile-last-active';

const row = (id: string, name: string): DashboardAggregateResponse['profiles'][number] => ({
  profileId: id,
  name,
  enabled: true,
  binanceMode: 'live',
  lastTickAt: null,
  lastTickLatencyMs: null,
  apiKeyConfigured: true,
  lastTickError: null,
  killSwitch: false,
  openOrderCount: 0,
  openOrders: [],
  openPositionCount: 0,
  positions: [],
});

function Probe() {
  const { activeProfileId } = useProfiles();
  return <div data-testid="active">{activeProfileId ?? 'null'}</div>;
}

const setUp = (initialPath: string, { lastActive }: { lastActive?: string } = {}) => {
  if (lastActive !== undefined) window.localStorage.setItem(LAST_ACTIVE_KEY, lastActive);
  setActiveAccountId(ACCOUNT_ID);

  const qc = createQueryClient();
  qc.setQueryData(['dashboard-aggregate', ACCOUNT_ID], {
    profiles: [row('a', 'profile-a'), row('b', 'profile-b')],
  } satisfies DashboardAggregateResponse);

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const accountRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/accounts/$accountId',
    component: () => (
      <LiveProfileProvider>
        <Outlet />
      </LiveProfileProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => accountRoute,
    path: '/',
    component: Probe,
  });
  const profileRoute = createRoute({
    getParentRoute: () => accountRoute,
    path: '/profiles/$profileId',
    component: Probe,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([accountRoute.addChildren([indexRoute, profileRoute])]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  render(
    <QueryClientProvider client={qc}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
};

describe('<LiveProfileProvider> activeProfileId', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('uses the current profile route, overriding the last-active fallback', async () => {
    setUp(`/accounts/${ACCOUNT_ID}/profiles/a`, { lastActive: 'b' });
    expect((await screen.findByTestId('active')).textContent).toBe('a');
  });

  it('off a profile route, falls back to the last-active profile', async () => {
    setUp(`/accounts/${ACCOUNT_ID}`, { lastActive: 'b' });
    expect((await screen.findByTestId('active')).textContent).toBe('b');
  });

  it('off a profile route with nothing remembered, falls back to the first profile', async () => {
    setUp(`/accounts/${ACCOUNT_ID}`);
    expect((await screen.findByTestId('active')).textContent).toBe('a');
  });

  it('persists the last-active profile after visiting its route', async () => {
    setUp(`/accounts/${ACCOUNT_ID}/profiles/b`);
    await waitFor(() => {
      expect(window.localStorage.getItem(LAST_ACTIVE_KEY)).toBe('b');
    });
  });
});
