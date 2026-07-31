// `/accounts/$accountId/settings` — the per-account surface. Everything here
// acts on ONE Binance account: its display name, the environment its key pair
// talks to, and the stop-all-trading switch for its profiles. The "global" kill
// switch was never global (it always read the active accountId), so it belongs
// on the account it actually stops.

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { rootRoute } from '@/app/__root';
import { accountScopeRoute } from '@/features/account/routes/account-scope';
import { accountSettingsRoute } from '@/features/account/routes/account.settings';

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const account = (name: string) => ({
  id: ACCOUNT_ID,
  name,
  binanceMode: 'test' as const,
  apiKeyConfigured: true,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const stub = (path: string) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => null });

const setUp = (responder: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
  queryClient.setQueryData(['accounts'], [account('Main')]);
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      stub('/'),
      stub('/onboarding'),
      stub('/login'),
      accountScopeRoute.addChildren([accountSettingsRoute]),
    ]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [`/accounts/${ACCOUNT_ID}/settings`] }),
  });
  // The root route renders the app shell, which already carries the account
  // switcher — so a rename can be observed reaching it, not just the form.
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return { fetchMock, router, queryClient, ...utils };
};

describe('/accounts/$accountId/settings', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders a name input and a read-only Binance mode with its gloss', async () => {
    setUp((url) => {
      if (url.includes(`/accounts/${ACCOUNT_ID}`)) return json(account('Main'));
      return json({});
    });

    const name = (await screen.findByTestId('account-name-input')) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe('Main'));

    // The environment is fixed by the key pair the account holds: flipping it in
    // place would point live keys at testnet (and vice versa), so it is shown,
    // not edited.
    const mode = await screen.findByTestId('account-binance-mode');
    expect(mode).toHaveTextContent(/testnet/i);
    expect(mode.querySelector('input, select')).toBeNull();
    // The operator is not a trader: name the environment in plain words the
    // first time it appears.
    expect(screen.getByText(/practice money|not real money|no real money/i)).toBeInTheDocument();
  });

  it('submitting a rename PATCHes the account and the switcher shows the new name', async () => {
    // Server-side state, so the refetch that follows the rename serves the NEW
    // name — a fixed responder would pass even if nothing was invalidated.
    let stored = 'Main';
    const { fetchMock } = setUp((url, init) => {
      if (url.includes(`/accounts/${ACCOUNT_ID}`)) {
        if (init?.method === 'PATCH') {
          stored = (JSON.parse(String(init.body)) as { name: string }).name;
          return json(account(stored));
        }
        return json(account(stored));
      }
      if (url.endsWith('/accounts')) return json([account(stored)]);
      return json({});
    });

    const name = (await screen.findByTestId('account-name-input')) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe('Main'));

    const user = userEvent.setup();
    await user.clear(name);
    await user.type(name, 'Spot live');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      const patched = fetchMock.mock.calls.find(
        ([u, i]) => String(u).includes(`/accounts/${ACCOUNT_ID}`) && i?.method === 'PATCH',
      );
      expect(patched).toBeDefined();
      expect(JSON.parse(String((patched?.[1] as RequestInit).body))).toMatchObject({
        name: 'Spot live',
      });
    });

    // The rename must invalidate the accounts list, or the switcher keeps
    // showing the old name until a reload.
    const trigger = await screen.findByTestId('account-switcher-trigger');
    await waitFor(() => expect(trigger.textContent ?? '').toContain('Spot live'));
  });

  it('carries the stop-all-trading switch for this account', async () => {
    setUp((url) => {
      if (url.includes('/dashboard-aggregate')) {
        return json({
          profiles: [
            {
              profileId: '11111111-1111-4111-8111-111111111111',
              name: 'Real',
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
            },
          ],
        });
      }
      if (url.includes(`/accounts/${ACCOUNT_ID}`)) return json(account('Main'));
      return json({});
    });
    expect(await screen.findByTestId('global-kill')).toBeInTheDocument();
  });
});
