// SideNav — the desktop-only collapsible left sidebar (v2 terminal chrome).
// Covers the collapse toggle + its localStorage round-trip, the initial state
// read back from storage, the live profile list (a killed profile swaps its
// green dot for the danger glyph), and active-route highlighting.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SideNav } from '@/app/side-nav';
import { TooltipProvider } from '@/shared/components/ui/tooltip';

import type { DashboardAggregateResponse } from '@app/contracts';

// Matches the global test-setup default active account; SideNav reads it via
// useActiveAccountId and builds every account-nested link/nav from it.
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';

// Spy on useNavigate so a profile-row click can be asserted to land on '/'.
const navigateSpy = vi.fn();
vi.mock('@tanstack/react-router', async (importActual) => {
  const actual = await importActual<typeof import('@tanstack/react-router')>();
  return { ...actual, useNavigate: () => navigateSpy };
});

type Row = DashboardAggregateResponse['profiles'][number];

const row = (overrides: Partial<Row> & { profileId: string; name: string }): Row => ({
  enabled: true,
  binanceMode: 'live',
  lastTickAt: null,
  lastTickLatencyMs: null,
  apiKeyConfigured: true,
  lastTickError: null,
  killSwitch: false,
  openOrderCount: 0,
  openPositionCount: 0,
  positions: [],
  ...overrides,
});

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

// Standalone root (not the app's __root, which renders its own AppShell+SideNav
// and would duplicate every link). SideNav lives in the layout so it renders on
// every route under test; the children are bare stubs for the link/nav targets.
const testRoot = createRootRoute({
  component: () => (
    <TooltipProvider delayDuration={150}>
      <SideNav />
      <Outlet />
    </TooltipProvider>
  ),
});
const stub = (path: string) =>
  createRoute({ getParentRoute: () => testRoot, path, component: () => null });

