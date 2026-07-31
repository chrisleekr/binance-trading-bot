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

import { AccountSwitcher } from '@/features/account/components/account-switcher';
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

const setUp = () => {
  setActiveAccountId(ACCOUNT_ID);
  const qc = createQueryClient();
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
