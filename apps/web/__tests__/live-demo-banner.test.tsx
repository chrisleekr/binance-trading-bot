// Criterion 6: when onboarding-status reports demoMode:true the app shell shows
// a persistent "Live demo" banner and hides the locked-surface entry point (the
// header Settings link, which fronts api-keys / backup / ai-provider /
// ops-notify). When false there is no banner and the nav is unchanged.
//
// The shell is expected to read demoMode from the onboarding-status query; the
// test seeds that query's cache directly (staleTime is Infinity), so no fetch
// is involved.
//
// RED: AppShell does not consume demoMode today, so the banner never renders and
// the Settings link is always present.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AppShell } from '@/app/app-shell';
import { NAV_ITEMS } from '@/app/bottom-nav';
import { ONBOARDING_STATUS_QUERY_KEY } from '@/features/auth/api/auth';
import { ProfileProvider } from '@/features/profile/lib/profile-context';

const renderShellWithDemo = (demoMode: boolean): void => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(ONBOARDING_STATUS_QUERY_KEY, { masterExists: true, demoMode });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <ProfileProvider>
          <AppShell>
            <p>page-content</p>
          </AppShell>
        </ProfileProvider>
      </QueryClientProvider>
    ),
  });
  const navRoutes = NAV_ITEMS.map((item) =>
    createRoute({ getParentRoute: () => rootRoute, path: item.to, component: () => null }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(navRoutes),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(<RouterProvider router={router} />);
};

describe('<AppShell> — Live demo banner', () => {
  it('renders a persistent "Live demo" banner and hides the Settings link when demoMode is true', () => {
    renderShellWithDemo(true);
    expect(screen.getByText(/live demo/i)).toBeInTheDocument();
    expect(screen.queryByTestId('header-account')).not.toBeInTheDocument();
  });

  it('renders no banner and keeps the Settings link when demoMode is false', () => {
    renderShellWithDemo(false);
    expect(screen.queryByText(/live demo/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('header-account')).toBeInTheDocument();
  });
});
