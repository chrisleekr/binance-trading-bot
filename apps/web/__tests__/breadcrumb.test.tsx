// Breadcrumb — the orientation control that replaced the per-page `Back` link.
//
// Two guards matter most here and both were real defects the trail exists to
// close: an ancestor link must NOT carry `aria-current` (the old Back link did,
// on every profile sub-page, because TanStack's default non-exact matching
// treats an ancestor as active), and a route must not have to name its own
// ancestors (four of the eighteen Back links named the wrong one).

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { Breadcrumb, buildCrumbs } from '@/shared/components/breadcrumb';
import { createQueryClient } from '@/shared/lib/query-client';

describe('buildCrumbs', () => {
  const m = (
    routeId: string,
    pathname: string,
    title?: string,
    extra: Record<string, unknown> = {},
  ) => ({ routeId, pathname, staticData: title === undefined ? {} : { title }, ...extra });

  it('names every ancestor that declares a title and marks only the leaf current', () => {
    const out = buildCrumbs([
      m('__root__', '/'),
      m('/accounts/$accountId', '/accounts/a', 'Account'),
      m('/accounts/$accountId/profiles/$profileId', '/accounts/a/profiles/p', 'Profile'),
      m('/accounts/$accountId/profiles/$profileId/risk', '/accounts/a/profiles/p/risk', 'Risk'),
    ]);
    expect(out.map((c) => c.label)).toEqual(['Account', 'Profile', 'Risk']);
    expect(out.map((c) => c.current)).toEqual([false, false, true]);
    expect(out[0]?.to).toBe('/accounts/a');
  });

  it('drops layout routes that declare no title, so a trail has no unnamed rung', () => {
    // The account scope and the profile layout render a bare <Outlet />. Without
    // this, `/accounts/a/profiles/p/risk` would produce blank rungs.
    const out = buildCrumbs([
      m('__root__', '/'),
      m('/accounts/$accountId', '/accounts/a', 'Account'),
      m('/scope', '/accounts/a'),
      m('/accounts/$accountId/profiles/$profileId/risk', '/accounts/a/profiles/p/risk', 'Risk'),
    ]);
    expect(out.map((c) => c.label)).toEqual(['Account', 'Risk']);
  });

  it('collapses an index route onto its layout parent, keeping the deeper pathname', () => {
    const out = buildCrumbs([
      m('/accounts/$accountId', '/accounts/a', 'Account'),
      m('/accounts/$accountId/profiles/$profileId', '/accounts/a/profiles/p', 'Profile'),
      m('/accounts/$accountId/profiles/$profileId/', '/accounts/a/profiles/p', 'Overview'),
    ]);
    expect(out.map((c) => c.label)).toEqual(['Account', 'Overview']);
    expect(out).toHaveLength(2);
  });

  it('returns nothing when there is no ancestor to name', () => {
    // A top-level page needs no trail; the caller renders unconditionally, so
    // this is what keeps a lone "Settings" rung off /settings.
    expect(buildCrumbs([m('__root__', '/'), m('/settings', '/settings', 'Settings')])).toEqual([]);
  });

  it('prefers the nav row label over the page title, so a crumb reads as the row the operator clicked', () => {
    // Without this the Risk crumb would read "Risk controls" — the page's own
    // longer heading — and disagree with the sidebar row that led there. Nothing
    // else in this file passes a fullPath, so this is the only anchor on it.
    const out = buildCrumbs([
      m('/prof', '/accounts/a/profiles/p', 'Profile'),
      {
        routeId: '/risk',
        pathname: '/accounts/a/profiles/p/risk',
        fullPath: '/accounts/$accountId/profiles/$profileId/risk',
        staticData: { title: 'Risk controls' },
      },
    ]);
    expect(out.map((c) => c.label)).toEqual(['Profile', 'Risk']);
  });

  it('prefers `crumb` over `title`, so a tab-facing title never stutters in the trail', () => {
    const out = buildCrumbs([
      m('/a', '/a', 'Profile'),
      m('/b', '/b', 'ETHUSDT'),
      m('/c', '/c', 'ETHUSDT config', { staticData: { title: 'ETHUSDT config', crumb: 'Config' } }),
    ]);
    expect(out.map((c) => c.label)).toEqual(['Profile', 'ETHUSDT', 'Config']);
  });

  it('resolves a function title against that match’s own params', () => {
    const out = buildCrumbs([
      m('/a', '/a', 'Profile'),
      {
        routeId: '/sym',
        pathname: '/a/symbols/ethusdt',
        staticData: { title: (p: Record<string, string>) => p['symbol']?.toUpperCase() ?? '?' },
        params: { symbol: 'ethusdt' },
      },
    ]);
    expect(out.map((c) => c.label)).toEqual(['Profile', 'ETHUSDT']);
  });

  it('falls back to the static title when a data-backed label has not loaded, keeping the ancestry true', () => {
    // Skipping the rung instead would re-parent everything below it: the trail
    // would read Account > Risk and claim Risk sits directly under the account.
    const out = buildCrumbs(
      [
        m('/acct', '/accounts/a', 'Account'),
        // fullPath matters: it is what production carries, and the Overview nav
        // row shares this exact path, so without the guard the rung would fall
        // back to "Overview" — one of its own children — instead of "Profile".
        m('/prof', '/accounts/a/profiles/p', 'Profile', {
          fullPath: '/accounts/$accountId/profiles/$profileId',
        }),
        m('/risk', '/accounts/a/profiles/p/risk', 'Risk'),
      ],
      { '/prof': '' },
    );
    expect(out.map((c) => c.label)).toEqual(['Account', 'Profile', 'Risk']);
  });
});

describe('<Breadcrumb>', () => {
  const renderTrail = async (): Promise<void> => {
    const root = createRootRoute({ component: () => <Outlet /> });
    const parent = createRoute({
      getParentRoute: () => root,
      path: '/parent',
      staticData: { title: 'Parent' },
      component: () => <Outlet />,
    });
    const leaf = createRoute({
      getParentRoute: () => parent,
      path: '/leaf',
      staticData: { title: 'Leaf' },
      component: () => <Breadcrumb />,
    });
    const router = createRouter({
      routeTree: root.addChildren([parent.addChildren([leaf])]),
      history: createMemoryHistory({ initialEntries: ['/parent/leaf'] }),
    });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RouterProvider
          router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
        />
      </QueryClientProvider>,
    );
    await act(async () => {
      await router.load();
    });
  };

  it('exposes a Breadcrumb landmark whose ancestors are real links', async () => {
    await renderTrail();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    // A real <a href>, so middle-click and copy-link work — the same reason the
    // sidebar's profile rows stopped being buttons.
    expect(screen.getByRole('link', { name: 'Parent' })).toHaveAttribute('href', '/parent');
  });

  it('renders the current page as text, and puts aria-current on nothing else', async () => {
    await renderTrail();
    // The defect this closes: the old Back link announced itself as the current
    // page while pointing away from it, on every profile sub-page.
    const current = screen.getByText('Leaf');
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current.tagName).not.toBe('A');
    expect(screen.getByRole('link', { name: 'Parent' })).not.toHaveAttribute('aria-current');
    expect(document.querySelectorAll('[aria-current]')).toHaveLength(1);
  });
});
