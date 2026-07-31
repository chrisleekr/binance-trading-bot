// The Home overview KPI surface: in 'all' scope the cross-profile SummaryBand
// is the whole header (the unchanged `dashboard-stat-*` band, no scoped strip);
// scoped to one profile, a `scoped-kpi-*` strip renders below it. Driven
// through the real index route so the scope→render wiring is exercised.

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { accountOverviewRoute, DashboardOverview } from '@/features/dashboard/routes/index';
import { accountScopeRoute } from '@/features/account/routes/account-scope';
import { discoveryDashboardQueryKey } from '@/features/profile/api/discovery';
import { rootRoute } from '@/app/__root';

import type { DashboardAggregateResponse, DiscoveryDashboardResponse } from '@app/contracts';

const PID = '00000000-0000-4000-8000-0000000000a1';
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const TEST_ACCOUNT = {
  id: ACCOUNT_ID,
  name: 'Main',
  binanceMode: 'test' as const,
  apiKeyConfigured: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const row = (
  overrides: Partial<DashboardAggregateResponse['profiles'][number]>,
): DashboardAggregateResponse['profiles'][number] => ({
  profileId: PID,
  name: 'btc-real',
  enabled: true,
  binanceMode: 'live',
  lastTickAt: null,
  lastTickLatencyMs: null,
  apiKeyConfigured: true,
  lastTickError: null,
  killSwitch: false,
  openOrderCount: 0,
  openOrders: [],
  openPositionCount: 0,
  positions: [],
  ...overrides,
});

// Minimal discovery payload the scoped strip reads (gauge + scoreboard).
const discovery = (): DiscoveryDashboardResponse =>
  ({
    config: { enabled: true } as DiscoveryDashboardResponse['config'],
    scoreboard: {
      realizedProfit: '12.5',
      realizedProfitPercent: '0',
      totalFees: '0',
      netProfit: '12.5',
      tradeCount: 4,
      winRate: 0.5,
      realizedProfit7d: '3.25',
      netProfit7d: '3.25',
      tradeCount7d: 0,
    },
    gauge: { deployedQuote: '120', maxAccountExposureQuote: '500', autoSymbolCount: 2 },
    quoteAsset: 'USDT',
    universe: null,
    holdings: [],
    autoSymbols: [],
    activity: [],
  }) as unknown as DiscoveryDashboardResponse;

const stub = (path: string) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => null });

