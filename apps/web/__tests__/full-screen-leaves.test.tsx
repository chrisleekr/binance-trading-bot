// FULL_SCREEN_LEAVES — the route ids for which the shell drops <main>'s scroll and padding because the page owns its own per-zone scroll.
//
// The set is matched against `useMatches().at(-1)?.routeId`, so only a LEAF can ever be in it. Nesting a child under a full-screen route silently demotes the parent to a layout match, its id stops being the leaf, and the page keeps rendering while quietly double-scrolling — no test, type, or lint rule saw that before this file.

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FULL_SCREEN_LEAVES, rootRoute } from '@/app/__root';
import { accountOverviewRoute } from '@/features/dashboard/routes/index';
import { profileDetailIndexRoute } from '@/features/profile/routes/profiles.$profileId';
import { createQueryClient } from '@/shared/lib/query-client';
import { router } from '@/router';
import {
  symbolDetailIndexRoute,
  symbolDetailRoute,
} from '@/features/symbol/routes/profiles.$profileId.symbols.$symbol';
import { symbolConfigRoute } from '@/features/symbol/routes/profiles.$profileId.symbols.$symbol.config';

// Captured at module load, before any mount: `mountShellAt` calls `rootRoute.addChildren` on the same object `@/router` built its tree from, so the ID SET here is the real router's rather than one the tests reshaped. The spread is shallow, so the VALUES stay live route references and the `children` read below sees assert-time state — safe only while no FULL_SCREEN_LEAVES member is a route `mountShellAt` touches, and today it touches `rootRoute` alone.
const REAL_ROUTES_BY_ID: Readonly<Record<string, { children?: readonly unknown[] }>> = {
  ...(router.routesById as Record<string, { children?: readonly unknown[] }>),
};
const REAL_FULL_SCREEN_IDS = [
  accountOverviewRoute.id,
  profileDetailIndexRoute.id,
  symbolDetailIndexRoute.id,
] as const;
const REAL_WORKSPACE_LAYOUT_ID = symbolDetailRoute.id;

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const PROFILE_ID = '00000000-0000-4000-8000-00000000000a';
const TEST_ACCOUNT = {
  id: ACCOUNT_ID,
  name: 'Main',
  binanceMode: 'test' as const,
  apiKeyConfigured: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const WORKSPACE_PATH = `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/symbols/BTCUSDT`;

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Mount the REAL root route — the shell and its full-screen decision — over stub leaves that reproduce the real route ids.
 *
 * Stubs rather than the real page components: the decision under test reads only the leaf route id, and mounting the workspace itself drags in the chart loader and a dozen symbol fetches that have nothing to do with it. The mounted leaf id is asserted against the real route object in every case, so a stub tree that drifted from the real one fails rather than passing on a fiction.
 *
 * @param path - URL to mount at.
 * @returns The router, so the test can assert which leaf actually matched.
 */
const mountShellAt = (path: string) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({})),
  );
  const queryClient = createQueryClient();
  // Bypasses the root beforeLoad's onboarding/login gate, which would otherwise redirect away from the route under test.
  queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
  queryClient.setQueryData(['accounts'], [TEST_ACCOUNT]);
  queryClient.setQueryData(['dashboard-aggregate', ACCOUNT_ID], { profiles: [] });
  const accountStub = createRoute({
    getParentRoute: () => rootRoute,
    path: '/accounts/$accountId',
    component: () => <Outlet />,
  });
  const profileStub = createRoute({
    getParentRoute: () => accountStub,
    path: 'profiles/$profileId',
    component: () => <Outlet />,
  });
  const symbolStub = createRoute({
    getParentRoute: () => profileStub,
    path: 'symbols/$symbol',
    component: () => <Outlet />,
  });
  const symbolIndexStub = createRoute({
    getParentRoute: () => symbolStub,
    path: '/',
    component: () => null,
  });
  const symbolConfigStub = createRoute({
    getParentRoute: () => symbolStub,
    path: 'config',
    component: () => null,
  });
  const testRouter = createRouter({
    routeTree: rootRoute.addChildren([
      accountStub.addChildren([
        profileStub.addChildren([symbolStub.addChildren([symbolIndexStub, symbolConfigStub])]),
      ]),
    ]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={testRouter as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return testRouter;
};

const mainClass = (): string => screen.getByRole('main').className;

afterEach(() => vi.unstubAllGlobals());

describe('full-screen route treatment', () => {
  it('drops <main> scroll and padding at the symbol workspace', async () => {
    const testRouter = mountShellAt(WORKSPACE_PATH);
    // Ties the stub tree to the real one: the id this matched is the id the real workspace leaf carries.
    await waitFor(() =>
      expect(testRouter.state.matches.at(-1)?.routeId).toBe(symbolDetailIndexRoute.id),
    );
    expect(mainClass()).toMatch(/\boverflow-hidden\b/);
    expect(mainClass()).not.toMatch(/\boverflow-y-scroll\b/);
    expect(mainClass()).not.toMatch(/\bp-4\b/);
  });

  it('keeps <main> scrolling and padded at the symbol config page', async () => {
    const testRouter = mountShellAt(`${WORKSPACE_PATH}/config`);
    await waitFor(() =>
      expect(testRouter.state.matches.at(-1)?.routeId).toBe(symbolConfigRoute.id),
    );
    // The config page is an ordinary scrolling page nested under a full-screen parent, which is exactly the case a parent-id match would get wrong.
    expect(mainClass()).toMatch(/\boverflow-y-scroll\b/);
    expect(mainClass()).toMatch(/\bp-4\b/);
    expect(mainClass()).not.toMatch(/\boverflow-hidden\b/);
  });
});

describe('FULL_SCREEN_LEAVES', () => {
  it('names only route ids the real router knows', () => {
    const known = new Set(Object.keys(REAL_ROUTES_BY_ID));
    expect([...FULL_SCREEN_LEAVES].filter((id) => !known.has(id))).toEqual([]);
  });

  it('names only leaves, since a route with children is never the last match', () => {
    // The check that would have caught the symbol config nesting. Existence alone would not have: the workspace id survives the nesting as the LAYOUT route, still a key of routesById, while `useMatches().at(-1)` starts returning the new index route and the treatment silently stops applying.
    const withChildren = [...FULL_SCREEN_LEAVES].filter(
      (id) => (REAL_ROUTES_BY_ID[id]?.children?.length ?? 0) > 0,
    );
    expect(withChildren).toEqual([]);
  });

  it('holds exactly the account overview, the profile overview, and the symbol workspace', () => {
    // Ids read off the real route objects, never retyped: a literal here would keep agreeing with a stale set after the route it names is renamed or re-nested.
    expect([...FULL_SCREEN_LEAVES].sort()).toEqual([...REAL_FULL_SCREEN_IDS].sort());
    // The layout the index route now sits under is NOT itself a member: it can never be the leaf match.
    expect(FULL_SCREEN_LEAVES.has(REAL_WORKSPACE_LAYOUT_ID)).toBe(false);
  });
});
