// The router keeps the previous route mounted until a navigation's loaders
// resolve. After sign-in that left the login form on screen through the whole
// account+dashboard fetch. A global defaultPendingComponent replaces it with a
// loading screen once the navigation passes pendingMs.
//
// The pending screen is in flow, not a `fixed inset-0` overlay — the first test
// below pins the reason that is safe (the router hides the outgoing match
// itself), and the last one pins that it stays in flow, so the shell chrome is
// reachable during a slow load.

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

    // The outgoing route is hidden by React, not by the pending screen's
    // stacking: each match renders inside a Suspense boundary that is reused
    // across the transition, and re-suspending a populated boundary hides the
    // committed nodes with `display: none !important`. That is what keeps the
    // sign-in form off screen, so the pending screen does not have to cover the
    // viewport to do its job.
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

  // A proxy for the real property, which is "has scroll range under the thumb".
  // happy-dom does no layout, so height cannot be measured here; these classes
  // are what produce it.
  it('renders in flow as a scroll container, so the shell chrome stays reachable', () => {
    render(<RoutePending />);
    const pending = screen.getByTestId('route-pending');
    // `fixed inset-0` would cover the top bar, ticker, health bar and nav for
    // the length of a slow load, leaving the operator nothing to tap.
    expect(pending.className).not.toMatch(/\bfixed\b/);
    // The shell makes <main> a non-scrolling flex column on the full-screen
    // routes, so the pending screen has to own a scroller there or a touch
    // lands on something with no range and the app reads as frozen.
    expect(pending.className).toMatch(/\boverflow-y-auto\b/);
    expect(pending.className).toMatch(/\bflex-1\b/);
  });
});
