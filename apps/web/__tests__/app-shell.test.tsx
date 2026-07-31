import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { AppShell } from '@/app/app-shell';
import { NAV_ITEMS } from '@/app/bottom-nav';
import { ProfileProvider } from '@/features/profile/lib/profile-context';

// AppShell's nav uses TanStack `<Link>`, which needs a router context. The
// nav targets are declared as routes so `Link` resolves them without warning.
// The StatusBar inside the shell polls /status via React Query, so a
// QueryClientProvider is also required (the real app provides one at root).
const renderShell = (children: ReactNode): void => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
};

describe('<AppShell>', () => {
  it('renders children, theme toggle, home wordmark, settings icon, nav, and switcher slot', () => {
    renderShell(<p>page-content</p>);

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

  it('the main scroller carries overscroll containment', () => {
    renderShell(<p />);

    // <main> is the app's only scroller. Without containment, a flick past its
    // end chains the scroll to the document, which on mobile drags the whole
    // shell (and, at the top, arms the browser's pull-to-refresh) — the page
    // rubber-bands under the fixed header instead of stopping dead.
    const main = screen.getByRole('main');
    expect(main.className).toMatch(/overscroll-contain/);
  });

  it('respects ≥ 44×44 px touch target on bottom nav links', () => {
    renderShell(<p />);

    // The mobile BottomNav is the "Primary" nav and the touch surface. The 44px
    // floor is a touch-input requirement; identify it by its h-16 chrome bar.
    const navs = screen.getAllByRole('navigation', { name: 'Primary' });
    const bottomNav = navs.find((nav) => /\bh-16\b/.test(nav.className));
    expect(bottomNav).toBeDefined();
    if (!bottomNav) return; // narrow for the loop below; the assertion above already failed
    for (const link of bottomNav.querySelectorAll('a')) {
      // min-h-11 + min-w-11 = 44×44, the iOS HIG / WCAG 2.5.5 touch minimum.
      expect(link.className).toMatch(/min-h-11/);
      expect(link.className).toMatch(/min-w-11/);
    }
  });
});
