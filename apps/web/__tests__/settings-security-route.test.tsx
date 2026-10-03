// `/settings/security`: sign-in methods, signed-in browsers, agent access, limits and activity. These cases pin what the page sends: sensitive actions carry the confirmation the server requires, and the limits form offers exactly the ranges the shared contract enforces.

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

import { DEFAULT_AUTH_SECURITY_SETTINGS } from '@app/contracts';
import { createQueryClient } from '@/shared/lib/query-client';
import { rootRoute } from '@/app/__root';
import { settingsIndexRoute, settingsRoute } from '@/features/account/routes/settings';
import { securityRoute } from '@/features/account/routes/settings.security';

const json = (body: unknown, status = 200): Response =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const SESSIONS = {
  sessions: [
    {
      id: 's-current',
      createdAt: '2026-09-29T00:00:00.000Z',
      lastActiveAt: '2026-09-29T01:00:00.000Z',
      expiresAt: '2026-10-06T00:00:00.000Z',
      ipAddress: '198.51.100.1',
      userAgent: 'This browser',
      current: true,
    },
    {
      id: 's-other',
      createdAt: '2026-09-28T00:00:00.000Z',
      lastActiveAt: '2026-09-28T01:00:00.000Z',
      expiresAt: '2026-10-05T00:00:00.000Z',
      ipAddress: '203.0.113.9',
      userAgent: 'Other browser',
      current: false,
    },
  ],
};

const setUp = (
  {
    singleSignOnConfigured = false,
    passwordSignIn = true,
    ...session
  }: {
    hasPassword: boolean;
    singleSignOnLinked: boolean;
    singleSignOnEmail?: string | null;
    /** Whether the server offers single sign-on; the method row reads "Not configured on the server" otherwise. */
    singleSignOnConfigured?: boolean;
    /** Whether password sign-in is switched on at the server. */
    passwordSignIn?: boolean;
  } = {
    hasPassword: true,
    singleSignOnLinked: false,
  },
  initialPath = '/settings/security',
  /** A URL fragment whose non-GET request the server refuses as a wrong confirmation password. */
  refusedWrite?: string,
  /** The refusal code for `refusedWrite`. */
  refusal: { code: string; message: string } = {
    code: 'INVALID_PASSWORD',
    message: 'The password is not correct.',
  },
) => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (refusedWrite !== undefined && method !== 'GET' && url.includes(refusedWrite))
        return json({ error: refusal }, 403);
      if (url.includes('/auth/session') && !url.includes('/auth/sessions'))
        return json({
          userId: '00000000-0000-4000-8000-000000000001',
          email: 'op@example.test',
          displayName: null,
          singleSignOnEmail: null,
          ...session,
        });
      if (url.includes('/auth/sessions') && method === 'GET') return json(SESSIONS);
      if (url.includes('/auth/security-settings')) return json(DEFAULT_AUTH_SECURITY_SETTINGS);
      if (url.includes('/auth/security-events')) {
        return json({
          events: [
            {
              id: 'e1',
              event: 'sign-in-failed',
              method: 'password',
              reason: 'invalid_credentials',
              ipAddress: '203.0.113.50',
              userAgent: null,
              count: 4,
              detail: {},
              createdAt: '2026-09-29T00:00:00.000Z',
            },
            {
              id: 'e2',
              event: 'sign-in-succeeded',
              method: 'singleSignOn',
              reason: 'none',
              ipAddress: '198.51.100.9',
              userAgent: null,
              count: 1,
              detail: { account: 'me@example.test' },
              createdAt: '2026-09-29T01:00:00.000Z',
            },
            {
              id: 'e3',
              event: 'signed-out-everywhere',
              method: 'none',
              reason: 'none',
              ipAddress: '198.51.100.10',
              userAgent: null,
              count: 1,
              detail: {},
              createdAt: '2026-09-29T02:00:00.000Z',
            },
          ],
          nextBefore: null,
        });
      }
      if (method === 'POST' || method === 'PATCH') return json({}, 204);
      return json({});
    }),
  );
  const queryClient = createQueryClient();
  queryClient.setQueryData(['auth', 'onboarding-status'], {
    masterExists: true,
    demoMode: false,
    passwordSignIn,
    singleSignOn: singleSignOnConfigured
      ? { buttonLabel: 'Sign in with Auth0', available: true }
      : null,
    passwordSignInForced: false,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/login', component: () => null }),
      settingsRoute.addChildren([settingsIndexRoute, securityRoute]),
    ]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return { calls, router };
};

