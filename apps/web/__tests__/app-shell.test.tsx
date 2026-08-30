import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '@/app/app-shell';
import { NAV_ITEMS } from '@/app/bottom-nav';
import { ONBOARDING_STATUS_QUERY_KEY } from '@/features/auth/api/auth';
import { ProfileProvider } from '@/features/profile/lib/profile-context';

/**
 * Normalizes a fetch target to a trailing-slash-free pathname so absolute and relative requests compare identically.
 *
 * @param input - Request target accepted by `fetch`.
 * @returns The normalized pathname used by request assertions.
 */
const requestPathname = (input: RequestInfo | URL): string => {
  const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(value, 'http://test.local').pathname.replace(/\/+$/, '');
};

/**
 * Renders AppShell with its router and query providers. The seeded non-demo onboarding state mirrors the root loader so demo-aware descendants neither fetch it nor silently default to false.
 *
 * @param children - Content rendered inside the shell's main outlet.
 * @returns A promise that resolves after the in-memory router finishes its initial load.
 */
const renderShell = async (children: ReactNode): Promise<void> => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(ONBOARDING_STATUS_QUERY_KEY, { masterExists: true, demoMode: false });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <ProfileProvider>
          <AppShell>{children}</AppShell>
        </ProfileProvider>
      </QueryClientProvider>
    ),
  });
  // Derive from NAV_ITEMS so a new nav target can't desync the test router.
  const navRoutes = NAV_ITEMS.map((item) =>
    createRoute({ getParentRoute: () => rootRoute, path: item.to, component: () => null }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(navRoutes),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(<RouterProvider router={router} />);
  await act(async () => {
    await router.load();
  });
};

describe('<AppShell>', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders children, theme toggle, home wordmark, settings icon, nav, and switcher slot', async () => {
    await renderShell(<p>page-content</p>);

    expect(screen.getByText('page-content')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /switch to (light|dark) theme/i }),
    ).toBeInTheDocument();
    // Wordmark links Home; Settings is a compact icon link in the header
    // (distinct from the mobile BottomNav's Settings link).
    expect(screen.getByRole('link', { name: /^bot$/i })).toHaveAttribute('href', '/');
    expect(screen.getByTestId('header-account')).toHaveAttribute('href', '/settings');
    // Only the mobile BottomNav carries the "Primary" label now; the desktop
    // text nav was replaced by the wordmark + account icon.
    expect(screen.getAllByRole('navigation', { name: 'Primary' })).toHaveLength(1);
    expect(screen.getByTestId('profile-switcher-slot')).toBeInTheDocument();
  });

  it('does not escape an onboarding-status request from the shell test harness', async () => {
    await renderShell(<p />);

    const onboardingRequests = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => requestPathname(input).endsWith('/auth/onboarding-status'));
    expect(onboardingRequests).toHaveLength(0);
  });

  it('the main scroller carries overscroll containment', async () => {
    await renderShell(<p />);

    // <main> is the app's only scroller. Without containment, a flick past its
    // end chains the scroll to the document, which on mobile drags the whole
    // shell (and, at the top, arms the browser's pull-to-refresh) — the page
    // rubber-bands under the fixed header instead of stopping dead.
    const main = screen.getByRole('main');
    expect(main.className).toMatch(/overscroll-contain/);
  });

  it('respects ≥ 44×44 px touch target on every bottom nav cell', async () => {
    await renderShell(<p />);

    // The mobile BottomNav is the "Primary" nav and the touch surface. The 44px
    // floor is a touch-input requirement; identify it by its h-16 chrome bar.
    const navs = screen.getAllByRole('navigation', { name: 'Primary' });
    const bottomNav = navs.find((nav) => /\bh-16\b/.test(nav.className));
    expect(bottomNav).toBeDefined();
    if (!bottomNav) return; // narrow for the loop below; the assertion above already failed
    // 'a, button', not just 'a': the Profiles cell is a sheet trigger rather than
    // a link, and it is the most-tapped cell on the bar. Selecting only anchors
    // silently skipped it.
    const cells = bottomNav.querySelectorAll('a, button');
    expect(cells.length).toBeGreaterThan(1);
    for (const cell of cells) {
      // min-h-11 + min-w-11 = 44×44, the iOS HIG / WCAG 2.5.5 touch minimum.
      expect(cell.className).toMatch(/min-h-11/);
      expect(cell.className).toMatch(/min-w-11/);
    }
  });

  it('makes the desktop sidebar a flex COLUMN, which is what its section sizing depends on', async () => {
    // The rail's own class list carries `flex-col` but not `flex` — `display:flex`
    // arrives only from the className the shell passes here. Swap it for
    // `md:block` and every `flex-1` / `min-h` / `shrink-0` inside the sidebar goes
    // inert: the profile list stops absorbing the leftover height and pushes the
    // ACCOUNT and SYSTEM sections and the collapse control back below the fold,
    // with the sidebar's own suite still green because the classes are all still
    // there. Pinned here because this file owns the composition.
    await renderShell(<p />);
    // Token list, not substring: `'md:flex-col'.includes('md:flex')` is true, so a
    // substring check would accept `hidden md:flex-col` — which leaves the rail
    // `display:block` on desktop, exactly the reversion this test exists to catch.
    const classes = screen.getByTestId('side-nav').className.split(/\s+/);
    expect(classes).toContain('md:flex');
    expect(classes).toContain('flex-col');
  });

  it('exposes a skip link, anchored to a main that can actually take focus', async () => {
    // Both halves are load-bearing and both are easy to lose. Without the id the
    // anchor points nowhere; without tabIndex the browser scrolls but leaves
    // focus on the link, so the next Tab lands back in the nav just skipped.
    await renderShell(<p />);
    const skip = screen.getByTestId('skip-link');
    expect(skip).toHaveAttribute('href', '#main-content');
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    expect(main).toHaveAttribute('tabindex', '-1');
    // WCAG 2.4.1 wants it reachable FIRST; happy-dom does no layout, so document
    // order is the only observable part of "first tab stop".
    expect(document.querySelector('a')).toBe(skip);
  });
});
