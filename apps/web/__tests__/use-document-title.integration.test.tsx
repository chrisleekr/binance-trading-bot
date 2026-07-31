// End-to-end document.title: mount the real router (which runs useDocumentTitle
// in __root's RootComponent) and assert the browser title at two real routes.
// This exercises the leaf→root walk over the REAL useMatches() and the
// function-title param path — the unit tests only feed synthetic matches.

import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { accountOverviewRoute } from '@/features/dashboard/routes/index';
import { accountScopeRoute } from '@/features/account/routes/account-scope';
import { profileDetailRoute } from '@/features/profile/routes/profiles.$profileId';
import { symbolDetailRoute } from '@/features/symbol/routes/profiles.$profileId.symbols.$symbol';
import { rootRoute } from '@/app/__root';

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const TEST_ACCOUNT = {
  id: ACCOUNT_ID,
  name: 'Main',
  binanceMode: 'test' as const,
  apiKeyConfigured: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function mountAt(path: string): void {
  const queryClient = createQueryClient();
  // Bypass the root onboarding/login gate and seed the account list so the
  // account scope resolves instead of 404ing (same seeds as index-route.test).
  queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
  queryClient.setQueryData(['accounts'], [TEST_ACCOUNT]);
  queryClient.setQueryData(['dashboard-aggregate', ACCOUNT_ID], { profiles: [] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      accountScopeRoute.addChildren([
        accountOverviewRoute,
        profileDetailRoute.addChildren([symbolDetailRoute]),
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
}

describe('document.title via the real router', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // The symbol workspace fires unseeded queries that reject under jsdom; the
    // title effect runs in __root regardless, so swallow the console noise.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('sets the Dashboard title at the account overview route', async () => {
    mountAt(`/accounts/${ACCOUNT_ID}`);
    await waitFor(() => expect(document.title).toBe('Dashboard · binance-trading-bot'));
  });

  it('derives the uppercased symbol title from the URL param at the symbol route', async () => {
    mountAt(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/symbols/btcusdt`);
    await waitFor(() => expect(document.title).toBe('BTCUSDT · binance-trading-bot'));
  });
});
