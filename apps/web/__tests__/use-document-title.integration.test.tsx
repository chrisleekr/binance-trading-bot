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
import {
  profileDetailIndexRoute,
  profileDetailRoute,
} from '@/features/profile/routes/profiles.$profileId';
import { profileQueryKey } from '@/features/profile/api/profile';
import {
  symbolDetailIndexRoute,
  symbolDetailRoute,
} from '@/features/symbol/routes/profiles.$profileId.symbols.$symbol';
import { symbolConfigRoute } from '@/features/symbol/routes/profiles.$profileId.symbols.$symbol.config';
import { rootRoute } from '@/app/__root';

import { pendingFetchForPaths } from './helpers/pending-fetch';

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE_PATH = `/api/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}`;
const SYMBOL_PATH = `${PROFILE_PATH}/symbols/BTCUSDT`;
const BACKGROUND_PATHS = [
  `/api/accounts/${ACCOUNT_ID}/dashboard-aggregate`,
  `${PROFILE_PATH}/dashboard`,
  `${PROFILE_PATH}/technicals/recommendations`,
  `${SYMBOL_PATH}/state`,
  `${SYMBOL_PATH}/ticker`,
  `${SYMBOL_PATH}/candles`,
  `${SYMBOL_PATH}/depth`,
  `${SYMBOL_PATH}/trades`,
  `${SYMBOL_PATH}/orders`,
  `${SYMBOL_PATH}/logs`,
  // Read by the symbol CONFIG page, which the workspace itself never mounts.
  PROFILE_PATH,
  SYMBOL_PATH,
  '/api/strategies',
  '/api/exchange-info',
] as const;
const TEST_ACCOUNT = {
  id: ACCOUNT_ID,
  name: 'Main',
  binanceMode: 'test' as const,
  apiKeyConfigured: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function mountAt(path: string, profileName?: string): void {
  const queryClient = createQueryClient();
  // Bypass the root onboarding/login gate and seed the account list so the
  // account scope resolves instead of 404ing (same seeds as index-route.test).
  queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
  queryClient.setQueryData(['accounts'], [TEST_ACCOUNT]);
  queryClient.setQueryData(['dashboard-aggregate', ACCOUNT_ID], { profiles: [] });
  if (profileName !== undefined) {
    queryClient.setQueryData(profileQueryKey(PROFILE_ID), { id: PROFILE_ID, name: profileName });
  }
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      accountScopeRoute.addChildren([
        accountOverviewRoute,
        profileDetailRoute.addChildren([
          profileDetailIndexRoute,
          symbolDetailRoute.addChildren([symbolDetailIndexRoute, symbolConfigRoute]),
        ]),
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
    vi.stubGlobal('fetch', pendingFetchForPaths(...BACKGROUND_PATHS));
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('sets the Home title at the account overview route', async () => {
    mountAt(`/accounts/${ACCOUNT_ID}`);
    await waitFor(() => expect(document.title).toBe('Home · binance-trading-bot'));
  });

  it('derives the uppercased symbol title from the URL param at the symbol route', async () => {
    mountAt(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/symbols/btcusdt`);
    await waitFor(() => expect(document.title).toBe('BTCUSDT · binance-trading-bot'));
  });

  it('keeps the symbol config title symbol-qualified, not the bare breadcrumb rung', async () => {
    // Nesting config under the workspace gives it a `crumb` of "Config" so the trail does not stutter the symbol twice. A tab title is read with no trail beside it, so it keeps naming the symbol: dropping `staticData.title` in favour of the crumb would shrink every open config tab to an indistinguishable "Config".
    mountAt(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/symbols/btcusdt/config`);
    await waitFor(() => expect(document.title).toBe('BTCUSDT config · binance-trading-bot'));
  });

  it('titles the profile overview with the profile name, not its layout parent’s generic title', async () => {
    // The one route the leaf-without-a-title fallback was written for: the
    // overview declares no staticData of its own, so without the fallback it
    // inherits the layout's "Profile" while the page's own h1 says the name.
    mountAt(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}`, 'btc-real');
    await waitFor(() => expect(document.title).toBe('btc-real · binance-trading-bot'));
  });
});
