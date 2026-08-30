// The account switcher is the top of the scope stack. Two things it must get
// right: it is the only place the operator can reach an account's own settings
// (there is no other entry point), and its trigger stays quiet — a badge in the
// always-visible trigger competes with the trading status for attention, while
// the same badge inside the dropdown is exactly what disambiguates two accounts.

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

import { ACCOUNT_SETTINGS_ITEM } from '@/app/side-nav';
import { AccountSwitcher } from '@/features/account/components/account-switcher';
import { ONBOARDING_STATUS_QUERY_KEY } from '@/features/auth/api/auth';
import { createQueryClient } from '@/shared/lib/query-client';
import { setActiveAccountId } from '@/shared/lib/account-scope';

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const OTHER_ID = '00000000-0000-4000-8000-0000000000ad';

const account = (id: string, name: string, binanceMode: 'test' | 'live') => ({
  id,
  name,
  binanceMode,
  apiKeyConfigured: true,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const setUp = (demoMode = false) => {
  setActiveAccountId(ACCOUNT_ID);
  const qc = createQueryClient();
  // The switcher asks whether this is the public demo before offering the two controls that front guarded routes. The root loader primes this query at staleTime Infinity in the app, so seeding it is what the switcher sees at runtime.
  qc.setQueryData(ONBOARDING_STATUS_QUERY_KEY, { masterExists: true, demoMode });
  qc.setQueryData(
    ['accounts'],
    [account(ACCOUNT_ID, 'Testnet box', 'test'), account(OTHER_ID, 'Real money', 'live')],
  );

  const rootRoute = createRootRoute({
    component: () => (
      <>
        <AccountSwitcher />
        <Outlet />
      </>
    ),
  });
  const accountRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/accounts/$accountId',
    component: () => <Outlet />,
  });
  const accountIndexRoute = createRoute({
    getParentRoute: () => accountRoute,
    path: '/',
    component: () => null,
  });
  const accountSettingsStub = createRoute({
    getParentRoute: () => accountRoute,
    path: '/settings',
    component: () => <div data-testid="account-settings-page" />,
  });
  const accountNewStub = createRoute({
    getParentRoute: () => rootRoute,
    path: '/accounts/new',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      accountNewStub,
      accountRoute.addChildren([accountIndexRoute, accountSettingsStub]),
    ]),
    history: createMemoryHistory({ initialEntries: [`/accounts/${ACCOUNT_ID}`] }),
  });

  const utils = render(
    <QueryClientProvider client={qc}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return { router, ...utils };
};

describe('<AccountSwitcher>', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers a Manage account item', async () => {
    const user = userEvent.setup();
    const { router } = setUp();
    await user.click(await screen.findByTestId('account-switcher-trigger'));
    await user.click(await screen.findByTestId('account-switcher-manage'));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/accounts/${ACCOUNT_ID}/settings`),
    );
  });

  // The switcher navigates from `onSelect` handlers rather than rendering links, so the whole-shell href sweep in demo-nav-visibility.test.tsx is structurally blind to it. These two cases are the only thing standing between the demo operator and a control that opens the api-key page or posts a new account.
  it('drops both demo-guarded controls in the live demo', async () => {
    const user = userEvent.setup();
    setUp(true);
    await user.click(await screen.findByTestId('account-switcher-trigger'));
    // The list really opened, so the absences below are absences rather than an unrendered popover.
    expect(await screen.findByTestId(`account-switcher-item-${ACCOUNT_ID}`)).toBeInTheDocument();

    // Both pinned absent rather than derived through `visibleInDemo(ACCOUNT_SETTINGS_ITEM, true)`. Deriving would track the declaration wherever it went: flipping `demoHidden` to false is itself the regression, since this row opens the account's api-key surface and POST /accounts is guarded, and a derived expectation would flip with it and stay green. The declaration is what this file exists to catch being wrong, so it cannot also be the source of truth for the answer.
    // Pinned separately so a flipped flag fails here, naming the cause, rather than only as an unexplained visible row below.
    expect(ACCOUNT_SETTINGS_ITEM.demoHidden).toBe(true);
    expect(screen.queryByTestId('account-switcher-manage')).toBeNull();
    expect(screen.queryByTestId('account-switcher-add')).toBeNull();
  });

  it('keeps both controls outside the demo', async () => {
    const user = userEvent.setup();
    setUp(false);
    await user.click(await screen.findByTestId('account-switcher-trigger'));
    expect(await screen.findByTestId('account-switcher-manage')).toBeInTheDocument();
    expect(screen.getByTestId('account-switcher-add')).toBeInTheDocument();
  });

  it('renders no Testnet badge in the trigger but keeps it on the dropdown list items', async () => {
    const user = userEvent.setup();
    setUp();
    const trigger = await screen.findByTestId('account-switcher-trigger');
    expect(trigger).toHaveTextContent('Testnet box'); // the name, not a badge
    expect(within(trigger).queryByText(/^testnet$/i)).toBeNull();

    // Inside the list the badge earns its place: it is how a testnet account is
    // told apart from the real-money one at the moment of choosing.
    await user.click(trigger);
    const item = await screen.findByTestId(`account-switcher-item-${ACCOUNT_ID}`);
    expect(within(item).getByText(/^testnet$/i)).toBeInTheDocument();
    const live = await screen.findByTestId(`account-switcher-item-${OTHER_ID}`);
    expect(within(live).queryByText(/^testnet$/i)).toBeNull();
  });
});
