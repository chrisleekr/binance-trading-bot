// The account refactor UN-RETIRES the per-profile page: what was a redirect to
// `/` is now a real page at `/accounts/$accountId/profiles/$profileId` that
// renders the shared overview focused on that profile. This guards that the
// deep-linked per-profile URL renders in place and does NOT bounce to the
// account overview.

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { rootRoute } from '@/app/__root';
import { accountScopeRoute } from '@/features/account/routes/account-scope';
import {
  profileDetailIndexRoute,
  profileDetailRoute,
} from '@/features/profile/routes/profiles.$profileId';

// A contract-valid v4 UUID — the profile the deep link focuses.
const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const TEST_ACCOUNT = {
  id: ACCOUNT_ID,
  name: 'Main',
  binanceMode: 'test' as const,
  apiKeyConfigured: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const stub = (path: string) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => null });

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('per-profile route (un-retired)', () => {
  it('renders the per-profile dashboard in place and does not redirect to the overview', async () => {
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = createQueryClient();
    queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
    queryClient.setQueryData(['accounts'], [TEST_ACCOUNT]);
    // Seed the account aggregate with this profile so the focused overview
    // renders its container instead of the empty/loading state.
    queryClient.setQueryData(['dashboard-aggregate', ACCOUNT_ID], {
      profiles: [
        {
          profileId: PROFILE_ID,
          name: 'btc-real',
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
        },
      ],
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        stub('/'),
        stub('/onboarding'),
        stub('/login'),
        accountScopeRoute.addChildren([profileDetailRoute.addChildren([profileDetailIndexRoute])]),
      ]),
      context: { queryClient },
      history: createMemoryHistory({
        initialEntries: [`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}`],
      }),
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider
          router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
        />
      </QueryClientProvider>,
    );

    // The per-profile overview renders in place (no redirect to the account
    // overview or `/`).
    expect(await screen.findByTestId('terminal-overview')).toBeInTheDocument();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}`);
    });
  });
});
