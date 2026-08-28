// ProfilePageHeader — the shared header on every profile management sub-page.
// The contract is "breadcrumb + title + profile name + the status pill and
// Manage slide-over trigger in the header actions slot". This locks that
// composition so a future edit cannot silently drop the Manage trigger, break
// the route back up to the owning profile, or re-add the Investigate trigger
// that deliberately lives only on the profile landing header.

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ONBOARDING_STATUS_QUERY_KEY } from '@/features/auth/api/auth';
import { diagnosisRunsQueryKey } from '@/features/profile/api/diagnosis';
import { profileQueryKey } from '@/features/profile/api/profile';
import { profileDashboardQueryKey } from '@/features/profile/api/profile-dashboard';
import { ProfilePageHeader } from '@/features/profile/components/profile-page-header';
import { createQueryClient } from '@/shared/lib/query-client';

import type { DashboardAggregateResponse } from '@app/contracts';

// ProfileManageCard (mounted lazily inside the slide-over) imports sonner; the
// sheet stays closed here so it never fires, but mock defensively.
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const PID = '00000000-0000-4000-8000-0000000000c1';
// Matches the global test-setup default active account; the aggregate cache is
// keyed by it, so the header reads the same key it would at runtime.
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';

const row = (): DashboardAggregateResponse['profiles'][number] => ({
  profileId: PID,
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
});

const PROFILE_PATH = `/accounts/${ACCOUNT_ID}/profiles/${PID}`;

const renderHeader = async (): Promise<void> => {
  const qc = createQueryClient();
  qc.setQueryData(['dashboard-aggregate', ACCOUNT_ID], { profiles: [row()] });
  qc.setQueryData(profileQueryKey(PID), { name: 'btc-real' });
  // The Manage slide-over keeps the investigation drawer mounted (closed), and
  // it rehydrates the newest run; seed an empty history so the header renders
  // from cache instead of reaching for the api.
  qc.setQueryData(diagnosisRunsQueryKey(PID), []);
  // That drawer also asks whether this is the public demo, which decides whether it offers a start control. The root loader primes this query at staleTime Infinity in the app, so seeding it here is what the header sees at runtime.
  qc.setQueryData(ONBOARDING_STATUS_QUERY_KEY, { masterExists: true, demoMode: false });
  qc.setQueryData(profileDashboardQueryKey(PID), {
    profileId: PID,
    enabled: true,
    binanceMode: 'live',
    balances: [],
    totalProfit: '0',
    enabledNotifierCount: 1,
    symbols: [],
    cachedAt: '2026-06-04T00:00:00.000Z',
  });
  const root = createRootRoute({
    component: () => (
      <>
        <ProfilePageHeader profileId={PID} title="Strategy config" />
        <Outlet />
      </>
    ),
  });
  // The header sits on a sub-page of one profile, so the tree it navigates in
  // is the real account-scoped one, not a bare '/'.
  const accountRoute = createRoute({
    getParentRoute: () => root,
    path: '/accounts/$accountId',
    component: () => <Outlet />,
  });
  const profileRoute = createRoute({
    getParentRoute: () => accountRoute,
    path: '/profiles/$profileId',
    component: () => <Outlet />,
  });
  const configRoute = createRoute({
    getParentRoute: () => profileRoute,
    path: '/config',
    component: () => null,
  });
  const profileIndexRoute = createRoute({
    getParentRoute: () => profileRoute,
    path: '/',
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/', component: () => null }),
      accountRoute.addChildren([profileRoute.addChildren([profileIndexRoute, configRoute])]),
    ]),
    history: createMemoryHistory({ initialEntries: [`${PROFILE_PATH}/config`] }),
  });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  await act(async () => {
    await router.load();
  });
};

describe('<ProfilePageHeader>', () => {
  it('names the owning profile as a breadcrumb ancestor, with the accountId preserved', async () => {
    await renderHeader();

    // The same guard the old Back link carried: from a profile sub-page the
    // parent is that profile, and the link must carry the account it lives
    // under or the operator lands on an account-less route. It is a named
    // ancestor now rather than an unnamed step, so assert on the profile's name.
    const crumb = await screen.findByRole('link', { name: 'btc-real' });
    expect(crumb).toHaveAttribute('href', PROFILE_PATH);
    // And it must not claim to be the page it links away from — the defect the
    // breadcrumb replaced.
    expect(crumb).not.toHaveAttribute('aria-current');
  });

  it('renders the title + profile name and the Manage trigger', async () => {
    await renderHeader();

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Strategy config');
    // The profile is named once, by the breadcrumb. It used to also sit in the
    // header's meta slot, so the same header stated it twice.
    expect(screen.getAllByText('btc-real')).toHaveLength(1);

    // The Manage slide-over trigger replaces the old always-on section strip as
    // the way to reach other sections from any page.
    expect(screen.getByTestId('open-manage-sheet')).toBeInTheDocument();
    // Investigate is NOT here. It renders once, on the profile landing header,
    // and is reachable from these pages through the Manage slide-over — a
    // profile-wide diagnostic offered from the Discovery editor reads as though
    // it only investigates discovery.
    expect(screen.queryByTestId('open-investigate')).toBeNull();
    // Status pill renders in the actions slot.
    expect(screen.getByTestId('profile-status-state')).toHaveTextContent(/Enabled/i);
  });
});
