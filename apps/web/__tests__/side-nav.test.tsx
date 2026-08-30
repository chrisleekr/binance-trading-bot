// SideNav — the desktop-only collapsible left sidebar (v2 terminal chrome).
// Covers the collapse toggle + its localStorage round-trip, the initial state
// read back from storage, the live profile list (a killed profile swaps its
// green dot for the danger glyph), active-route highlighting, and the active
// profile's inline section expansion.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SideNav } from '@/app/side-nav';
import { PROFILE_NAV_ITEMS } from '@/features/profile/lib/profile-sections';
import { TooltipProvider } from '@/shared/components/ui/tooltip';

import type { DashboardAggregateResponse } from '@app/contracts';

// Matches the global test-setup default active account; SideNav reads it via
// useActiveAccountId and builds every account-nested link/nav from it.
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';

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

const renderNav = async (
  rows: Row[],
  initialPath = `/accounts/${ACCOUNT_ID}`,
  demoMode = false,
): Promise<HTMLElement> => {
  // Standalone root (not the app's __root, which renders its own AppShell+SideNav
  // and would duplicate every link). SideNav lives in the layout so it renders on
  // every route under test; the children are bare stubs for the link/nav targets.
  // Built per render because `demoMode` is a prop of the component under test and
  // a route component is fixed once its route is created.
  const testRoot = createRootRoute({
    component: () => (
      <TooltipProvider delayDuration={150}>
        <SideNav demoMode={demoMode} />
        <Outlet />
      </TooltipProvider>
    ),
  });
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => testRoot, path, component: () => null });
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
      stub('/settings'),
      stub('/settings/backup-restore'),
      // Derived from the registry the sidebar itself renders, so a new section
      // cannot pass here by being absent from the test's route tree.
      ...PROFILE_NAV_ITEMS.filter((i) => i.to !== '/accounts/$accountId/profiles/$profileId').map(
        (i) => stub(i.to),
      ),
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

  it('lists every profile as a link and flags a killed one with the danger glyph instead of the live dot', async () => {
    await renderNav([
      row({ profileId: PA, name: 'Real' }),
      row({ profileId: PB, name: 'Stopped', killSwitch: true }),
    ]);

    // Links, not buttons: this app is built around comparing profiles, so
    // cmd-click into a new tab, copy-link, and the hover URL preview matter
    // more here than anywhere else in the nav — and a button offers none.
    const live = await screen.findByRole('link', { name: 'Real' });
    const killed = await screen.findByRole('link', { name: 'Stopped' });
    expect(live).toHaveAttribute('href', `/accounts/${ACCOUNT_ID}/profiles/${PA}`);
    expect(killed).toHaveAttribute('href', `/accounts/${ACCOUNT_ID}/profiles/${PB}`);
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
    await screen.findByRole('link', { name: 'Live' });
    // The dot is the icon span (aria-hidden, carries a title); the label is a
    // separate untitled span.
    const dot = (name: string): Element | null =>
      screen.getByRole('link', { name }).querySelector('span[title]');

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

  it('marks the profile row that matches the routed profile with aria-current="page"', async () => {
    await renderNav(
      [row({ profileId: PA, name: 'Real' }), row({ profileId: PB, name: 'Stopped' })],
      `/accounts/${ACCOUNT_ID}/profiles/${PB}`,
    );

    // "page", not "true": `page` is the token for a nav item representing the
    // current page, and every nav surface in the app now agrees on it.
    expect(await screen.findByRole('link', { name: 'Stopped' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Real' })).not.toHaveAttribute('aria-current');
  });

  it('lights the profile row inside a section but does not call it the current page', async () => {
    // Two different claims. The row stays lit on every section beneath the
    // profile (that is what "which profile am I in" means), but it links to the
    // profile OVERVIEW — so claiming `aria-current="page"` from a section would
    // announce it as the page it links away from, the same defect the
    // breadcrumb replaced on the old Back link.
    await renderNav(
      [row({ profileId: PA, name: 'Real' })],
      `/accounts/${ACCOUNT_ID}/profiles/${PA}/risk`,
    );

    const profileRow = await screen.findByRole('link', { name: 'Real' });
    expect(profileRow.className).toContain('text-accent');
    expect(profileRow).not.toHaveAttribute('aria-current');
    // The section the operator is actually on carries it instead.
    expect(screen.getByRole('link', { name: 'Risk' })).toHaveAttribute('aria-current', 'page');
  });

  it('expands only the active profile into its own sections', async () => {
    // The profile's pages used to live only inside a modal drawer, which could
    // not show where you are among siblings: moving between Risk and Live gate
    // cost three clicks. Expanding inline makes every section one click from
    // any page in that profile.
    await renderNav(
      [row({ profileId: PA, name: 'Real' }), row({ profileId: PB, name: 'Stopped' })],
      `/accounts/${ACCOUNT_ID}/profiles/${PB}`,
    );

    const risk = await screen.findByRole('link', { name: 'Risk' });
    expect(risk).toHaveAttribute('href', `/accounts/${ACCOUNT_ID}/profiles/${PB}/risk`);
    for (const name of [
      'Overview',
      'Backtest',
      'History',
      'Strategy',
      'Live gate',
      'Profile settings',
    ]) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
    }
    // The inactive profile contributes no section rows, or the list would be
    // buried under ten rows per profile.
    expect(screen.getAllByRole('link', { name: 'Risk' })).toHaveLength(1);
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
    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute(
      'href',
      `/accounts/${ACCOUNT_ID}/settings`,
    );

    const nav = screen.getByTestId('side-nav');
    const labels = [...nav.querySelectorAll('div')]
      .map((d) => d.textContent)
      .filter((txt): txt is string => txt === 'Profiles' || txt === 'Account' || txt === 'System');
    expect(labels).toEqual(['Profiles', 'Account', 'System']);
  });

  it('offers the profile Notifications row outside the demo', async () => {
    // The control case for the demo test below: without it, that test would pass
    // just as well against a sidebar that never rendered the row at all.
    await renderNav(
      [row({ profileId: PA, name: 'Real' })],
      `/accounts/${ACCOUNT_ID}/profiles/${PA}`,
    );
    expect(await screen.findByRole('link', { name: 'Notifications' })).toHaveAttribute(
      'href',
      `/accounts/${ACCOUNT_ID}/profiles/${PA}/notifications`,
    );
  });

  it('omits the profile Notifications row in demo mode while keeping the rest of the expansion', async () => {
    // Notifications fronts the notifier-provider routes, which 403 for the demo
    // operator. The rest of the expansion is read-only and stays.
    await renderNav(
      [row({ profileId: PA, name: 'Real' })],
      `/accounts/${ACCOUNT_ID}/profiles/${PA}`,
      true,
    );
    await screen.findByRole('link', { name: 'Real' });
    expect(screen.queryByRole('link', { name: 'Notifications' })).toBeNull();
    for (const name of ['Overview', 'Risk', 'Backtest', 'History']) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
    }
  });

  it('lights the active route with the accent left-rule treatment', async () => {
    await renderNav([row({ profileId: PA, name: 'Real' })]);
    // Initial route is '/', so the Home link is active.
    const home = await screen.findByRole('link', { name: 'Home' });
    expect(home.className).toContain('text-accent');
  });
});

// The sidebar used to be ONE scroll container: the active profile expands inline,
// so a long profile list pushed ACCOUNT, SYSTEM and the collapse control below the
// fold — and `mt-auto` on the footer pinned that control to the end of the SCROLL
// CONTENT, not the viewport, so the one control that shrinks the sidebar was the
// first thing to disappear. Only the profile list may scroll; everything else is
// pinned at its natural height.
describe('<SideNav> profile-list scroll containment', () => {
  /**
   * The `Section` wrapper that owns a given uppercase label.
   *
   * `Section` renders `<div class="border-b …"><div class="…uppercase">LABEL</div>{rows}</div>`, so the only element whose `textContent` is exactly the label is that inner label div — the wrapper's own text also carries every row beneath it. Walking up one parent from there reaches the wrapper without depending on child order.
   *
   * Throws rather than returning null so a renamed section fails as "no such section" here instead of surfacing as a confusing `expect(null)` in the caller.
   *
   * @param nav - The mounted `side-nav` element to search within.
   * @param label - The rendered section label, e.g. `Account`.
   * @returns The section's outer wrapper div, the element carrying the flex sizing classes.
   */
  const sectionWrapper = (nav: HTMLElement, label: string): HTMLElement => {
    const labelDiv = [...nav.querySelectorAll('div')].find((d) => d.textContent === label);
    if (!labelDiv?.parentElement) throw new Error(`no side-nav section labelled "${label}"`);
    return labelDiv.parentElement;
  };

  /**
   * Force a scroll geometry onto the profiles scroller and let the overflow hook re-measure.
   *
   * happy-dom has no layout engine, so `scrollHeight`/`clientHeight` are always 0 and no amount of real content moves them. Overriding them as own properties shadows the prototype getters, and dispatching `scroll` runs exactly the listener the hook registers — which is the code path under test, not a simulation of it.
   *
   * Wrapped in `act` because the listener sets React state, and the suite setup fails any test that logs an act() warning.
   *
   * @param scroll - The `side-nav-profiles-scroll` element.
   * @param geometry - The scroll metrics to impose: total content height, visible height, and current offset.
   */
  const setScrollGeometry = (
    scroll: HTMLElement,
    geometry: { scrollHeight: number; clientHeight: number; scrollTop: number },
  ): void => {
    Object.defineProperty(scroll, 'scrollHeight', {
      value: geometry.scrollHeight,
      configurable: true,
    });
    Object.defineProperty(scroll, 'clientHeight', {
      value: geometry.clientHeight,
      configurable: true,
    });
    scroll.scrollTop = geometry.scrollTop;
    act(() => {
      scroll.dispatchEvent(new Event('scroll'));
    });
  };

  it('makes the profiles list the only scrolling region and pins the rest', async () => {
    const nav = await renderNav([row({ profileId: PA, name: 'Real' })]);
    await screen.findByRole('link', { name: 'Real' });

    // The profile list owns the scrollbar.
    const scroll = screen.getByTestId('side-nav-profiles-scroll');
    expect(scroll.className.split(/\s+/)).toContain('overflow-y-auto');

    // Its section is the flex child allowed to give: `flex-1` takes the leftover
    // rail height, and the explicit min-height is what lets it shrink below its
    // CONTENT (a flex item refuses to by default) without shrinking to ZERO —
    // `min-h-0` would permit the latter, and a section that shrank to nothing
    // leaves the rail's own fallback scroll with nothing to reveal.
    // Matched against the TOKEN list rather than as substrings: a breakpoint-
    // prefixed variant (`md:shrink-0`, `md:flex-1`) contains the bare token and
    // would satisfy a substring check while applying at no width this rail is
    // ever rendered at.
    const classesOf = (el: Element): string[] => el.className.split(/\s+/);
    const profilesSection = sectionWrapper(nav, 'Profiles');
    expect(profilesSection.contains(scroll)).toBe(true);
    expect(classesOf(profilesSection)).toContain('flex-1');
    expect(classesOf(profilesSection)).toContain('min-h-[5.5rem]');
    // Substring on purpose, and safe: `min-h-0` is not a substring of
    // `min-h-[5.5rem]`, so this catches the floor being written as any variant of
    // `min-h-0` rather than only the bare token.
    expect(profilesSection.className).not.toContain('min-h-0');

    // C2: every other section keeps its natural height instead of being squeezed
    // by the profile list.
    expect(classesOf(sectionWrapper(nav, 'Monitor'))).toContain('shrink-0');
    expect(classesOf(sectionWrapper(nav, 'Account'))).toContain('shrink-0');
    expect(classesOf(sectionWrapper(nav, 'System'))).toContain('shrink-0');

    // The collapse control sits in a pinned footer. `mt-auto` is the actual
    // defect: it pushed the footer to the end of the scroll CONTENT, so the one
    // control that would shrink the sidebar was the first to fall below the fold.
    const footer = screen.getByTestId('side-nav-toggle').parentElement;
    if (!footer) throw new Error('the collapse control has no footer wrapper');
    expect(classesOf(footer)).toContain('shrink-0');
    expect(footer.className).not.toContain('mt-auto');
  });

  it('keeps the pinned sections outside the profiles scroll region as profiles grow', async () => {
    // Six profiles with one expanded is the regression shape: the expansion adds
    // ~600px of rows, which is what used to push ACCOUNT and SYSTEM off-screen.
    const ids = [
      PA,
      PB,
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    ];
    await renderNav(
      ids.map((id, i) => row({ profileId: id, name: `Profile ${i + 1}` })),
      `/accounts/${ACCOUNT_ID}/profiles/${PA}`,
    );
    await screen.findByRole('link', { name: 'Profile 1' });

    const scroll = screen.getByTestId('side-nav-profiles-scroll');
    expect(scroll.contains(screen.getByRole('link', { name: 'Account' }))).toBe(false);
    expect(scroll.contains(screen.getByRole('link', { name: 'Dust transfer' }))).toBe(false);
    expect(scroll.contains(screen.getByRole('link', { name: 'Settings' }))).toBe(false);
    expect(scroll.contains(screen.getByTestId('side-nav-toggle'))).toBe(false);

    // The other direction, and the half that makes this test mean something: a
    // scroller containing nothing at all would satisfy every assertion above.
    // The growth that caused the bug has to land INSIDE the scroll region.
    expect(scroll.contains(screen.getByRole('link', { name: 'Profile 6' }))).toBe(true);
    expect(scroll.contains(screen.getByRole('link', { name: 'Risk' }))).toBe(true);
    expect(scroll.contains(screen.getByRole('link', { name: 'Profile settings' }))).toBe(true);
    expect(scroll.contains(screen.getByRole('link', { name: 'New profile' }))).toBe(true);
  });

  it('keeps the rail itself scrollable so a too-short viewport cannot strand the collapse control', async () => {
    // C6, and deliberately a no-op against today's markup: the point is that
    // moving the scrollbar into the profile list must not remove the rail's own
    // one. Below roughly 420px of height the pinned sections alone overflow, and
    // without this fallback the collapse control would be clipped with no way to
    // reach it.
    const nav = await renderNav([row({ profileId: PA, name: 'Real' })]);
    expect(nav.className.split(/\s+/)).toContain('overflow-y-auto');
  });

  it('shows no edge affordance while the profile list fits', async () => {
    await renderNav([row({ profileId: PA, name: 'Real' })]);
    await screen.findByRole('link', { name: 'Real' });
    const scroll = screen.getByTestId('side-nav-profiles-scroll');

    // Start overflowing, so "no fade" below is a state the component had to leave
    // rather than the mount-time default it never moved off.
    setScrollGeometry(scroll, { scrollHeight: 500, clientHeight: 200, scrollTop: 100 });
    expect(screen.getByTestId('side-nav-profiles-fade-top')).toBeInTheDocument();

    setScrollGeometry(scroll, { scrollHeight: 200, clientHeight: 200, scrollTop: 0 });
    expect(scroll).toHaveAttribute('data-overflow-top', 'false');
    expect(scroll).toHaveAttribute('data-overflow-bottom', 'false');
    expect(screen.queryByTestId('side-nav-profiles-fade-top')).toBeNull();
    expect(screen.queryByTestId('side-nav-profiles-fade-bottom')).toBeNull();
  });

  it('fades only the bottom edge at the top of an overflowing profile list', async () => {
    await renderNav([row({ profileId: PA, name: 'Real' })]);
    await screen.findByRole('link', { name: 'Real' });
    const scroll = screen.getByTestId('side-nav-profiles-scroll');

    setScrollGeometry(scroll, { scrollHeight: 500, clientHeight: 200, scrollTop: 0 });
    expect(scroll).toHaveAttribute('data-overflow-top', 'false');
    expect(scroll).toHaveAttribute('data-overflow-bottom', 'true');
    expect(screen.queryByTestId('side-nav-profiles-fade-top')).toBeNull();
    expect(screen.getByTestId('side-nav-profiles-fade-bottom')).toBeInTheDocument();
  });

  it('fades both edges when the profile list is scrolled into its middle', async () => {
    await renderNav([row({ profileId: PA, name: 'Real' })]);
    await screen.findByRole('link', { name: 'Real' });
    const scroll = screen.getByTestId('side-nav-profiles-scroll');

    setScrollGeometry(scroll, { scrollHeight: 500, clientHeight: 200, scrollTop: 100 });
    expect(scroll).toHaveAttribute('data-overflow-top', 'true');
    expect(scroll).toHaveAttribute('data-overflow-bottom', 'true');
    expect(screen.getByTestId('side-nav-profiles-fade-top')).toBeInTheDocument();
    expect(screen.getByTestId('side-nav-profiles-fade-bottom')).toBeInTheDocument();
  });

  it('keeps the 1px slack that fractional layout heights need at both edges', async () => {
    // Every other geometry here is a whole number, which makes both slack terms
    // invisible: `scrollTop > 1` and `scrollTop > 0` agree on every integer, and
    // so do `scrollHeight - 1` and `scrollHeight`. Real layout is fractional —
    // a sub-pixel row height leaves `scrollTop` a hair above 0 after a rubber-
    // band and `scrollTop + clientHeight` a hair short of `scrollHeight` at the
    // very end of a scroll — and without the slack the affordance sticks on at
    // both extremes, which is the state it exists to distinguish from.
    await renderNav([row({ profileId: PA, name: 'Real' })]);
    await screen.findByRole('link', { name: 'Real' });
    const scroll = screen.getByTestId('side-nav-profiles-scroll');

    // Resting at the top, half a pixel off zero: nothing is hidden above.
    setScrollGeometry(scroll, { scrollHeight: 500.4, clientHeight: 200, scrollTop: 0.5 });
    expect(scroll).toHaveAttribute('data-overflow-top', 'false');
    expect(scroll).toHaveAttribute('data-overflow-bottom', 'true');

    // Hard against the end, 0.4px short of `scrollHeight`: nothing is hidden below.
    setScrollGeometry(scroll, { scrollHeight: 500.4, clientHeight: 200, scrollTop: 300 });
    expect(scroll).toHaveAttribute('data-overflow-top', 'true');
    expect(scroll).toHaveAttribute('data-overflow-bottom', 'false');
  });

  it('fades only the top edge once the profile list is scrolled to its end', async () => {
    await renderNav([row({ profileId: PA, name: 'Real' })]);
    await screen.findByRole('link', { name: 'Real' });
    const scroll = screen.getByTestId('side-nav-profiles-scroll');

    // 300 + 200 === 500: hard against the end, where a `<=` slip in the bottom
    // predicate would keep claiming there is more below.
    setScrollGeometry(scroll, { scrollHeight: 500, clientHeight: 200, scrollTop: 300 });
    expect(scroll).toHaveAttribute('data-overflow-top', 'true');
    expect(scroll).toHaveAttribute('data-overflow-bottom', 'false');
    expect(screen.getByTestId('side-nav-profiles-fade-top')).toBeInTheDocument();
    expect(screen.queryByTestId('side-nav-profiles-fade-bottom')).toBeNull();
  });
});
