// The router keeps the previous route mounted until a navigation's loaders
// resolve. After sign-in that left the login form on screen through the whole
// account+dashboard fetch. A global defaultPendingComponent replaces it with a
// full-screen loading screen once the navigation passes pendingMs.

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { rootRoute } from '@/app/__root';
import { RoutePending } from '@/app/route-pending';
import { router as appRouter } from '@/router';

describe('route pending screen', () => {
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

  it('replaces the previous route with the pending screen while a navigation loads', async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });

    // A loader we hold open, so the destination stays pending deterministically.
    let releaseLoader: () => void = () => undefined;
    const loaderGate = new Promise<void>((resolve) => {
      releaseLoader = resolve;
    });

    const loginStub = createRoute({
      getParentRoute: () => rootRoute,
      path: '/login',
      component: () => <div data-testid="login-marker">sign in</div>,
    });
    const slowRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/slow',
      loader: () => loaderGate,
      component: () => <div data-testid="slow-content">loaded</div>,
    });

    const router = createRouter({
      routeTree: rootRoute.addChildren([
        createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null }),
        createRoute({
          getParentRoute: () => rootRoute,
          path: '/onboarding',
          component: () => null,
        }),
        loginStub,
        slowRoute,
      ]),
      context: { queryClient },
      // 0ms so the pending screen appears the moment the loader is pending,
      // rather than racing a real timer in the test.
      defaultPendingComponent: RoutePending,
      defaultPendingMs: 0,
      defaultPendingMinMs: 0,
      history: createMemoryHistory({ initialEntries: ['/login'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider
          router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('login-marker')).toBeInTheDocument());

    void router.navigate({ to: '/slow' });

    // During the pending navigation the router hides the previous route
    // (display:none) and the pending screen covers the view — so the login form
    // is no longer visible.
    await waitFor(() => expect(screen.getByTestId('route-pending')).toBeInTheDocument());
    expect(screen.getByTestId('login-marker')).not.toBeVisible();

    releaseLoader();

    await waitFor(() => expect(screen.getByTestId('slow-content')).toBeInTheDocument());
    expect(screen.queryByTestId('route-pending')).not.toBeInTheDocument();
  });

  it('wires the pending screen into the real app router', () => {
    expect(appRouter.options.defaultPendingComponent).toBe(RoutePending);
    expect(appRouter.options.defaultPendingMs).toBe(150);
  });
});
