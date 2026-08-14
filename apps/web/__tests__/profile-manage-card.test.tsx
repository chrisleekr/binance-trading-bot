// ProfileManageCard — the grouped navigation menu in the Manage slide-over.
// Mostly navigation (the lifecycle/admin actions moved to the General page); the
// two inline actions are Investigate and Reconcile fees. Tests cover the menu
// inventory, that each tile navigates to its page, and both actions.

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';

import { createQueryClient } from '@/shared/lib/query-client';
import * as profilesMutations from '@/features/profile/api/profiles-mutations';
import { ProfileManageCard } from '@/features/profile/components/profile-manage-card';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const PID = '00000000-0000-4000-8000-0000000000c1';

// (manage tile testId → route segment it navigates to). gate is "live-gate".
const TILE_NAV: readonly (readonly [string, string])[] = [
  ['config', 'config'],
  ['risk', 'risk'],
  ['live-gate', 'gate'],
  ['discovery', 'discovery'],
  ['notifications', 'notifications'],
  ['backtest', 'backtest'],
  ['history', 'history'],
  ['bulk-order', 'bulk-order'],
  ['general', 'general'],
];

const setUp = (onInvestigate: () => void = () => undefined): void => {
  const qc = createQueryClient();
  const root = createRootRoute({
    component: () => (
      <>
        <ProfileManageCard profileId={PID} onInvestigate={onInvestigate} />
        <Outlet />
      </>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: '/',
        component: () => <output data-testid="route-index" />,
      }),
      ...TILE_NAV.map(([, seg]) =>
        createRoute({
          getParentRoute: () => root,
          // Tiles navigate account-nested now; the card supplies the active
          // account via useActiveAccountId (the global test-setup default).
          path: `/accounts/$accountId/profiles/$profileId/${seg}`,
          component: () => <output data-testid={`route-${seg}`} />,
        }),
      ),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
};

describe('<ProfileManageCard>', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders every navigation tile plus the inline actions, grouped', async () => {
    setUp();
    expect(await screen.findByTestId('profile-manage-card')).toBeInTheDocument();
    for (const [testId] of TILE_NAV) {
      expect(screen.getByTestId(`profile-manage-${testId}`)).toBeVisible();
    }
    // Scoped to the group heading, not just present somewhere: the user guide
    // sends the operator to Analyze by name, so the group is part of the
    // contract and a whole-card query would stay green after a move.
    const groupOf = (name: string): HTMLElement =>
      screen.getByRole('heading', { name }).parentElement as HTMLElement;
    expect(within(groupOf('Analyze')).getByTestId('profile-manage-investigate')).toBeVisible();
    expect(within(groupOf('Operate')).getByTestId('profile-manage-reconcile-fees')).toBeVisible();
    // The lifecycle/admin actions moved to the General page — they are no longer
    // tiles in the menu.
    expect(screen.queryByTestId('profile-manage-rename')).toBeNull();
    expect(screen.queryByTestId('profile-manage-delete')).toBeNull();
    expect(screen.queryByTestId('profile-manage-enable')).toBeNull();
  });

  it.each(TILE_NAV)('the %s tile navigates to its page', async (testId, seg) => {
    setUp();
    await screen.findByTestId('profile-manage-card');
    await userEvent.click(screen.getByTestId(`profile-manage-${testId}`));
    await waitFor(() => expect(screen.getByTestId(`route-${seg}`)).toBeInTheDocument());
  });

  it('asks the caller to open the investigation rather than opening one itself', async () => {
    // The card cannot own the drawer: it renders INSIDE a modal dialog, and a
    // second modal mounted from here would nest two focus traps. It reports the
    // intent and the sheet that owns both does the handover.
    const onInvestigate = vi.fn();
    setUp(onInvestigate);
    await screen.findByTestId('profile-manage-card');

    await userEvent.click(screen.getByTestId('profile-manage-investigate'));

    expect(onInvestigate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('investigate-sheet')).toBeNull();
  });

  it('enqueues fee reconciliation and toasts on success', async () => {
    const reconcile = vi
      .spyOn(profilesMutations, 'reconcileProfileFees')
      .mockResolvedValue(undefined);
    vi.mocked(toast.success).mockClear();
    setUp();
    await screen.findByTestId('profile-manage-card');

    await userEvent.click(screen.getByTestId('profile-manage-reconcile-fees'));

    await waitFor(() => expect(reconcile).toHaveBeenCalledWith(PID));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('toasts an error when fee reconciliation fails to enqueue', async () => {
    vi.spyOn(profilesMutations, 'reconcileProfileFees').mockRejectedValue(new Error('queue down'));
    vi.mocked(toast.error).mockClear();
    setUp();
    await screen.findByTestId('profile-manage-card');

    await userEvent.click(screen.getByTestId('profile-manage-reconcile-fees'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('queue down'));
  });
});
