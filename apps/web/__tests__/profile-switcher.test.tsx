import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProfileSwitcher } from '@/features/profile/components/profile-switcher';
import { createQueryClient } from '@/shared/lib/query-client';
import { setActiveAccountId } from '@/shared/lib/account-scope';

import type { DashboardAggregateResponse } from '@app/contracts';

const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

const aggregate = (rows: DashboardAggregateResponse['profiles']): DashboardAggregateResponse => ({
  profiles: rows,
});

const row = (
  overrides: Partial<DashboardAggregateResponse['profiles'][number]>,
): DashboardAggregateResponse['profiles'][number] => ({
  profileId: '11111111-1111-4111-8111-111111111111',
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
  ...overrides,
});

// The switcher is URL-driven now: the active profile is the route `$profileId`
// under `/accounts/$accountId`. `initialPath` places the test on the account
// overview (default) or a specific profile route.
const setUp = (
  data: DashboardAggregateResponse,
  { initialPath = `/accounts/${ACCOUNT_ID}` }: { initialPath?: string } = {},
) => {
  setActiveAccountId(ACCOUNT_ID);
  const qc = createQueryClient();
  qc.setQueryData(['dashboard-aggregate', ACCOUNT_ID], data);

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const accountRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/accounts/$accountId',
    component: () => <ProfileSwitcher />,
  });
  const accountIndexRoute = createRoute({
    getParentRoute: () => accountRoute,
    path: '/',
    component: () => null,
  });
  const profileRoute = createRoute({
    getParentRoute: () => accountRoute,
    path: '/profiles/$profileId',
    component: () => <div data-testid="profile-page" />,
  });
  const profileNewRoute = createRoute({
    getParentRoute: () => accountRoute,
    path: '/profiles/new',
    component: () => <div data-testid="profile-new-page" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      accountRoute.addChildren([accountIndexRoute, profileNewRoute, profileRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  const utils = render(
    <QueryClientProvider client={qc}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return { router, queryClient: qc, ...utils };
};

describe('<ProfileSwitcher>', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows "All profiles" by default off a profile route', async () => {
    setUp(
      aggregate([
        row({ profileId: 'a', name: 'profile-a' }),
        row({ profileId: 'b', name: 'profile-b' }),
      ]),
    );
    const trigger = await screen.findByTestId('profile-switcher-trigger');
    expect(trigger.textContent ?? '').toMatch(/all profiles/i);
  });

  it('renders a global kill-switch indicator when any profile has it', async () => {
    setUp(
      aggregate([
        row({ profileId: 'a', name: 'profile-a' }),
        row({ profileId: 'b', name: 'profile-b', killSwitch: true }),
      ]),
    );
    expect(await screen.findByTestId('profile-switcher-killswitch')).toBeInTheDocument();
  });

  it('hides kill-switch indicator when no profile has it active', async () => {
    setUp(aggregate([row({ profileId: 'a', name: 'profile-a' })]));
    await screen.findByTestId('profile-switcher-trigger');
    expect(screen.queryByTestId('profile-switcher-killswitch')).toBeNull();
  });

  it('selecting a profile navigates to it under the account', async () => {
    const user = userEvent.setup();
    const { router } = setUp(
      aggregate([
        row({ profileId: 'a', name: 'profile-a' }),
        row({ profileId: 'b', name: 'profile-b' }),
      ]),
    );
    await user.click(await screen.findByTestId('profile-switcher-trigger'));
    await user.click(await screen.findByTestId('profile-switcher-item-b'));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/accounts/${ACCOUNT_ID}/profiles/b`);
    });
  });

  it('selecting "All profiles" off a profile route navigates to the account overview', async () => {
    const user = userEvent.setup();
    const { router } = setUp(aggregate([row({ profileId: 'a', name: 'profile-a' })]), {
      initialPath: `/accounts/${ACCOUNT_ID}/profiles/a`,
    });
    await user.click(await screen.findByTestId('profile-switcher-trigger'));
    await user.click(await screen.findByTestId('profile-switcher-item-all'));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/accounts/${ACCOUNT_ID}`);
    });
  });

  it('pins the active-route profile above the rest, under the "All profiles" entry', async () => {
    const user = userEvent.setup();
    setUp(
      aggregate([
        row({ profileId: 'a', name: 'aaa-profile' }),
        row({ profileId: 'b', name: 'zzz-profile' }),
      ]),
      { initialPath: `/accounts/${ACCOUNT_ID}/profiles/b` },
    );
    const trigger = await screen.findByTestId('profile-switcher-trigger');
    expect(trigger.textContent ?? '').toContain('zzz-profile');
    await user.click(trigger);
    const items = await screen.findAllByTestId(/profile-switcher-item-/);
    expect(items[0]?.getAttribute('data-testid')).toBe('profile-switcher-item-all');
    expect(items[1]?.getAttribute('data-testid')).toBe('profile-switcher-item-b');
  });

  it('shows "All profiles" when the route profile is not in the live list', async () => {
    setUp(aggregate([row({ profileId: 'a', name: 'profile-a' })]), {
      initialPath: `/accounts/${ACCOUNT_ID}/profiles/gone`,
    });
    const trigger = await screen.findByTestId('profile-switcher-trigger');
    expect(trigger.textContent ?? '').toMatch(/all profiles/i);
  });

  it('shows the no-active label when there are no profiles', async () => {
    setUp(aggregate([]));
    const trigger = await screen.findByTestId('profile-switcher-trigger');
    expect(trigger.textContent ?? '').toMatch(/select a profile/i);
  });

  it('offers a New profile item', async () => {
    // Creating a profile is a switcher action, mirroring the account switcher's
    // "New account": the overview no longer carries a standalone button for it.
    const user = userEvent.setup();
    const { router } = setUp(aggregate([row({ profileId: 'a', name: 'profile-a' })]));
    await user.click(await screen.findByTestId('profile-switcher-trigger'));
    await user.click(await screen.findByTestId('profile-switcher-new'));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/accounts/${ACCOUNT_ID}/profiles/new`);
    });
  });
});
