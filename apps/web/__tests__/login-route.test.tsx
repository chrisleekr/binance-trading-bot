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
import { loginRoute } from '@/features/auth/routes/login';
import { rootRoute } from '@/app/__root';

type Json = Record<string, unknown>;

// Captured before any test replaces `window.location`: a replaced getter survives `restoreAllMocks` here, and a later mock spread from it has no `origin`, which would make the same-origin check refuse every value and pass the open-redirect cases vacuously.
const REAL_ORIGIN = window.location.origin;

const json = (body: Json, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const stub = (path: string) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => null });

const setUp = (
  initial: string,
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
  const indexStub = stub('/');
  const onboardingStub = stub('/onboarding');
  const accountStub = stub('/account');
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexStub, onboardingStub, loginRoute, accountStub]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      {/* See onboarding-route.test.tsx for widening the strictly registered router. */}
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return { fetchMock, queryClient, router, ...utils };
};

describe('LoginPage', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders no banned auth-CTA substrings', async () => {
    setUp('/login', () => json({}, 200));
    await screen.findByRole('heading', { name: /sign in/i });
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/Sign up/i);
    expect(text).not.toMatch(/Create account/i);
    expect(text).not.toMatch(/Forgot password/i);
    expect(text).not.toMatch(/2FA/i);
  });

  it('shows a session-expired notice when ?reason=expired', async () => {
    setUp('/login?reason=expired', () => json({}, 200));
    await screen.findByRole('heading', { name: /sign in/i });
    expect(screen.getByTestId('login-session-expired')).toBeInTheDocument();
    expect(screen.getByText(/your session expired/i)).toBeInTheDocument();
  });

  it('omits the session-expired notice on a plain /login', async () => {
    setUp('/login', () => json({}, 200));
    await screen.findByRole('heading', { name: /sign in/i });
    expect(screen.queryByTestId('login-session-expired')).not.toBeInTheDocument();
  });

  it('on success, bounces to ?from when the URL is a same-site path', async () => {
    const { router } = setUp('/login?from=%2Faccount', (url) => {
      expect(url).toContain('/api/auth/sign-in/email');
      return json({}, 200);
    });
    const user = userEvent.setup();
    const emailInput = await screen.findByLabelText(/email/i);
    await user.type(emailInput, 'op@example.com');
    await user.type(screen.getByLabelText(/password/i), 'whatever');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/account');
    });
  });

  it('falls back to / when ?from is absolute or protocol-relative', async () => {
    const { router } = setUp('/login?from=https%3A%2F%2Fevil.example', () => json({}, 200));
    const user = userEvent.setup();
    const emailInput = await screen.findByLabelText(/email/i);
    await user.type(emailInput, 'op@example.com');
    await user.type(screen.getByLabelText(/password/i), 'whatever');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
  });

  it('falls back to / when ?from points back at an auth page', async () => {
    // A leftover `?from=/login` must not strand the authenticated operator
    // on the sign-in page.
    const { router } = setUp('/login?from=%2Flogin', () => json({}, 200));
    const user = userEvent.setup();
    const emailInput = await screen.findByLabelText(/email/i);
    await user.type(emailInput, 'op@example.com');
    await user.type(screen.getByLabelText(/password/i), 'whatever');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
  });

  it('falls back to / when ?from is an auth page with a trailing slash', async () => {
    // `/login/` must be caught by the auth-path guard, not just `/login`.
    const { router } = setUp('/login?from=%2Flogin%2F', () => json({}, 200));
    const user = userEvent.setup();
    const emailInput = await screen.findByLabelText(/email/i);
    await user.type(emailInput, 'op@example.com');
    await user.type(screen.getByLabelText(/password/i), 'whatever');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
  });

  it('falls back to / when ?from hides a second slash behind a tab the browser strips', async () => {
    const { router } = setUp('/login?from=%2F%09%2Fevil.example', () => json({}, 200));
    const user = userEvent.setup();
    const emailInput = await screen.findByLabelText(/email/i);
    await user.type(emailInput, 'op@example.com');
    await user.type(screen.getByLabelText(/password/i), 'whatever');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
  });

  it('surfaces 429 with Retry-After in a non-dismissable alert and disables the form', async () => {
    const { fetchMock } = setUp('/login', () =>
      json({ error: { code: 'RATE_LIMITED', message: 'slow down' } }, 429, {
        'retry-after': '42',
      }),
    );
    const user = userEvent.setup();
    const emailInput = await screen.findByLabelText(/email/i);
    await user.type(emailInput, 'op@example.com');
    await user.type(screen.getByLabelText(/password/i), 'whatever');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByTestId('login-rate-limit');
    expect(alert.textContent ?? '').toMatch(/42/);
    expect(screen.getByLabelText(/email/i)).toBeDisabled();
    expect(screen.getByLabelText(/password/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Asserts no auto-retry: re-rendering does not trigger another fetch call.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resumes a waiting authorization request instead of landing on the dashboard', async () => {
    // The authorization endpoint sends an unauthenticated operator here carrying its own signed query, and that request is still open. Navigating into the app on success strands whatever asked for it: the operator signs in, sees their account, and the agent waits forever for a callback that never comes.
    const search =
      '?response_type=code&client_id=abc123&scope=mcp%3Aread+mcp%3Atrade' +
      '&ba_param=client_id&ba_param=scope&ba_param=ba_param&sig=deadbeef';
    Object.defineProperty(window, 'location', {
      value: { href: '', search },
      writable: true,
    });
    const { router } = setUp(`/login${search}`, () => json({ ok: true }, 200));
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/email/i), 'op@example.com');
    await user.type(screen.getByLabelText(/password/i), 'a-long-enough-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    // A full-page navigation, not a router push: the continuation is the server's redirect chain, and the SPA cannot follow a 302 it never sees.
    await vi.waitFor(() => expect(window.location.href).toContain('/api/auth/oauth2/authorize'));
    expect(window.location.href).toContain('sig=deadbeef');
    expect(router.state.location.pathname).toBe('/login');
  });

  it('still lands in the app when no authorization request is waiting', async () => {
    // The discriminating half. Without it the case above passes just as well on a page that always redirects to the authorization endpoint, which would break every ordinary sign-in.
    Object.defineProperty(window, 'location', { value: { href: '', search: '' }, writable: true });
    const { router } = setUp('/login', () => json({ ok: true }, 200));
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/email/i), 'op@example.com');
    await user.type(screen.getByLabelText(/password/i), 'a-long-enough-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(window.location.href).toBe('');
  });

  it('surfaces 401 as an inline invalid-credentials error', async () => {
    setUp('/login', () => json({ error: { code: 'UNAUTHENTICATED', message: 'bad creds' } }, 401));
    const user = userEvent.setup();
    const emailInput = await screen.findByLabelText(/email/i);
    await user.type(emailInput, 'op@example.com');
    await user.type(screen.getByLabelText(/password/i), 'whatever');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByTestId('login-generic-error')).toHaveTextContent(/incorrect/i);
  });

  describe('sign-in methods', () => {
    const withStatus = (
      queryClient: ReturnType<typeof setUp>['queryClient'],
      status: Json,
    ): void => {
      queryClient.setQueryData(['auth', 'onboarding-status'], {
        masterExists: true,
        demoMode: false,
        ...status,
      });
    };

    it('hides the password form when password sign-in is off and offers single sign-on alone', async () => {
      const { queryClient } = setUp('/login', () => json({}, 200));
      withStatus(queryClient, {
        passwordSignIn: false,
        singleSignOn: { buttonLabel: 'Sign in with Auth0', available: true },
        passwordSignInForced: false,
      });
      expect(await screen.findByTestId('login-single-sign-on')).toHaveTextContent(
        'Sign in with Auth0',
      );
      expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    });

    it('disables single sign-on with a reason while the provider is unreachable', async () => {
      const { queryClient } = setUp('/login', () => json({}, 200));
      withStatus(queryClient, {
        passwordSignIn: true,
        singleSignOn: { buttonLabel: 'Sign in with Auth0', available: false },
        passwordSignInForced: true,
      });
      expect(await screen.findByTestId('login-single-sign-on')).toBeDisabled();
      expect(screen.getByTestId('login-single-sign-on-unavailable')).toBeInTheDocument();
      expect(screen.getByTestId('login-password-forced')).toBeInTheDocument();
    });

    it('starts single sign-on on the server, carrying a waiting agent authorization, and follows the address it returns', async () => {
      const pending =
        '?response_type=code&client_id=https%3A%2F%2Fagent.example%2Fclient.json&exp=1&sig=abc';
      let sent: unknown = null;
      const { queryClient } = setUp(`/login${pending}`, (url, init) => {
        if (url.includes('/api/auth/single-sign-on/start')) {
          sent = JSON.parse(String(init?.body));
          return json({ url: 'https://idp.example/authorize?state=s' });
        }
        return json({}, 200);
      });
      withStatus(queryClient, {
        passwordSignIn: true,
        singleSignOn: { buttonLabel: 'Sign in with Auth0', available: true },
        passwordSignInForced: false,
      });
      const assign = vi.fn();
      vi.spyOn(window, 'location', 'get').mockReturnValue({
        ...window.location,
        origin: REAL_ORIGIN,
        search: pending,
        set href(value: string) {
          assign(value);
        },
      } as Location);
      const user = userEvent.setup();
      await user.click(await screen.findByTestId('login-single-sign-on'));
      await waitFor(() =>
        expect(assign).toHaveBeenCalledWith('https://idp.example/authorize?state=s'),
      );
      expect(sent).toEqual({ returnTo: '/', pendingAuthorization: pending });
    });

    // The browser strips tab and newline and reads a backslash as a slash, so each of these passes a "starts with one slash" check yet resolves to another site. The value is sent as the single sign-on `returnTo`, so the body is where an open redirect would show.
    it.each([
      ['/\t/evil.example', '/'],
      ['/\n/evil.example', '/'],
      ['/\\evil.example', '/'],
      ['//evil.example', '/'],
      ['/\t/evil.example/account', '/'],
      ['/account?tab=keys#top', '/account?tab=keys#top'],
      // Same origin, but sent in the form the browser resolved rather than the raw string, so the server and the router never have to agree with the browser on how to read a stray tab.
      ['/\taccount', '/account'],
    ])('sends ?from=%j as single sign-on returnTo %j', async (from, expected) => {
      let sent: { returnTo?: string } | null = null;
      const { queryClient } = setUp(`/login?from=${encodeURIComponent(from)}`, (url, init) => {
        if (url.includes('/api/auth/single-sign-on/start')) {
          sent = JSON.parse(String(init?.body)) as { returnTo?: string };
          return json({ url: 'https://idp.example/authorize?state=s' });
        }
        return json({}, 200);
      });
      withStatus(queryClient, {
        passwordSignIn: true,
        singleSignOn: { buttonLabel: 'Sign in with Auth0', available: true },
        passwordSignInForced: false,
      });
      const assign = vi.fn();
      vi.spyOn(window, 'location', 'get').mockReturnValue({
        ...window.location,
        origin: REAL_ORIGIN,
        search: '',
        set href(value: string) {
          assign(value);
        },
      } as Location);
      const user = userEvent.setup();
      await user.click(await screen.findByTestId('login-single-sign-on'));
      await waitFor(() => expect(assign).toHaveBeenCalled());
      expect(sent).toEqual({ returnTo: expected });
    });

    it('explains a known refusal code and never renders an unknown one', async () => {
      setUp('/login?error=email_not_verified', () => json({}, 200));
      expect(await screen.findByTestId('login-server-error')).toHaveTextContent(
        /verify your email address/i,
      );
    });

    it('shows the generic message for a code it does not know, not the code itself', async () => {
      setUp('/login?error=%3Cscript%3Eevil', () => json({}, 200));
      const alert = await screen.findByTestId('login-server-error');
      expect(alert).toHaveTextContent(/did not complete/i);
      expect(alert.textContent).not.toContain('evil');
    });
  });
});
