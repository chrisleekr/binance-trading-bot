// ProfileManageCard — the operations panel in the Manage slide-over.
//
// It used to be a grouped launcher into the profile's pages, duplicating the sidebar and the mobile Profiles sheet, both of which show WHERE YOU ARE among those pages while a modal can show neither. What is left is what only a drawer can offer: the two actions that have no page of their own, Investigate and Reconcile fees.

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
import { ONBOARDING_STATUS_QUERY_KEY } from '@/features/auth/api/auth';
import * as profilesMutations from '@/features/profile/api/profiles-mutations';
import { ProfileManageCard } from '@/features/profile/components/profile-manage-card';
import { PROFILE_SECTIONS } from '@/features/profile/lib/profile-sections';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// Fault injection for the registry-independence check. The card must not read PROFILE_SECTIONS at all, so this hands it a group and an item that exist nowhere in the app: a card still looping the registry renders the injected tile, and no assertion about the real ten sections could tell that apart from a correct card, because a correct card renders none of them either way.
vi.mock('../src/features/profile/lib/profile-sections', async () => {
  const actual = await vi.importActual<
    typeof import('../src/features/profile/lib/profile-sections')
  >('../src/features/profile/lib/profile-sections');
  const injected = {
    group: 'Injected',
    items: [
      {
        to: '/accounts/$accountId/profiles/$profileId/risk',
        label: 'Injected section',
        testId: 'injected',
        icon: actual.PROFILE_NAV_ITEMS[0]?.icon,
      },
    ],
  };
  return { ...actual, PROFILE_SECTIONS: [...actual.PROFILE_SECTIONS, injected] };
});

const PID = '00000000-0000-4000-8000-0000000000c1';

const setUp = (onInvestigate: () => void = () => undefined, demoMode = false): void => {
  // The card now subscribes to onboarding-status (Reconcile fees is demo-guarded), and createQueryClient invalidates every ACTIVE query after any mutation regardless of staleTime — so the reconcile tests below refetch it for real. Answer that one path and let anything else stay as loud as the suite's sentinel would.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/auth/onboarding-status')) {
        return new Response(JSON.stringify({ masterExists: true, demoMode }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch in profile-manage-card test: ${url}`);
    }),
  );
  const qc = createQueryClient();
  // The root loader primes this query at staleTime Infinity in the app, so seeding it is what the card sees on first paint.
  qc.setQueryData(ONBOARDING_STATUS_QUERY_KEY, { masterExists: true, demoMode });
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
      // The one destination the injected section points at, so a card that still renders it produces a real link rather than dying on an unresolvable route — the failure has to be "a link is here", not "the tree is malformed".
      createRoute({
        getParentRoute: () => root,
        path: '/accounts/$accountId/profiles/$profileId/risk',
        component: () => null,
      }),
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

  it('renders no navigation link at all, the persistent navs owning that job', async () => {
    setUp();
    const card = await screen.findByTestId('profile-manage-card');
    // Every profile page is one row away in the sidebar and two taps away in the mobile Profiles sheet; a third copy inside a modal could only ever say where to go, never where you are.
    expect(within(card).queryAllByRole('link')).toEqual([]);
  });

  it('surfaces nothing when the sections registry grows, because it no longer reads it', async () => {
    setUp();
    const card = await screen.findByTestId('profile-manage-card');
    // The injection is armed. `vi.mock` factories are lazy, and the card no longer imports this module, so without reading it here the three absences below could all hold because the extra group was never created.
    expect(PROFILE_SECTIONS.some((g) => g.group === 'Injected')).toBe(true);
    // The mocked registry above carries an extra group and item. A card looping PROFILE_SECTIONS renders it; one that does not, cannot.
    expect(within(card).queryByText('Injected section')).toBeNull();
    expect(within(card).queryByText('Injected')).toBeNull();
    expect(screen.queryByTestId('profile-manage-injected')).toBeNull();
  });

  it('keeps both inline actions, which have no page of their own', async () => {
    setUp();
    await screen.findByTestId('profile-manage-card');
    expect(screen.getByTestId('profile-manage-investigate')).toBeVisible();
    expect(screen.getByTestId('profile-manage-reconcile-fees')).toBeVisible();
    // The lifecycle/admin actions moved to the General page — they are not here either.
    expect(screen.queryByTestId('profile-manage-rename')).toBeNull();
    expect(screen.queryByTestId('profile-manage-delete')).toBeNull();
    expect(screen.queryByTestId('profile-manage-enable')).toBeNull();
  });

  it('replaces Reconcile fees with a reason in the live demo', async () => {
    // The route 403s for the demo operator, and unlike Investigate this button has no drawer of its own to explain itself in.
    setUp(() => undefined, true);
    const card = await screen.findByTestId('profile-manage-card');
    // Asserts the COPY, not just the node: `I18nKey` is `${string}.${string}` and the fallback provider returns the key itself when it is missing, so a presence-only check passes while the demo renders the raw string `demo.reconcile_fees_unavailable`. A literal fragment, never `t(...)` — comparing against `t` would return the key on both sides and be a tautology.
    expect(within(card).getByTestId('reconcile-fees-demo-unavailable')).toHaveTextContent(
      /turned off in the live demo/,
    );
    expect(screen.queryByTestId('profile-manage-reconcile-fees')).toBeNull();
    // The card is not an empty shell: Investigate stays, and its own drawer carries the demo explanation.
    expect(within(card).getByTestId('profile-manage-investigate')).toBeVisible();
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
