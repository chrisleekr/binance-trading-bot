// `/settings` — the operator-level hub (timezone, ops notifications, AI
// provider, password, session, service worker). It carries the controls that
// belong to the login itself, not to one Binance account, so the account-scoped
// shortcuts (dust transfer, orphan orders) no longer live here: they hang off
// the account they act on and are reachable from the account surface.

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { rootRoute } from '@/app/__root';
import { settingsIndexRoute, settingsRoute } from '@/features/account/routes/settings';

type Json = Record<string, unknown>;

const json = (body: Json, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

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
  // Sidestep the onboarding redirect — pretend the master exists so /settings renders.
  queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
  const backupRestoreStub = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'backup-restore',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      stub('/'),
      stub('/onboarding'),
      stub('/login'),
      // /settings is a LAYOUT now, so the page under test is its index child
      // and backup-restore nests under it — which is what gives that page a
      // breadcrumb ancestor to name.
      settingsRoute.addChildren([settingsIndexRoute, backupRestoreStub]),
    ]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ['/settings'] }),
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return { fetchMock, router, ...utils };
};

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows no dust-transfer or orphan-orders nav cards', async () => {
    setUp(() => json({}));
    await screen.findByRole('heading', { name: /^settings$/i });
    // Both are account-scoped surfaces: they act on one Binance account's wallet
    // and order book, so this operator-level PAGE cannot name them without
    // silently picking an account for the operator. The sidebar can and does —
    // it reads the account from the URL — so scope the assertion to the page.
    const page = within(screen.getByRole('main'));
    expect(page.queryByText(/dust transfer/i)).toBeNull();
    expect(page.queryByText(/orphan orders/i)).toBeNull();
    // The operator-level shortcut that remains is still reachable (the shell's
    // sidebar links it too, hence getAllByText).
    expect(screen.getAllByText(/backup & restore/i).length).toBeGreaterThan(0);
  });

  it('renders the change-password + session sections and no service-worker control', async () => {
    setUp(() => json({}));
    await screen.findByRole('heading', { name: /^settings$/i });
    expect(screen.getByRole('heading', { name: /change password/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^session$/i })).toBeInTheDocument();
    // The service-worker "Unregister" emergency switch was removed; the PWA
    // registration path stays intact but the in-app control is gone.
    expect(screen.queryByRole('heading', { name: /service worker/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /unregister/i })).toBeNull();
  });

  it('rejects a confirm-password mismatch without calling the API', async () => {
    const { fetchMock } = setUp(() => json({}));
    await screen.findByRole('heading', { name: /^settings$/i });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/current password/i), 'old-pass-12345');
    await user.type(screen.getByLabelText(/^new password$/i), 'new-pass-12345');
    await user.type(screen.getByLabelText(/confirm new password/i), 'mismatch-12345');
    await user.click(screen.getByRole('button', { name: /update password/i }));
    expect(await screen.findByText(/does not match/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/auth/change-password'))).toBe(
      false,
    );
  });

  it('rejects a too-short new password without calling the API', async () => {
    const { fetchMock } = setUp(() => json({}));
    await screen.findByRole('heading', { name: /^settings$/i });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/current password/i), 'old-pass');
    await user.type(screen.getByLabelText(/^new password$/i), 'short');
    await user.type(screen.getByLabelText(/confirm new password/i), 'short');
    await user.click(screen.getByRole('button', { name: /update password/i }));
    expect(await screen.findByText(/at least 12 characters/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/auth/change-password'))).toBe(
      false,
    );
  });

  it('renders the timezone select seeded from /account/settings', async () => {
    setUp((url) => {
      if (url.includes('/account/settings')) return json({ timezone: 'Australia/Sydney' });
      return json({});
    });
    await screen.findByRole('heading', { name: /^timezone$/i });
    const select = (await screen.findByTestId('account-timezone-select')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('Australia/Sydney'));
  });

  it('PATCHes /account/settings when the operator changes the timezone', async () => {
    const { fetchMock } = setUp((url, init) => {
      if (url.includes('/account/settings')) {
        if (init?.method === 'PATCH') return json({ timezone: 'Asia/Seoul' });
        return json({ timezone: 'UTC' });
      }
      return json({});
    });
    const select = (await screen.findByTestId('account-timezone-select')) as HTMLSelectElement;
    const user = userEvent.setup();
    await user.selectOptions(select, 'Asia/Seoul');
    await waitFor(() => {
      const patched = fetchMock.mock.calls.some(
        ([u, i]) => String(u).includes('/account/settings') && i?.method === 'PATCH',
      );
      expect(patched).toBe(true);
    });
    expect(await screen.findByText(/times now shown in asia\/seoul/i)).toBeInTheDocument();
  });

  it('on a valid submit, posts to /auth/change-password and shows the ok banner', async () => {
    const { fetchMock } = setUp((url) => {
      if (url.includes('/api/auth/change-password')) return json({}, 200);
      return json({}, 404);
    });
    await screen.findByRole('heading', { name: /^settings$/i });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/current password/i), 'old-pass-12345');
    await user.type(screen.getByLabelText(/^new password$/i), 'new-pass-strong-1');
    await user.type(screen.getByLabelText(/confirm new password/i), 'new-pass-strong-1');
    await user.click(screen.getByRole('button', { name: /update password/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(await screen.findByText(/password updated/i)).toBeInTheDocument();
  });
});
