// BottomNav — the phone's only navigation, so a cell that resolves nowhere is a dead end rather than a cosmetic bug.
//
// The shell tests all run with the global setup's active account, so the no-account branch never executes there. It is mocked here because `current` in account-scope is module state with no setter back to null.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The active account is per-test state: the no-account branch is why this file mocks the module at all, and the demo cases below need an account so the account hub is dropped by the demo filter rather than by the missing-account guard. `vi.hoisted` because a `vi.mock` factory is hoisted above ordinary declarations.
const scope = vi.hoisted(() => ({ accountId: null as string | null }));

// Relative, not the '@/' alias: vitest resolves vi.mock paths itself and does not read the tsconfig alias table.
vi.mock('../src/shared/lib/account-scope', async () => {
  const actual = await vi.importActual<typeof import('../src/shared/lib/account-scope')>(
    '../src/shared/lib/account-scope',
  );
  return { ...actual, useActiveAccountId: () => scope.accountId };
});

const { BottomNav, NAV_ITEMS } = await import('@/app/bottom-nav');

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';

const renderBar = async (demoMode = false): Promise<HTMLElement> => {
  // The Profiles sheet is mounted (closed) inside the bar and reads the profile list as soon as an account is active, so the suite's unmocked-fetch sentinel would fail every case that sets one.
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ profiles: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
  // Built per render because `demoMode` is a prop of the component under test and a route component is fixed once its route is created.
  const testRoot = createRootRoute({
    component: () => (
      <>
        <BottomNav demoMode={demoMode} />
        <Outlet />
      </>
    ),
  });
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => testRoot, path, component: () => null });
  const router = createRouter({
    routeTree: testRoot.addChildren([
      stub('/'),
      stub('/settings'),
      stub('/accounts/$accountId'),
      stub('/accounts/$accountId/settings'),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  const bar = await screen.findByRole('navigation', { name: 'Primary' });
  return bar;
};

beforeEach(() => {
  scope.accountId = null;
});
afterEach(() => {
  vi.restoreAllMocks();
  // `restoreAllMocks` only reverts vi.spyOn; the counterpart for vi.stubGlobal is this. Without it the fetch stub outlives every test in the file, so a case that never meant to mock fetch runs under a stub that answers everything.
  vi.unstubAllGlobals();
});

describe('<BottomNav> with no active account', () => {
  it('drops the account hub rather than linking to /accounts//settings', async () => {
    // The nested path interpolates the empty string, producing a URL that matches
    // no route — a not-found reached from the phone's primary bar.
    const bar = await renderBar();
    expect(within(bar).queryByRole('link', { name: 'Account' })).toBeNull();
    for (const link of within(bar).getAllByRole('link')) {
      expect(link.getAttribute('href')).not.toContain('//');
    }
  });

  it('still offers Home, Profiles and Settings, so the bar stays navigable', async () => {
    const bar = await renderBar();
    expect(within(bar).getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(within(bar).getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(within(bar).getByTestId('bottom-nav-profiles')).toBeInTheDocument();
  });
});

// The bar's own obedience to the registry, per cell. The whole-shell sweep in demo-nav-visibility.test.tsx proves no hidden destination reaches ANY surface; this proves the bar is the surface doing the filtering rather than being carried by a sibling that happens to render nothing.
describe('<BottomNav> demo filtering', () => {
  const hrefsIn = (bar: HTMLElement): readonly string[] =>
    within(bar)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href') ?? '');

  const resolve = (to: string): string => to.replace('$accountId', ACCOUNT_ID);

  it('renders no cell for a demo-hidden destination', async () => {
    scope.accountId = ACCOUNT_ID;
    const bar = await renderBar(true);
    const hrefs = hrefsIn(bar);
    const hidden = NAV_ITEMS.filter((item) => item.demoHidden).map((item) => resolve(item.to));
    // A registry declaring every cell visible would make the next line assert nothing.
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.filter((href) => hrefs.includes(href))).toEqual([]);
    // The bar still rendered: an empty bar would satisfy the absence above.
    expect(
      NAV_ITEMS.filter((item) => !item.demoHidden)
        .map((item) => resolve(item.to))
        .filter((href) => !hrefs.includes(href)),
    ).toEqual([]);
  });

  it('renders every cell outside the demo', async () => {
    scope.accountId = ACCOUNT_ID;
    const bar = await renderBar(false);
    const hrefs = hrefsIn(bar);
    expect(
      NAV_ITEMS.map((item) => resolve(item.to)).filter((href) => !hrefs.includes(href)),
    ).toEqual([]);
  });
});