const setUp = (scope: string, opts: { seedScoreboard?: boolean } = {}): void => {
  const { seedScoreboard = true } = opts;
  // Focus is URL-driven now: `all` stays on the account overview; a profile id
  // routes to the per-profile page where the scoped strip renders.
  const focusId = scope === 'all' ? null : scope;
  const queryClient = createQueryClient();
  queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
  queryClient.setQueryData(['accounts'], [TEST_ACCOUNT]);
  queryClient.setQueryData(['dashboard-aggregate', ACCOUNT_ID], { profiles: [row({})] });
  queryClient.setQueryData(['audit-logs', PID, 'recent'], { items: [], nextCursor: null });
  queryClient.setQueryData(['profile-dashboard', PID], {
    profileId: PID,
    enabled: true,
    binanceMode: 'live',
    balances: [],
    totalProfit: '0',
    enabledNotifierCount: 1,
    symbols: [],
    cachedAt: '2026-06-04T00:00:00.000Z',
  });
  // Seed the discovery + closed-trades + scoreboard reads the scoped strip fans
  // out so they resolve from cache instead of hitting the network. The ranged
  // scoreboard (realised/win-rate/trades) is its own query keyed by period
  // (#504); seed 'd' and 'w' with distinct counts so a toggle is observable.
  queryClient.setQueryData(discoveryDashboardQueryKey(PID), discovery());
  const scoreboard = (period: string, tradeCount: number, winRate: number) => ({
    period,
    tz: 'UTC',
    from: '2026-06-04T00:00:00.000Z',
    to: '2026-06-04T00:00:00.000Z',
    realizedProfit: '12.5',
    realizedProfitPercent: '0',
    totalFees: '0',
    netProfit: '12.5',
    tradeCount,
    winRate,
    // Discovery is the edge here (3 wins, no losers → PF ∞); manual is the drag
    // (1 win 1 loss, gross 1 vs 2 → PF 0.5, the sub-1 path).
    bySource: [
      {
        source: 'auto',
        realizedProfit: '12.5',
        totalFees: '0',
        netProfit: '12.5',
        tradeCount: 3,
        wins: 3,
        losses: 0,
        grossProfit: '12.5',
        grossLoss: '0',
      },
      {
        source: 'manual',
        realizedProfit: '-1',
        totalFees: '0',
        netProfit: '-1',
        tradeCount: 2,
        wins: 1,
        losses: 1,
        grossProfit: '1',
        grossLoss: '2',
      },
    ],
  });
  // The tz tail is the operator's configured zone (default 'UTC' without a
  // TimezoneProvider) — the server cuts the period boundaries in it, so it is
  // part of the key.
  if (seedScoreboard) {
    queryClient.setQueryData(['discovery-scoreboard', PID, 'd', 'UTC'], scoreboard('d', 4, 0.5));
    queryClient.setQueryData(['discovery-scoreboard', PID, 'w', 'UTC'], scoreboard('w', 9, 0.25));
  }
  const closed = (period: string) => ({
    period,
    tz: 'UTC',
    from: '2026-06-04T00:00:00.000Z',
    to: '2026-06-04T00:00:00.000Z',
    totalProfit: '0',
    totalProfitPercent: '0',
    tradeCount: 0,
  });
  queryClient.setQueryData(['closed-trades', PID, 'd', 'UTC'], closed('d'));
  queryClient.setQueryData(['closed-trades', PID, 'w', 'UTC'], closed('w'));

  const profileStub = createRoute({
    getParentRoute: () => accountScopeRoute,
    path: '/profiles/$profileId',
    component: function FocusedOverview() {
      const { profileId } = profileStub.useParams();
      return <DashboardOverview focusedProfileId={profileId} />;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      stub('/onboarding'),
      stub('/login'),
      accountScopeRoute.addChildren([
        accountOverviewRoute,
        profileStub,
        createRoute({
          getParentRoute: () => accountScopeRoute,
          path: '/profiles/new',
          component: () => null,
        }),
      ]),
    ]),
    context: { queryClient },
    history: createMemoryHistory({
      initialEntries: [
        focusId ? `/accounts/${ACCOUNT_ID}/profiles/${focusId}` : `/accounts/${ACCOUNT_ID}`,
      ],
    }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
};

describe('Home KPI surface — scoped vs unscoped', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("'all' scope renders the cross-profile band and no scoped strip", async () => {
    setUp('all');
    expect(await screen.findByTestId('dashboard-order-stats')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-stat-positions')).toBeInTheDocument();
    expect(screen.queryByTestId('scoped-kpi-strip')).toBeNull();
    // The profile status badge is profile-scoped; it must not appear in 'all'.
    expect(screen.queryByTestId('profile-status-state')).toBeNull();
  });

  it('scoped to one profile renders the scoped KPI strip below the band', async () => {
    setUp(PID);
    // The cross-profile band is still present (byte-identical in 'all' scope is
    // covered by index-route.test.tsx; here it simply coexists with the strip).
    expect(await screen.findByTestId('dashboard-order-stats')).toBeInTheDocument();
    const strip = await screen.findByTestId('scoped-kpi-strip');
    expect(strip).toBeInTheDocument();
    expect(screen.getByTestId('scoped-kpi-deployed')).toHaveTextContent('120');
    expect(screen.getByTestId('scoped-kpi-exposure-cap')).toHaveTextContent('500');
    expect(screen.getByTestId('scoped-kpi-trades')).toHaveTextContent('4');
    // winRate 0.5 is a 0 to 1 ratio; the cell must scale it to a percent, not "0.50%".
    expect(screen.getByTestId('scoped-kpi-win-rate')).toHaveTextContent('50.00%');
    // The four discovery tiles added with the labelled Discovery section.
    expect(screen.getByTestId('scoped-kpi-auto-symbols')).toHaveTextContent('2');
    expect(screen.getByTestId('scoped-kpi-holdings')).toHaveTextContent('0');
    expect(screen.getByTestId('scoped-kpi-realised')).toHaveTextContent('12.5');
    expect(screen.getByTestId('scoped-kpi-realised-7d')).toHaveTextContent('3.25');
    // The enabled/status badge now rides in the overview header, not the strip.
    expect(screen.getByTestId('profile-status-state')).toBeInTheDocument();
  });

  it('renders the P/L by-source band with win% and profit factor per source', async () => {
    setUp(PID);
    const band = await screen.findByTestId('scoped-by-source');
    expect(band).toBeInTheDocument();
    // Discovery slice: 3 wins of 3, no losers → 100% win, unbounded PF (∞).
    const auto = screen.getByTestId('scoped-source-auto');
    expect(auto).toHaveTextContent('Discovery (auto-found)');
    expect(auto).toHaveTextContent('100% win');
    expect(auto).toHaveTextContent('PF ∞');
    // Manual slice: 1 win of 2, gross 1 vs 2 → 50% win, sub-1 PF kept (0.5).
    const manual = screen.getByTestId('scoped-source-manual');
    expect(manual).toHaveTextContent('Manual (pinned)');
    expect(manual).toHaveTextContent('50% win');
    expect(manual).toHaveTextContent('PF 0.5');
  });

  it('omits the by-source band when the scoreboard has no per-source slices', async () => {
    // A scoreboard payload that predates bySource (or a never-traded window) must
    // not crash or render an empty band.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    try {
      setUp(PID, { seedScoreboard: false });
      await screen.findByTestId('scoped-kpi-strip');
      expect(screen.queryByTestId('scoped-by-source')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('tags the point-in-time cards "now" and leaves the period-ranged cards untagged (#504)', async () => {
    setUp(PID);
    await screen.findByTestId('scoped-kpi-strip');
    // Gauge cards have no historical series — they ignore the toggle, so flag them.
    for (const id of ['deployed', 'exposure-cap', 'auto-symbols', 'holdings']) {
      expect(screen.getByTestId(`scoped-kpi-${id}-now`)).toBeInTheDocument();
    }
    // The trade-archive cards follow the period — they must NOT be tagged "now".
    for (const id of ['realised', 'win-rate', 'trades']) {
      expect(screen.queryByTestId(`scoped-kpi-${id}-now`)).toBeNull();
    }
  });

  it('shows an em-dash on the ranged cards while the scoreboard query is still loading (#504)', async () => {
    // Never-resolving fetch so the unseeded scoreboard query stays pending; the
    // dashboard + closed-trades reads remain cache-served, so the gauge cards
    // still render their "now" values.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    try {
      setUp(PID, { seedScoreboard: false });
      await screen.findByTestId('scoped-kpi-strip');
      expect(screen.getByTestId('scoped-kpi-realised')).toHaveTextContent('—');
      expect(screen.getByTestId('scoped-kpi-win-rate')).toHaveTextContent('—');
      expect(screen.getByTestId('scoped-kpi-trades')).toHaveTextContent('—');
      // The point-in-time gauge cards do not depend on the scoreboard query.
      expect(screen.getByTestId('scoped-kpi-deployed')).toHaveTextContent('120');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the D/W/M/All toggle re-filters the ranged KPI cards (#504)', async () => {
    const user = userEvent.setup();
    setUp(PID);
    await screen.findByTestId('scoped-kpi-strip');
    // Day period seeded with 4 trades / 50% win.
    expect(screen.getByTestId('scoped-kpi-trades')).toHaveTextContent('4');
    expect(screen.getByTestId('scoped-kpi-win-rate')).toHaveTextContent('50.00%');

    await user.click(screen.getByTestId('realised-period-w'));

    // Week slot seeded with 9 trades / 25% win — the cards must follow the toggle.
    await vi.waitFor(() => expect(screen.getByTestId('scoped-kpi-trades')).toHaveTextContent('9'));
    expect(screen.getByTestId('scoped-kpi-win-rate')).toHaveTextContent('25.00%');
    // The "now" gauge cards stay put regardless of the period.
    expect(screen.getByTestId('scoped-kpi-deployed')).toHaveTextContent('120');
  });
});