describe('SecurityPage', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists signed-in browsers and signs out another one without asking for the password', async () => {
    const { calls } = setUp();
    expect(await screen.findByText('Other browser')).toBeInTheDocument();
    const user = userEvent.setup();
    const other = screen.getByText('Other browser').closest('li') as HTMLElement;
    await user.click(within(other).getByRole('button', { name: /sign out/i }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.url.endsWith('/auth/sessions/s-other/revoke')),
      ).toBe(true),
    );
  });

  it('refuses sign-out-everywhere until the operator confirms, then sends the password as proof', async () => {
    const { calls, router } = setUp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /sign out everywhere/i }));
    expect(calls.some((c) => c.url.includes('/sign-out-everywhere'))).toBe(false);
    await user.type(screen.getByLabelText(/current password/i), 'operator-password-123');
    await user.click(screen.getByRole('button', { name: /sign out everywhere/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    const sent = calls.find((c) => c.url.includes('/sign-out-everywhere'));
    expect(sent?.body).toEqual({
      reauthentication: { method: 'password', password: 'operator-password-123' },
    });
  });

  it('while password sign-in is off, offers no password field and confirms with single sign-on even when a password is stored', async () => {
    const { calls } = setUp({
      hasPassword: true,
      singleSignOnLinked: true,
      singleSignOnConfigured: true,
      passwordSignIn: false,
    });
    const user = userEvent.setup();
    // Checked before the click: a successful sign-out leaves this page.
    await screen.findByRole('button', { name: /sign in again with single sign-on/i });
    expect(screen.queryByLabelText(/current password/i)).toBeNull();
    await user.click(screen.getByRole('button', { name: /sign out everywhere/i }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.includes('/sign-out-everywhere'))?.body).toEqual({
        reauthentication: { method: 'singleSignOn' },
      }),
    );
  });

  it('points at "Confirm it\'s you" in plain words when the server wants a fresh single sign-on', async () => {
    const message =
      'Sign in again with single sign-on, then repeat this change within five minutes.';
    const { router } = setUp(
      { hasPassword: false, singleSignOnLinked: true, singleSignOnConfigured: true },
      undefined,
      '/sign-out-everywhere',
      { code: 'REAUTHENTICATION_REQUIRED', message },
    );
    const user = userEvent.setup();
    expect(screen.queryByTestId('security-confirm-prompt')).toBeNull();
    await user.click(await screen.findByRole('button', { name: /sign out everywhere/i }));
    const prompt = await screen.findByTestId('security-confirm-prompt');
    expect(prompt).toHaveTextContent(message);
    expect(document.body).not.toHaveTextContent('REAUTHENTICATION_REQUIRED');
    expect(router.state.location.pathname).toBe('/settings/security');
  });

  it('offers each limit with the range the server enforces', async () => {
    setUp();
    const user = userEvent.setup();
    await user.click(await screen.findByText('Sign-in limits'));
    const idle = screen.getByLabelText(/sign out after inactivity/i);
    expect(idle).toHaveAttribute('min', '1');
    expect(idle).toHaveAttribute('max', '24');
    expect(idle).toHaveValue(8);
    const retention = screen.getByLabelText(/keep for/i);
    expect(retention).toHaveAttribute('min', '365');
    // A grouped field sits behind `.prefault().refine()` in the contract, so its range is read through a different unwrap than a top-level field.
    const firstBlock = screen.getByLabelText(/first block \(seconds\)/i);
    expect(firstBlock).toHaveAttribute('min', '300');
    expect(firstBlock).toHaveAttribute('max', '86400');
    expect(firstBlock).toHaveValue(900);
    expect(firstBlock.parentElement).toHaveTextContent('Allowed 300 to 86400');
  });

  it('saves the whole limits document together with the confirmation', async () => {
    const { calls } = setUp();
    const user = userEvent.setup();
    await user.click(await screen.findByText('Sign-in limits'));
    await user.type(screen.getByLabelText(/current password/i), 'operator-password-123');
    const idle = screen.getByLabelText(/sign out after inactivity/i);
    await user.clear(idle);
    await user.type(idle, '4');
    await user.click(screen.getByRole('button', { name: /save limits/i }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'PATCH' && c.url.includes('/security-settings'))).toBe(
        true,
      ),
    );
    const sent = calls.find((c) => c.method === 'PATCH' && c.url.includes('/security-settings'));
    expect(sent?.body).toEqual({
      settings: { ...DEFAULT_AUTH_SECURITY_SETTINGS, sessionIdleTimeoutHours: 4 },
      reauthentication: { method: 'password', password: 'operator-password-123' },
    });
  });

  it('names the group, the field and its range when a limit is out of range, and sends nothing', async () => {
    const { calls } = setUp();
    const user = userEvent.setup();
    await user.click(await screen.findByText('Sign-in limits'));
    await user.type(screen.getByLabelText(/current password/i), 'operator-password-123');
    // Two groups label their field "Attempts", so the message must say which one.
    const [fromOneAddress] = screen.getAllByLabelText(/^attempts \(tries\)$/i);
    if (fromOneAddress === undefined) throw new Error('attempts field missing');
    await user.clear(fromOneAddress);
    await user.type(fromOneAddress, '11');
    await user.click(screen.getByRole('button', { name: /save limits/i }));
    expect(
      await screen.findByText(
        'Password attempts from one address, attempts: enter a whole number from 1 to 10.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/too big/i)).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('explains a rule spanning two fields in words, not with the range of the field it points at', async () => {
    const { calls } = setUp();
    const user = userEvent.setup();
    await user.click(await screen.findByText('Sign-in limits'));
    await user.type(screen.getByLabelText(/current password/i), 'operator-password-123');
    // 20 is within the inactivity field's own range of 1 to 24, but longer than the 12-hour absolute lifetime.
    const idle = screen.getByLabelText(/sign out after inactivity/i);
    await user.clear(idle);
    await user.type(idle, '20');
    const absolute = screen.getByLabelText(/sign out after sign-in, however active/i);
    await user.clear(absolute);
    await user.type(absolute, '12');
    await user.click(screen.getByRole('button', { name: /save limits/i }));
    expect(
      await screen.findByText(
        'Sign-out after inactivity must not be longer than sign-out after sign-in.',
      ),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('refetches security activity after a refused save, because the refusal itself is recorded', async () => {
    const { calls } = setUp(undefined, undefined, '/security-settings');
    const user = userEvent.setup();
    await user.click(await screen.findByText('Sign-in limits'));
    await screen.findByText(/a sign-in attempt was refused/i);
    const activityReads = (): number =>
      calls.filter((c) => c.method === 'GET' && c.url.includes('/security-events')).length;
    const before = activityReads();
    await user.type(screen.getByLabelText(/current password/i), 'not-the-password');
    const idle = screen.getByLabelText(/sign out after inactivity/i);
    await user.clear(idle);
    await user.type(idle, '4');
    await user.click(screen.getByRole('button', { name: /save limits/i }));
    expect(await screen.findByText(/the password is not correct/i)).toBeInTheDocument();
    await waitFor(() => expect(activityReads()).toBeGreaterThan(before));
  });

  it('refetches security activity after signing out other browsers', async () => {
    const { calls } = setUp();
    const user = userEvent.setup();
    await screen.findByText(/a sign-in attempt was refused/i);
    const activityReads = (): number =>
      calls.filter((c) => c.method === 'GET' && c.url.includes('/security-events')).length;
    const before = activityReads();
    await user.click(screen.getByRole('button', { name: /sign out other browsers/i }));
    await waitFor(() => expect(activityReads()).toBeGreaterThan(before));
  });

  it('explains a refused single sign-on link in plain words and never shows the raw code', async () => {
    setUp(undefined, '/settings/security?error=email_not_verified');
    const banner = await screen.findByTestId('security-return-banner');
    expect(banner).toHaveTextContent(/verify your email address/i);
    expect(banner.textContent).not.toContain('email_not_verified');
  });

  it('shows the generic message for an unknown refusal code, not the code itself', async () => {
    setUp(undefined, '/settings/security?error=%3Cscript%3Eevil');
    const banner = await screen.findByTestId('security-return-banner');
    expect(banner).toHaveTextContent(/did not complete/i);
    expect(banner.textContent).not.toContain('evil');
  });

  it('confirms a completed single sign-on link', async () => {
    setUp(undefined, '/settings/security?linked=1');
    expect(await screen.findByTestId('security-return-banner')).toHaveTextContent(
      /single sign-on is linked/i,
    );
  });

  it('confirms a completed single sign-on re-confirmation', async () => {
    setUp(undefined, '/settings/security?confirmed=1');
    expect(await screen.findByTestId('security-return-banner')).toHaveTextContent(
      /you confirmed it is you/i,
    );
  });

  it('still opens the page when the return address carries a value it does not recognise', async () => {
    setUp(undefined, '/settings/security?linked=yes&confirmed=%7B%7D&error=%7B%7D');
    expect(await screen.findByText('Other browser')).toBeInTheDocument();
    expect(screen.queryByTestId('security-return-banner')).not.toBeInTheDocument();
  });

  it('shows no return banner on a plain visit', async () => {
    setUp();
    await screen.findByText('Other browser');
    expect(screen.queryByTestId('security-return-banner')).not.toBeInTheDocument();
  });

  it('shows grouped security activity with its count', async () => {
    setUp();
    const activity = await screen.findByTestId('security-activity');
    await waitFor(() => expect(activity).toHaveTextContent(/4 times/));
    // The four may have come from several addresses; the row only knows the first.
    expect(activity).toHaveTextContent('first from 203.0.113.50');
  });

  it('says how each sign-in was made, so an unexpected method stands out', async () => {
    setUp();
    const activity = await screen.findByTestId('security-activity');
    const rows = await within(activity).findAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('via password');
    expect(rows[1]).toHaveTextContent('198.51.100.9 · as me@example.test · via single sign-on');
    // An event no sign-in method applies to gets no method, rather than "via not applicable".
    expect(rows[2]).not.toHaveTextContent('via');
  });

  it('names the linked identity provider account, so the operator can tell whether the right one is linked', async () => {
    setUp({
      hasPassword: true,
      singleSignOnLinked: true,
      singleSignOnEmail: 'me@example.test',
      singleSignOnConfigured: true,
    });
    await waitFor(() =>
      expect(screen.getByTestId('security-method-sso')).toHaveTextContent(
        'Linked as me@example.test',
      ),
    );
  });

  it('still says linked when the provider email was never recorded', async () => {
    setUp({ hasPassword: true, singleSignOnLinked: true, singleSignOnConfigured: true });
    await waitFor(() =>
      expect(screen.getByTestId('security-method-sso')).toHaveTextContent(/^Linked$/),
    );
  });

  it('offers adding a password to an operator who only has single sign-on, and no change-password form', async () => {
    setUp({ hasPassword: false, singleSignOnLinked: true });
    expect(await screen.findByLabelText(/add a password/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/current password/i)).not.toBeInTheDocument();
  });
});
