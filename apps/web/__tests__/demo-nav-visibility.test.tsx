// Demo-mode navigation visibility, swept over the whole shell rather than per surface. The four nav surfaces the operator can reach — the sidebar's static sections, the sidebar's expanded profile, the bottom bar, the mobile Profiles sheet — plus the header settings icon all render from one AppShell, so one sweep over every anchor the shell paints proves each of them obeys the registry, and a fifth surface added later is covered without anyone remembering to extend a list here.
//
// The expectation is read off `demoHidden` on the registry entries, never off `visibleInDemo`: a helper that answered wrongly would agree with the components that call it, and the sweep would pass on a shell that leaks every guarded destination. `visibleInDemo` gets its own truth table below instead.
//
// What the sweep CANNOT see: it collects rendered `href`s, so it covers link-based navigation only. A control that navigates from an `onClick`/`onSelect` handler — the account switcher in the top bar is the one such surface today — is structurally invisible here and is covered by its own test file. Adding another button-based nav control means adding a test beside it; this sweep will stay green regardless.
//
// What this does NOT claim: that the hidden set equals the set of destinations fronting a `requireNotDemo` API route. No machine-readable registry of those paths exists, so the required `demoHidden` field is what forces the declaration and these tests prove the surfaces obey it.

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
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '@/app/app-shell';
import { NAV_ITEMS } from '@/app/bottom-nav';
import { ACCOUNT_ITEMS, MONITOR_ITEMS, NEW_PROFILE_ITEM, SYSTEM_ITEMS } from '@/app/side-nav';
import { ONBOARDING_STATUS_QUERY_KEY } from '@/features/auth/api/auth';
import { ProfileProvider } from '@/features/profile/lib/profile-context';
import { PROFILE_NAV_ITEMS } from '@/features/profile/lib/profile-sections';
import { TooltipProvider } from '@/shared/components/ui/tooltip';
import { visibleInDemo } from '@/shared/lib/demo-visibility';

// Matches the global test-setup default active account, which every nav surface reads via useActiveAccountId to build its account-nested links.
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const PROFILE_ID = '00000000-0000-4000-8000-00000000000a';
const PROFILE_NAME = 'btc-real';

/** Every navigation registry the shell renders from, keyed by the surface it feeds so a failure names the registry rather than a bare path. */
const REGISTRIES = {
  'bottom nav': NAV_ITEMS,
  'sidebar monitor': MONITOR_ITEMS,
  'sidebar account': ACCOUNT_ITEMS,
  'sidebar system': SYSTEM_ITEMS,
  // Hand-placed at the end of the profile list rather than inside a section, and rendered by the mobile sheet too, so it is swept as its own one-entry registry rather than left undeclared.
  'new profile': [NEW_PROFILE_ITEM],
  'profile sections': PROFILE_NAV_ITEMS,
} as const;

const ALL_DESTINATIONS = Object.values(REGISTRIES).flat();

/** Route path template -> the href the shell actually paints for this test's account and profile. */
const resolve = (to: string): string =>
  to.replace('$accountId', ACCOUNT_ID).replace('$profileId', PROFILE_ID);

const row = {
  profileId: PROFILE_ID,
  name: PROFILE_NAME,
  enabled: true,
  binanceMode: 'live' as const,
  lastTickAt: null,
  lastTickLatencyMs: null,
  apiKeyConfigured: true,
  lastTickError: null,
  killSwitch: false,
  openOrderCount: 0,
  openPositionCount: 0,
  positions: [],
};

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Render the real AppShell at the active profile's overview, open the Profiles sheet, and return every href the shell painted.
 *
 * Mounted on the profile route because the sidebar and the sheet only expand a profile's sections when the router is inside it — the expansion is one of the four surfaces under test, and off a profile route it renders nothing to sweep.
 *
 * @param demoMode - Seeded into the onboarding-status cache, which is where `useDemoMode` reads it from.
 * @returns Every `href` on the document, portalled sheet content included.
 */
