import { createMemoryHistory, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { resolveOnboardingRedirect } from '@/features/auth/api/auth';
import { homeRedirectRoute } from '@/features/dashboard/routes/home-redirect';
import { rootRoute } from '@/app/__root';

type Json = Record<string, unknown>;

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const TEST_ACCOUNT = {
  id: ACCOUNT_ID,
  name: 'Main',
  binanceMode: 'test' as const,
  apiKeyConfigured: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const jsonResponse = (body: Json, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const stubComponent = () => null;
const onboardingStub = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  component: stubComponent,
});
const loginStub = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: stubComponent,
});
// The dashboard now lives at `/accounts/$accountId`; `/` (homeRedirectRoute)
// bounces there. A plain stub is enough to give that redirect a real match.
const accountStub = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accounts/$accountId',
  component: stubComponent,
});

const setUp = (initialPath: string, body: Json) => {
  const fetchMock = vi.fn(async () => jsonResponse(body));
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  // homeRedirectRoute.beforeLoad ensures the accounts list; seed it so the
  // bare-root redirect resolves to the default account from cache.
  queryClient.setQueryData(['accounts'], [TEST_ACCOUNT]);
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRedirectRoute, onboardingStub, loginStub, accountStub]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  return { fetchMock, queryClient, router };
};

describe('resolveOnboardingRedirect', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('redirects to /onboarding when masterExists=false and url ≠ /onboarding', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ masterExists: false })),
    );
    const queryClient = createQueryClient();
    expect(await resolveOnboardingRedirect(queryClient, '/')).toBe('/onboarding');
    expect(await resolveOnboardingRedirect(queryClient, '/profiles/abc')).toBe('/onboarding');
  });

  it('redirects to /login when masterExists=true and url = /onboarding', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ masterExists: true })),
    );
    const queryClient = createQueryClient();
    expect(await resolveOnboardingRedirect(queryClient, '/onboarding')).toBe('/login');
  });

  it('returns null on the happy paths', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ masterExists: true })),
    );
    const qc1 = createQueryClient();
    expect(await resolveOnboardingRedirect(qc1, '/')).toBeNull();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ masterExists: false })),
    );
    const qc2 = createQueryClient();
    expect(await resolveOnboardingRedirect(qc2, '/onboarding')).toBeNull();
  });
});

describe('root route loader integration', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('passes the onboarding gate, then home-redirects to the default account', async () => {
    // masterExists=true clears the onboarding gate; `/` then home-redirects to
    // the default account's dashboard (`/accounts/$accountId`), not a bare `/`.
    const { router } = setUp('/', { masterExists: true });
    await router.load();
    expect(router.state.location.pathname).toBe(`/accounts/${ACCOUNT_ID}`);
  });

  it('does not redirect when masterExists=false and url = /onboarding', async () => {
    const { router } = setUp('/onboarding', { masterExists: false });
    await router.load();
    expect(router.state.location.pathname).toBe('/onboarding');
  });

  it('redirects /onboarding → /login (resolved match) when masterExists=true', async () => {
    // The redirect must land on a real route match, not an `href`-only
    // location: an `href` redirect leaves the SPA mounting a blank tree.
    const { router } = setUp('/onboarding', { masterExists: true });
    await router.load();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.matches.at(-1)?.routeId).toBe(loginStub.id);
  });

  it('calls /api/auth/onboarding-status exactly once across navigations (staleTime: Infinity)', async () => {
    const { router, fetchMock } = setUp('/', { masterExists: true });
    await router.load();
    await router.navigate({ to: '/' });
    await router.load();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0] as unknown as [string | URL | Request];
    const url = firstCall[0];
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    expect(urlStr).toContain('/api/auth/onboarding-status');
  });
});
