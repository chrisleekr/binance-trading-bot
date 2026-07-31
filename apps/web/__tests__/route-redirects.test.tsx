// The history tabs absorbed the archive and audit surfaces, so the old
// `archive` and `audit` URLs are `beforeLoad` redirects to the profile History
// page — now account-nested at
// `/accounts/$accountId/profiles/$profileId/history`. This verifies each old
// bookmark lands on history. (The scope-focusing side effect was retired with
// the profile-scope store.) The other former sub-routes (config, notifications,
// symbols/*) are now real pages, not redirects.

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { rootRoute } from '@/app/__root';
import { accountScopeRoute } from '@/features/account/routes/account-scope';
import {
  profileDetailIndexRoute,
  profileDetailRoute,
} from '@/features/profile/routes/profiles.$profileId';
import { archiveRoute } from '@/features/profile/routes/profiles.$profileId.archive';
import { auditRoute } from '@/features/profile/routes/profiles.$profileId.audit';
import { historyRoute } from '@/features/profile/routes/profiles.$profileId.history';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const TEST_ACCOUNT = {
  id: ACCOUNT_ID,
  name: 'Main',
  binanceMode: 'test' as const,
  apiKeyConfigured: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

// `/` stub passes search through untouched so the redirect's search survives
// into location.search for assertion.
const indexStub = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => null,
  validateSearch: (raw: Record<string, unknown>) => raw,
});
const stub = (path: string) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => null });

function renderAt(initialPath: string) {
  const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
  queryClient.setQueryData(['accounts'], [TEST_ACCOUNT]);
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexStub,
      stub('/onboarding'),
      stub('/login'),
      accountScopeRoute.addChildren([
        profileDetailRoute.addChildren([
          profileDetailIndexRoute,
          archiveRoute,
          auditRoute,
          historyRoute,
        ]),
      ]),
    ]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return router;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('retired route redirects', () => {
  const cases: readonly {
    name: string;
    from: string;
    to?: string;
    search: Record<string, unknown>;
  }[] = [
    {
      name: 'archive → history',
      from: `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/archive`,
      to: `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/history`,
      // Each retired route lands on its own tab, not the History default, so an
      // old bookmark still shows the panel it named.
      search: { section: 'archive' },
    },
    {
      name: 'audit → history',
      from: `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/audit`,
      to: `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/history`,
      search: { section: 'audit' },
    },
  ];

  for (const c of cases) {
    it(`redirects ${c.name}`, async () => {
      const router = renderAt(c.from);
      await waitFor(() => expect(router.state.location.pathname).toBe(c.to ?? '/'));
      expect(router.state.location.search).toMatchObject(c.search);
    });
  }
});
