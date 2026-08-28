// MobileProfilesSheet — the bottom nav's Profiles destination, and the only way a phone reaches a profile section.
//
// The guard that matters most here is the same one side-nav.test.tsx pins for the desktop row: the profile row links to the profile OVERVIEW, so it must not claim `aria-current="page"` from a section page. It is worth its own test on this surface because a hand-written `aria-current` cannot enforce it — TanStack spreads its own active props last — so the only thing standing between this and two elements claiming to be the current page is `activeOptions={{ exact: true }}`.

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
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileProfilesSheet } from '@/app/mobile-profiles-sheet';
import { PROFILE_NAV_ITEMS } from '@/features/profile/lib/profile-sections';

import type { DashboardAggregateResponse } from '@app/contracts';

// Matches the global test-setup default active account, which the sheet reads via useActiveAccountId to build every nested link.
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const PROFILE_A = '00000000-0000-4000-8000-00000000000a';
const PROFILE_B = '00000000-0000-4000-8000-00000000000b';

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

const ROWS: Row[] = [
  row({ profileId: PROFILE_A, name: 'btc-real' }),
  row({ profileId: PROFILE_B, name: 'eth-test', killSwitch: true }),
];

/**
 * Mount the sheet's trigger at a given route and open it.
 *
 * @param initialPath - Route to mount at; the sheet reads `profileId` from it to decide which profile expands.
 * @param demoMode - Public live demo: the sheet drops the rows fronting routes that 403 for the demo operator. Built per render because a route component is fixed once its route is created.
 * @returns The opened sheet panel.
 */
