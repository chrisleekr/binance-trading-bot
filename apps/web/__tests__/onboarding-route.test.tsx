import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { onboardingRoute } from '@/features/account/routes/onboarding';
import { rootRoute } from '@/app/__root';

type Json = Record<string, unknown>;

const json = (body: Json, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
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
  // Pre-seed onboarding-status so root loader doesn't try to redirect.
  queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: false });
  const indexStub = stub('/');
  const loginStub = stub('/login');
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexStub, onboardingRoute, loginStub]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ['/onboarding'] }),
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      {/* The app's registered router has a fixed children tuple; tests build
          their own tree, so the strict RouterProvider type is widened here. */}
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return { fetchMock, queryClient, router, ...utils };
};

describe('OnboardingPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the lost-password warning referencing `bun run reset-password`', async () => {
    setUp(() => json({}, 200));
    const warning = await screen.findByTestId('onboarding-warning');
    expect(warning.textContent ?? '').toContain('bun run reset-password');
    expect(warning.textContent ?? '').toContain('host');
  });

  it('shows the 12-character password requirement inline before any submit', async () => {
    setUp(() => json({}, 200));
    await screen.findByRole('heading', { name: /create master account/i });
    // The requirement is visible up front, not only after a failed attempt.
    expect(screen.getByText('At least 12 characters.')).toBeInTheDocument();
  });

  it('renders no banned auth-CTA substrings', async () => {
    setUp(() => json({}, 200));
    await screen.findByRole('heading', { name: /create master account/i });
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/Sign up/i);
    expect(text).not.toMatch(/Forgot password/i);
    expect(text).not.toMatch(/2FA/i);
  });

  it('client-validates a short password before POSTing', async () => {
    const { fetchMock } = setUp(() => json({}, 200));
    const user = userEvent.setup();
    const emailInput = await screen.findByLabelText(/email/i);
    await user.type(emailInput, 'op@example.com');
    await user.type(screen.getByLabelText(/password/i), 'short');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/at least 12 characters/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('on success, sets masterExists=true and navigates to the app root', async () => {
    const urls: string[] = [];
    const { queryClient, router } = setUp((url) => {
      urls.push(url);
      return json({}, 200);
    });
    const user = userEvent.setup();
    const emailInput = await screen.findByLabelText(/email/i);
    await user.type(emailInput, 'op@example.com');
    await user.type(screen.getByLabelText(/password/i), 'a-strong-password-123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    // Sign-up already established a session (Better Auth autoSignIn), so the
    // page lands on `/` (which redirects to the seeded account) instead of
    // forcing a redundant re-login.
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
    // Exactly one sign-up POST — landing on `/` must not re-trigger it.
    expect(urls.filter((u) => u.includes('/api/auth/sign-up'))).toHaveLength(1);
    expect(queryClient.getQueryData(['auth', 'onboarding-status'])).toEqual({ masterExists: true });
  });

  it('blocks re-entrant submits while a sign-up is in flight', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const inFlight = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const { fetchMock, router } = setUp(() => inFlight);
    const user = userEvent.setup();
    const emailInput = await screen.findByLabelText(/email/i);
    await user.type(emailInput, 'op@example.com');
    await user.type(screen.getByLabelText(/password/i), 'a-strong-password-123');
    const submit = screen.getByRole('button', { name: /create account/i });
    await user.click(submit);

    await waitFor(() => {
      expect(submit).toBeDisabled();
      expect(screen.getByLabelText(/email/i)).toBeDisabled();
      expect(screen.getByLabelText(/password/i)).toBeDisabled();
    });

    // Second click while disabled: no second fetch is issued.
    await user.click(submit);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveResponse?.(json({}, 200));
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('on 403 ONBOARDING_CLOSED, flips masterExists and redirects to /login', async () => {
    const { queryClient, router } = setUp(() =>
      json({ error: { code: 'ONBOARDING_CLOSED', message: 'onboarding is closed' } }, 403),
    );
    const user = userEvent.setup();
    const emailInput = await screen.findByLabelText(/email/i);
    await user.type(emailInput, 'op@example.com');
    await user.type(screen.getByLabelText(/password/i), 'a-strong-password-123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });
    expect(queryClient.getQueryData(['auth', 'onboarding-status'])).toEqual({ masterExists: true });
  });
});