const renderNav = async (
  rows: Row[],
  initialPath = `/accounts/${ACCOUNT_ID}`,
): Promise<HTMLElement> => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/dashboard-aggregate')) return json({ profiles: rows });
      return new Response(null, { status: 404 });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree: testRoot.addChildren([
      stub('/accounts/$accountId'),
      stub('/accounts/$accountId/profiles/new'),
      stub('/accounts/$accountId/profiles/$profileId'),
      stub('/accounts/$accountId/settings'),
      stub('/accounts/$accountId/dust-transfer'),
      stub('/accounts/$accountId/orphan-orders'),
      stub('/account'),
      stub('/settings/backup-restore'),
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  // Router commits route components asynchronously — wait for the nav to mount.
  return screen.findByTestId('side-nav');
};

beforeEach(() => {
  localStorage.clear();
  navigateSpy.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const PA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('<SideNav>', () => {
  it('starts expanded and persists the collapse choice to localStorage', async () => {
    const nav = await renderNav([row({ profileId: PA, name: 'Real' })]);
    expect(nav).toHaveAttribute('data-collapsed', 'false');

    await userEvent.click(screen.getByTestId('side-nav-toggle'));

    expect(nav).toHaveAttribute('data-collapsed', 'true');
    expect(localStorage.getItem('side-nav-collapsed')).toBe('1');

    // Toggling back expands again and clears the persisted flag.
    await userEvent.click(screen.getByTestId('side-nav-toggle'));
    expect(nav).toHaveAttribute('data-collapsed', 'false');
    expect(localStorage.getItem('side-nav-collapsed')).toBe('0');
  });

  it('reads the initial collapsed state back from localStorage', async () => {
    localStorage.setItem('side-nav-collapsed', '1');
    const nav = await renderNav([row({ profileId: PA, name: 'Real' })]);
    expect(nav).toHaveAttribute('data-collapsed', 'true');
  });

  it('lists every profile as a button and flags a killed one with the danger glyph instead of the live dot', async () => {
    await renderNav([
      row({ profileId: PA, name: 'Real' }),
      row({ profileId: PB, name: 'Stopped', killSwitch: true }),
    ]);

    // Profile rows are buttons now (selecting one sets scope + navigates to '/',
    // it is not a route link).
    const live = await screen.findByRole('button', { name: 'Real' });
    const killed = await screen.findByRole('button', { name: 'Stopped' });
    // Live profile shows the plain dot span (no icon); killed shows ShieldAlert (an svg).
    expect(live.querySelector('svg')).toBeNull();
    expect(killed.querySelector('svg')).not.toBeNull();
  });

  it('colours the profile dot by state — disabled, tick error, live, and idle', async () => {
    const PC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const PD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await renderNav([
      row({ profileId: PA, name: 'Live', enabled: true, lastTickAt: '2026-06-21T00:00:00.000Z' }),
      row({ profileId: PB, name: 'Off', enabled: false }),
      row({ profileId: PC, name: 'Erroring', enabled: true, lastTickError: 'cold-load-failed' }),
      row({ profileId: PD, name: 'Idle', enabled: true, lastTickAt: null }),
    ]);
    await screen.findByRole('button', { name: 'Live' });
    // The dot is the icon span (aria-hidden, carries a title); the label is a
    // separate untitled span.
    const dot = (name: string): Element | null =>
      screen.getByRole('button', { name }).querySelector('span[title]');

    expect(dot('Live')).toHaveAttribute('title', 'Live');
    expect(dot('Live')?.className).toContain('bg-success');
    // Disabled reads as a hollow ring (border), not a filled colour.
    expect(dot('Off')).toHaveAttribute('title', 'Disabled');
    expect(dot('Off')?.className).toContain('border');
    expect(dot('Erroring')).toHaveAttribute('title', 'Tick error');
    expect(dot('Erroring')?.className).toContain('bg-danger');
    expect(dot('Idle')).toHaveAttribute('title', 'Idle — awaiting first tick');
    expect(dot('Idle')?.className).toContain('bg-muted-fg');
    expect(dot('Idle')?.className).not.toContain('border');
  });

  it('selecting a profile navigates to that profile’s account-nested page', async () => {
    await renderNav([row({ profileId: PA, name: 'Real' })]);

    await userEvent.click(await screen.findByRole('button', { name: 'Real' }));

    // The URL now owns focus: selecting a profile routes to its per-profile page
    // under the active account. Active treatment follows the route param, which
    // this mocked navigate does not commit; the route-driven active state is
    // covered by the aria-current test below.
    expect(navigateSpy).toHaveBeenCalledWith({
      to: '/accounts/$accountId/profiles/$profileId',
      params: { accountId: ACCOUNT_ID, profileId: PA },
    });
  });

  it('marks the profile row that matches the routed profile as aria-current', async () => {
    await renderNav(
      [row({ profileId: PA, name: 'Real' }), row({ profileId: PB, name: 'Stopped' })],
      `/accounts/${ACCOUNT_ID}/profiles/${PB}`,
    );

    expect(await screen.findByRole('button', { name: 'Stopped' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Real' })).not.toHaveAttribute('aria-current');
  });

  it('renders an ACCOUNT section, between Profiles and System, whose links carry the active account', async () => {
    // Dust transfer and orphan orders are where the operator goes when something
    // has gone wrong on the exchange. They used to hang off the account settings
    // page because the sidebar had to guess which account they meant; the account
    // is now in the URL, so they belong one click away.
    await renderNav([row({ profileId: PA, name: 'Real' })]);

    const dust = await screen.findByRole('link', { name: 'Dust transfer' });
    expect(dust).toHaveAttribute('href', `/accounts/${ACCOUNT_ID}/dust-transfer`);
    expect(screen.getByRole('link', { name: 'Orphan orders' })).toHaveAttribute(
      'href',
      `/accounts/${ACCOUNT_ID}/orphan-orders`,
    );
    expect(screen.getByRole('link', { name: 'Manage account' })).toHaveAttribute(
      'href',
      `/accounts/${ACCOUNT_ID}/settings`,
    );

    const nav = screen.getByTestId('side-nav');
    const labels = [...nav.querySelectorAll('div')]
      .map((d) => d.textContent)
      .filter((txt): txt is string => txt === 'Profiles' || txt === 'Account' || txt === 'System');
    expect(labels).toEqual(['Profiles', 'Account', 'System']);
  });

  it('lights the active route with the accent left-rule treatment', async () => {
    await renderNav([row({ profileId: PA, name: 'Real' })]);
    // Initial route is '/', so the Overview (Home) link is active.
    const home = await screen.findByRole('link', { name: 'Overview' });
    expect(home.className).toContain('text-accent');
  });
});
