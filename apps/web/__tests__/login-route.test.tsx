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

  it('surfaces 401 as an inline invalid-credentials error', async () => {
    setUp('/login', () => json({ error: { code: 'UNAUTHENTICATED', message: 'bad creds' } }, 401));
    const user = userEvent.setup();
    const emailInput = await screen.findByLabelText(/email/i);
    await user.type(emailInput, 'op@example.com');
    await user.type(screen.getByLabelText(/password/i), 'whatever');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByTestId('login-generic-error')).toHaveTextContent(/incorrect/i);
  });
});
