// `/account` and `/settings` used to be two half-pages, and `/settings` was a
// redirect into `/account`. The operator-level hub now lives at `/settings`
// (the name they look for), so `/account` is the redirect and keeps old
// bookmarks and the cached service-worker shell landing somewhere valid.

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { rootRoute } from '@/app/__root';
import { accountRoute } from '@/features/account/routes/account';
import { settingsRoute } from '@/features/account/routes/settings';

const stub = (path: string) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => null });

describe('/account', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('/account redirects to /settings', async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        stub('/'),
        stub('/onboarding'),
        stub('/login'),
        accountRoute,
        settingsRoute,
      ]),
      context: { queryClient },
      history: createMemoryHistory({ initialEntries: ['/account'] }),
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider
          router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'));
  });
});