const openSheet = async (initialPath: string, demoMode = false): Promise<HTMLElement> => {
  const testRoot = createRootRoute({
    component: () => (
      <>
        <MobileProfilesSheet
          demoMode={demoMode}
          trigger={
            <button type="button" data-testid="trigger">
              Profiles
            </button>
          }
        />
        <Outlet />
      </>
    ),
  });
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => testRoot, path, component: () => null });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/dashboard-aggregate')) return json({ profiles: ROWS });
      return new Response(null, { status: 404 });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree: testRoot.addChildren([
      stub('/accounts/$accountId'),
      stub('/accounts/$accountId/profiles/new'),
      stub('/accounts/$accountId/profiles/$profileId'),
      // Derived from the registry the sheet itself renders, so a new section cannot pass here by being absent from the test's route tree.
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
  await userEvent.click(await screen.findByTestId('trigger'));
  return screen.findByTestId('mobile-profiles-sheet');
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('<MobileProfilesSheet>', () => {
  it('lists every profile as a real link into that profile', async () => {
    const sheet = await openSheet(`/accounts/${ACCOUNT_ID}`);
    expect(await within(sheet).findByRole('link', { name: /btc-real/ })).toHaveAttribute(
      'href',
      `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_A}`,
    );
    expect(within(sheet).getByRole('link', { name: /eth-test/ })).toHaveAttribute(
      'href',
      `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_B}`,
    );
  });

  it('expands only the profile the route is inside, so the list it exists to show is not buried', async () => {
    const sheet = await openSheet(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_A}/risk`);
    await within(sheet).findByRole('link', { name: /btc-real/ });
    // Exactly one, not two: if every profile expanded, each section label would appear once per profile.
    expect(within(sheet).getAllByRole('link', { name: 'Risk' })).toHaveLength(1);
    expect(within(sheet).getByRole('link', { name: 'Risk' })).toHaveAttribute(
      'href',
      `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_A}/risk`,
    );
  });

  it('does not call the profile row the current page while a section below it is', async () => {
    // The defect this closes: the row points at the profile OVERVIEW, so the router's default non-exact matching would stamp aria-current="page" on it from every section page, leaving two elements in one nav both claiming to be current.
    const sheet = await openSheet(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_A}/risk`);
    const profileRow = await within(sheet).findByRole('link', { name: /btc-real/ });
    expect(profileRow).not.toHaveAttribute('aria-current');
    expect(within(sheet).getByRole('link', { name: 'Risk' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(sheet).getAllByRole('link', { current: 'page' })).toHaveLength(1);
  });

  it('marks the profile row current on the profile overview itself', async () => {
    const sheet = await openSheet(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_A}`);
    expect(await within(sheet).findByRole('link', { name: /btc-real/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('closes on navigation, so the sheet does not sit over the page it just opened', async () => {
    const sheet = await openSheet(`/accounts/${ACCOUNT_ID}`);
    await userEvent.click(await within(sheet).findByRole('link', { name: /btc-real/ }));
    expect(screen.queryByTestId('mobile-profiles-sheet')).toBeNull();
  });

  it('gives every row a 44px touch target, the bar being the only navigation a phone has', async () => {
    const sheet = await openSheet(`/accounts/${ACCOUNT_ID}`);
    await within(sheet).findByRole('link', { name: /btc-real/ });
    for (const link of within(sheet).getAllByRole('link')) {
      expect(link.className).toMatch(/min-h-11/);
    }
  });

  it('lists the profile Notifications row outside the demo', async () => {
    // The control case for the demo test below: without it, that test would pass
    // just as well against a sheet that never rendered the row at all.
    const sheet = await openSheet(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_A}`);
    expect(await within(sheet).findByRole('link', { name: 'Notifications' })).toHaveAttribute(
      'href',
      `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_A}/notifications`,
    );
  });

  it('omits the profile Notifications row in demo mode while keeping the rest of the expansion', async () => {
    // Notifications fronts the notifier-provider routes, which 403 for the demo operator. The phone has no other nav, so a row that leads to a 403 is the whole surface being wrong, not a cosmetic one.
    const sheet = await openSheet(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_A}`, true);
    await within(sheet).findByRole('link', { name: /btc-real/ });
    expect(within(sheet).queryByRole('link', { name: 'Notifications' })).toBeNull();
    for (const name of ['Overview', 'Risk', 'Backtest', 'History']) {
      expect(within(sheet).getByRole('link', { name })).toBeInTheDocument();
    }
  });

  it('offers New profile so the sheet is a complete launcher', async () => {
    const sheet = await openSheet(`/accounts/${ACCOUNT_ID}`);
    expect(await within(sheet).findByRole('link', { name: /New profile/ })).toHaveAttribute(
      'href',
      `/accounts/${ACCOUNT_ID}/profiles/new`,
    );
  });
});

// The scroll affordance. A clipped list with no visible scrollbar reads as a list that simply ends, and iOS never shows one until the operator is already dragging. This sheet clips at ONE profile once a profile is expanded — ten section rows at 44px each is 484px against roughly 467px of room at 375x667 — which is the ordinary case, since the operator opens this sheet from a profile page.
describe('<MobileProfilesSheet> scroll affordance', () => {
  type Geometry = { scrollHeight: number; clientHeight: number; scrollTop: number };

  /**
   * Impose scroll metrics happy-dom would otherwise report as 0.
   *
   * @param el - The element to impose scroll metrics on, defined as own properties so they shadow happy-dom's prototype getters, which return a constant zero and would otherwise read as "nothing overflows".
   * @param geometry - The scroll metrics to impose, chosen so that `scrollHeight` exceeding `clientHeight` is what makes an edge clipped.
   */
  const setGeometry = (el: HTMLElement, geometry: Geometry): void => {
    Object.defineProperty(el, 'scrollHeight', { value: geometry.scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: geometry.clientHeight, configurable: true });
    el.scrollTop = geometry.scrollTop;
  };

  // happy-dom's own ResizeObserver never fires its callback, so a re-measure has to be driven by hand. There is no global stub in setup.ts, so this file installs and restores its own.
  let roCallback: ResizeObserverCallback | null = null;
  class FakeResizeObserver {
    constructor(cb: ResizeObserverCallback) {
      roCallback = cb;
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  /**
   * Open the sheet and hand its list scroller the geometry a phone would produce.
   *
   * Ordering is load-bearing and cannot be flattened: Radix unmounts `SheetContent` while the sheet is closed, so the scroller does not exist to be stubbed until after the sheet opens, and the hook has already taken its first measurement of an unstubbed (zero) box by then. Firing the observer afterwards is what makes the stubbed numbers the ones it answers from.
   *
   * @param initialPath - Route to mount at; a path inside a profile is what expands that profile and overflows the list.
   * @param geometry - The scroller metrics to impose.
   * @returns The opened sheet panel.
   */
  const openSheetWithGeometry = async (
    initialPath: string,
    geometry: Geometry,
  ): Promise<HTMLElement> => {
    const sheet = await openSheet(initialPath);
    await within(sheet).findByRole('link', { name: /btc-real/ });
    setGeometry(screen.getByTestId('mobile-profiles-scroll'), geometry);
    act(() => {
      // Asserted rather than optional-chained: the one case expecting no fades reads `false/false`, which is also the hook's initial state, so a silent no-op here would let that case pass over a hook that never observed the scroller at all.
      if (!roCallback) throw new Error('the overflow hook never observed the sheet scroller');
      roCallback([], {} as ResizeObserver);
    });
    return sheet;
  };

  /**
   * The hook's answer, read off the scroller rather than off what was drawn from it.
   *
   * Strictly stronger than looking for the fade nodes: those prove a rendering, these prove the measurement behind it, so a scroller that stopped observing its content fails here even if some other path happened to paint a gradient. Mirrors the sidebar, where the same two attributes are asserted for the same reason.
   *
   * @param top - Whether content is expected to be hidden above the visible box.
   * @param bottom - Whether content is expected to be hidden below it.
   */
  const expectEdges = (top: boolean, bottom: boolean): void => {
    const scroller = screen.getByTestId('mobile-profiles-scroll');
    expect(scroller).toHaveAttribute('data-overflow-top', String(top));
    expect(scroller).toHaveAttribute('data-overflow-bottom', String(bottom));
  };

  const realResizeObserver = globalThis.ResizeObserver;
  beforeEach(() => {
    roCallback = null;
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    globalThis.ResizeObserver = realResizeObserver;
  });

  it('fades only the bottom edge while the list sits at the top of its scroll', async () => {
    await openSheetWithGeometry(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_A}`, {
      scrollHeight: 800,
      clientHeight: 400,
      scrollTop: 0,
    });

    expect(screen.getByTestId('mobile-profiles-fade-bottom')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-profiles-fade-top')).toBeNull();
    expectEdges(false, true);
  });

  it('fades both edges mid-list', async () => {
    await openSheetWithGeometry(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_A}`, {
      scrollHeight: 800,
      clientHeight: 400,
      scrollTop: 200,
    });

    expect(screen.getByTestId('mobile-profiles-fade-top')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-profiles-fade-bottom')).toBeInTheDocument();
    expectEdges(true, true);
  });

  it('fades only the top edge once the list is scrolled to its end', async () => {
    await openSheetWithGeometry(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_A}`, {
      scrollHeight: 800,
      clientHeight: 400,
      scrollTop: 400,
    });

    expect(screen.getByTestId('mobile-profiles-fade-top')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-profiles-fade-bottom')).toBeNull();
    expectEdges(true, false);
  });

  it('renders neither fade node when the list fits', async () => {
    // Absent, not transparent: an opacity-toggled fade still lays a gradient over the first and last rows of a list that has nothing hidden past either edge.
    await openSheetWithGeometry(`/accounts/${ACCOUNT_ID}`, {
      scrollHeight: 400,
      clientHeight: 400,
      scrollTop: 0,
    });

    expect(screen.queryByTestId('mobile-profiles-fade-top')).toBeNull();
    expect(screen.queryByTestId('mobile-profiles-fade-bottom')).toBeNull();
    expectEdges(false, false);
  });

  it('keeps both fades out of the accessibility tree and out of the way of a tap', async () => {
    // The fade sits over the first and last rows, which are 44px touch targets. Without `pointer-events-none` it swallows the tap that opens a profile, and without `aria-hidden` a screen reader announces a decoration.
    await openSheetWithGeometry(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_A}`, {
      scrollHeight: 800,
      clientHeight: 400,
      scrollTop: 200,
    });

    for (const testId of ['mobile-profiles-fade-top', 'mobile-profiles-fade-bottom']) {
      const fade = screen.getByTestId(testId);
      expect(fade).toHaveAttribute('aria-hidden', 'true');
      expect(fade.className).toMatch(/(^|\s)pointer-events-none(\s|$)/);
    }
  });

  it('scrolls the profile list only, leaving the sheet header pinned', async () => {
    // A bottom fade drawn on a scroller that also holds the header anchors to the wrong edge, and the header scrolling away leaves the operator inside an unlabelled list. The file's own comment already claimed this while `overflow-y-auto` sat on `SheetContent` itself.
    const sheet = await openSheetWithGeometry(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_A}`, {
      scrollHeight: 800,
      clientHeight: 400,
      scrollTop: 0,
    });

    const scroller = screen.getByTestId('mobile-profiles-scroll');
    const title = within(sheet).getByText('Profiles');
    expect(scroller.contains(title)).toBe(false);
    // And the list itself IS inside it, so the assertion above cannot pass over a scroller that holds nothing.
    expect(scroller.contains(within(sheet).getByRole('link', { name: /btc-real/ }))).toBe(true);
  });
});