const sweepShell = async (demoMode: boolean): Promise<ReadonlySet<string>> => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/dashboard-aggregate')) return json({ profiles: [row] });
      return json({});
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(ONBOARDING_STATUS_QUERY_KEY, { masterExists: true, demoMode });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <TooltipProvider delayDuration={150}>
          <ProfileProvider>
            <AppShell>
              <Outlet />
            </AppShell>
          </ProfileProvider>
        </TooltipProvider>
      </QueryClientProvider>
    ),
  });
  // Derived from the same registries the assertions read, so a destination cannot pass by being absent from the test's route tree.
  const paths = new Set<string>(ALL_DESTINATIONS.map((d) => d.to));
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      [...paths].map((path) =>
        createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
      ),
    ),
    history: createMemoryHistory({
      initialEntries: [`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}`],
    }),
  });
  render(
    <RouterProvider router={router as unknown as Parameters<typeof RouterProvider>[0]['router']} />,
  );
  await act(async () => {
    await router.load();
  });
  // The profile row only appears once the aggregate resolves, and its section rows render with it — waiting on it is what makes the sidebar expansion part of the sweep rather than a race.
  await screen.findByRole('link', { name: PROFILE_NAME });
  await userEvent.click(await screen.findByTestId('bottom-nav-profiles'));
  await screen.findByTestId('mobile-profiles-sheet');
  return new Set(
    [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? ''),
  );
};

const hiddenDestinations = (): readonly string[] =>
  ALL_DESTINATIONS.filter((d) => d.demoHidden).map((d) => resolve(d.to));
const visibleDestinations = (): readonly string[] =>
  ALL_DESTINATIONS.filter((d) => !d.demoHidden).map((d) => resolve(d.to));

afterEach(() => vi.unstubAllGlobals());

// Hand-written on purpose. Reading this off `demoHidden` would agree with the registry whichever way a flag points, so it could not catch one flipped the wrong way — and every other check in this file derives from the flags. Before this MR the sidebar's System section was wrapped in `{!demoMode && ...}`, so backup/restore could not leak while Settings was hidden; that structural tie is gone and each entry now answers for itself, which is why the set needs pinning rather than counting.
const EXPECTED_HIDDEN: readonly string[] = [
  '/accounts/$accountId/profiles/$profileId/notifications',
  '/accounts/$accountId/settings',
  '/settings',
  '/settings/backup-restore',
];

describe('demo-mode navigation visibility', () => {
  it('hides exactly the destinations whose API routes 403 for the demo operator', () => {
    const declared = [...new Set(ALL_DESTINATIONS.filter((d) => d.demoHidden).map((d) => d.to))];
    expect(declared.sort()).toEqual([...EXPECTED_HIDDEN].sort());
  });

  it('gives one answer per destination, however many registries list it', () => {
    // `/settings` and the account hub are each declared twice (sidebar and bottom nav). A disagreement is caught by the sweep, but both flipped together is not, and nothing else asserts the two copies agree.
    const answers = new Map<string, Set<boolean>>();
    for (const d of ALL_DESTINATIONS) {
      answers.set(d.to, (answers.get(d.to) ?? new Set<boolean>()).add(d.demoHidden));
    }
    expect([...answers].filter(([, a]) => a.size > 1).map(([to]) => to)).toEqual([]);
  });

  it('declares demo visibility on every navigation registry entry', () => {
    // The compiler is the real enforcement: `demoHidden` is a required field on registries that live under src/, so an entry omitting it fails `bun run typecheck`. This backstops the specific weakening tsc would then stop catching — the field made optional and a new entry shipped without it.
    for (const [surface, items] of Object.entries(REGISTRIES)) {
      // A registry emptied by a refactor would walk nothing and pass every check in this file.
      expect(items.length, `${surface} registry is empty`).toBeGreaterThan(0);
      for (const item of items) {
        expect(typeof item.demoHidden, `${surface}: ${item.to}`).toBe('boolean');
      }
    }
  });

  it.each([
    [true, true, false],
    [true, false, true],
    [false, true, true],
    [false, false, true],
  ])(
    'visibleInDemo({ demoHidden: %s }, %s) is %s',
    (demoHidden: boolean, demoMode: boolean, expected: boolean) => {
      expect(visibleInDemo({ demoHidden }, demoMode)).toBe(expected);
    },
  );

  it('renders no link to a demo-hidden destination anywhere in the shell', async () => {
    const hrefs = await sweepShell(true);
    const hidden = hiddenDestinations();
    // Every entry declaring itself visible would make the sweep below assert nothing.
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.filter((href) => hrefs.has(href))).toEqual([]);
    // The shell has to have rendered for the absence above to mean anything: a blank tree would satisfy it too.
    const visible = visibleDestinations();
    // Mirror of the floor above. The registry-emptiness check does not cover this: a full registry whose every entry flipped to `demoHidden: true` leaves nothing to look for, and the sweep would pass against a blank tree.
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.filter((href) => !hrefs.has(href))).toEqual([]);
  });

  it('renders every navigation destination when the demo is off', async () => {
    const hrefs = await sweepShell(false);
    expect(ALL_DESTINATIONS.map((d) => resolve(d.to)).filter((href) => !hrefs.has(href))).toEqual(
      [],
    );
  });
});
