import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { accountOverviewRoute, DashboardOverview } from '@/features/dashboard/routes/index';
import { accountScopeRoute } from '@/features/account/routes/account-scope';
import { formatLastTick } from '@/shared/lib/format-tick';
import { rootRoute } from '@/app/__root';

import { pendingFetchForPaths } from './helpers/pending-fetch';

import { asDecimalString, type DashboardAggregateResponse } from '@app/contracts';

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const DASHBOARD_AGGREGATE_PATH = `/api/accounts/${ACCOUNT_ID}/dashboard-aggregate`;
const TEST_ACCOUNT = {
  id: ACCOUNT_ID,
  name: 'Main',
  binanceMode: 'test' as const,
  apiKeyConfigured: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const aggregate = (rows: DashboardAggregateResponse['profiles']): DashboardAggregateResponse => ({
  profiles: rows,
});

const row = (
  overrides: Partial<DashboardAggregateResponse['profiles'][number]>,
): DashboardAggregateResponse['profiles'][number] => ({
  profileId: '11111111-1111-4111-8111-111111111111',
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

const stub = (path: string) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => null });

const setUp = (
  data: DashboardAggregateResponse | undefined,
  { scope }: { scope?: string } = {},
) => {
  // Focus is now URL-driven: a single-profile view lives at the per-profile
  // route (`/accounts/$id/profiles/$profileId`), not a localStorage scope. Map
  // a profile-id scope to that route; `all`/undefined stays on the overview.
  const focusId = scope !== undefined && scope !== 'all' ? scope : null;
  const queryClient = createQueryClient();
  // Bypass root loader.
  queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
  // accountScopeRoute.beforeLoad ensures the accounts list; seed it so the
  // active account resolves instead of 404ing the scope.
  queryClient.setQueryData(['accounts'], [TEST_ACCOUNT]);
  if (data !== undefined) queryClient.setQueryData(['dashboard-aggregate', ACCOUNT_ID], data);
  // Seed the per-profile activity-feed queries empty so the ActivityFeed in the
  // home layout resolves from cache instead of hitting the network under test.
  for (const p of data?.profiles ?? []) {
    queryClient.setQueryData(['audit-logs', p.profileId, 'recent'], {
      items: [],
      nextCursor: null,
    });
    // Seed the per-profile dashboard query the flat SymbolTable fans out, so it
    // resolves from cache instead of hitting the network under test.
    queryClient.setQueryData(['profile-dashboard', p.profileId], {
      profileId: p.profileId,
      enabled: p.enabled,
      binanceMode: p.binanceMode,
      balances: [],
      totalProfit: '0',
      symbols: [],
      cachedAt: '2026-06-04T00:00:00.000Z',
    });
  }

  const onboardingStub = stub('/onboarding');
  const loginStub = stub('/login');
  const profileStub = createRoute({
    getParentRoute: () => accountScopeRoute,
    path: '/profiles/$profileId',
    component: function FocusedOverview() {
      // The per-profile route renders the same overview focused on one profile.
      const { profileId } = profileStub.useParams();
      return <DashboardOverview focusedProfileId={profileId} />;
    },
  });
  const profileNewStub = createRoute({
    getParentRoute: () => accountScopeRoute,
    path: '/profiles/new',
    component: () => <div data-testid="profile-new-page" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      onboardingStub,
      loginStub,
      accountScopeRoute.addChildren([accountOverviewRoute, profileStub, profileNewStub]),
    ]),
    context: { queryClient },
    history: createMemoryHistory({
      initialEntries: [
        focusId ? `/accounts/${ACCOUNT_ID}/profiles/${focusId}` : `/accounts/${ACCOUNT_ID}`,
      ],
    }),
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return { router, queryClient, ...utils };
};

describe('Home route /', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', pendingFetchForPaths(DASHBOARD_AGGREGATE_PATH));
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('holds a scrollable placeholder while the aggregate loads', async () => {
    // The shell drops <main>'s scroll on this route, so the loading branch has
    // to carry the scroller and enough height itself. Without that there is
    // nothing under a thumb to drag for the length of the fetch and the app
    // reads as frozen on a phone.
    vi.stubGlobal('fetch', pendingFetchForPaths(DASHBOARD_AGGREGATE_PATH));
    setUp(undefined);
    const loading = await screen.findByTestId('dashboard-loading');
    expect(loading.className).toContain('overflow-y-auto');
    expect(loading.className).toContain('flex-1');
    // Four panels, one announcement.
    expect(loading.querySelectorAll('section')).toHaveLength(4);
    expect(within(loading).getAllByRole('status')).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('hides the profile roster when scoped to a single profile', async () => {
    setUp(
      aggregate([
        row({ profileId: 'a', name: 'profile-a' }),
        row({ profileId: 'b', name: 'profile-b' }),
      ]),
      { scope: 'a' },
    );
    // The roster panel is an all-profile widget; a single-profile scope shows
    // the per-profile KPI strip instead, so the roster (and every card in it)
    // is absent. Wait on the strip so the assertion runs after first paint.
    await screen.findByTestId('scoped-kpi-strip');
    expect(screen.queryByTestId('profile-cards')).toBeNull();
    expect(screen.queryByTestId('profile-card-a')).toBeNull();
    expect(screen.queryByTestId('profile-card-b')).toBeNull();
  });

  it('shows every profile when scope is "all"', async () => {
    setUp(
      aggregate([
        row({ profileId: 'a', name: 'profile-a' }),
        row({ profileId: 'b', name: 'profile-b' }),
      ]),
      { scope: 'all' },
    );
    expect(await screen.findByTestId('profile-card-a')).toBeInTheDocument();
    expect(await screen.findByTestId('profile-card-b')).toBeInTheDocument();
  });

  it('falls back to every profile when the scope id is stale', async () => {
    setUp(
      aggregate([
        row({ profileId: 'a', name: 'profile-a' }),
        row({ profileId: 'b', name: 'profile-b' }),
      ]),
      { scope: 'gone' },
    );
    expect(await screen.findByTestId('profile-card-a')).toBeInTheDocument();
    expect(await screen.findByTestId('profile-card-b')).toBeInTheDocument();
  });

  it('no standalone New profile button in the overview panel', async () => {
    // The action moved into the profile switcher (where the operator already
    // goes to change profile), so the overview header carries no duplicate of
    // it competing with the trading controls.
    setUp(aggregate([row({ profileId: 'a', name: 'profile-a' })]));
    await screen.findByTestId('profile-card-a');
    expect(screen.queryByRole('button', { name: /new profile/i })).toBeNull();
  });

  it('renders one card per profile', async () => {
    setUp(
      aggregate([
        row({ profileId: 'a', name: 'profile-a' }),
        row({ profileId: 'b', name: 'profile-b' }),
      ]),
    );
    expect(await screen.findByTestId('profile-card-a')).toBeInTheDocument();
    expect(await screen.findByTestId('profile-card-b')).toBeInTheDocument();
  });

  it('sums open orders and positions across profiles in the stats strip', async () => {
    setUp(
      aggregate([
        row({
          profileId: 'a',
          name: 'profile-a',
          openOrderCount: 2,
          openOrders: [],
          openPositionCount: 1,
        }),
        row({
          profileId: 'b',
          name: 'profile-b',
          openOrderCount: 3,
          openOrders: [],
          openPositionCount: 2,
        }),
      ]),
    );
    await screen.findByTestId('dashboard-order-stats');
    expect(screen.getByTestId('dashboard-stat-open-orders')).toHaveTextContent('5'); // 2 + 3
    expect(screen.getByTestId('dashboard-stat-positions')).toHaveTextContent('3'); // 1 + 2
  });

  it('renders the kill-switch badge when active', async () => {
    setUp(aggregate([row({ profileId: 'a', name: 'profile-a', killSwitch: true })]));
    expect(await screen.findByTestId('profile-card-a-killswitch')).toBeInTheDocument();
  });

  it('badges a testnet profile but not a live one', async () => {
    setUp(
      aggregate([
        row({ profileId: 'live1', name: 'live', binanceMode: 'live' }),
        row({ profileId: 'test1', name: 'test', binanceMode: 'test' }),
      ]),
    );
    expect(await screen.findByTestId('profile-card-test1-testnet')).toBeInTheDocument();
    expect(screen.queryByTestId('profile-card-live1-testnet')).toBeNull();
  });

  it('badges a disabled profile that still holds exposure', async () => {
    setUp(
      aggregate([row({ profileId: 'a', name: 'profile-a', enabled: false, openOrderCount: 1 })]),
    );
    const badge = await screen.findByTestId('profile-card-a-exposure');
    expect(badge).toBeInTheDocument();
    // Assert the resolved copy, not just the testid — a missing/renamed i18n key
    // would otherwise render the raw key and still pass.
    expect(badge).toHaveTextContent(/orders or position/i);
  });

  it('badges a disabled profile that holds a position but no orders', async () => {
    setUp(
      aggregate([
        row({
          profileId: 'a',
          name: 'profile-a',
          enabled: false,
          openOrderCount: 0,
          openPositionCount: 1,
        }),
      ]),
    );
    expect(await screen.findByTestId('profile-card-a-exposure')).toBeInTheDocument();
  });

  it('does not badge a disabled profile with no exposure', async () => {
    setUp(
      aggregate([
        row({
          profileId: 'a',
          name: 'profile-a',
          enabled: false,
          openOrderCount: 0,
          openPositionCount: 0,
        }),
      ]),
    );
    await screen.findByTestId('profile-card-a');
    expect(screen.queryByTestId('profile-card-a-exposure')).toBeNull();
  });

  it('does not badge an enabled profile that holds exposure', async () => {
    setUp(
      aggregate([row({ profileId: 'a', name: 'profile-a', enabled: true, openOrderCount: 3 })]),
    );
    await screen.findByTestId('profile-card-a');
    expect(screen.queryByTestId('profile-card-a-exposure')).toBeNull();
  });

  it('still renders a disabled profile card with its disabled state badge', async () => {
    setUp(aggregate([row({ profileId: 'a', name: 'profile-a', enabled: false })]));
    expect(await screen.findByTestId('profile-card-a')).toBeInTheDocument();
    const state = await screen.findByTestId('profile-card-a-state');
    expect(state).toHaveTextContent(/disabled/i);
  });

  it('keeps testnet P/L out of the real-money headline', async () => {
    setUp(
      aggregate([
        row({
          profileId: 'live1',
          name: 'live',
          binanceMode: 'live',
          // (110 - 100) * 1 = +10 real
          positions: [
            {
              symbol: 'SOLUSDT',
              avgEntryPrice: asDecimalString('100'),
              currentPrice: asDecimalString('110'),
              quantity: asDecimalString('1'),
            },
          ],
        }),
        row({
          profileId: 'test1',
          name: 'test',
          binanceMode: 'test',
          // (150 - 100) * 1 = +50 practice — must not land in the headline
          positions: [
            {
              symbol: 'SOLUSDT',
              avgEntryPrice: asDecimalString('100'),
              currentPrice: asDecimalString('150'),
              quantity: asDecimalString('1'),
            },
          ],
        }),
      ]),
    );
    const hero = await screen.findByTestId('dashboard-stat-unrealised');
    expect(hero.textContent).toContain('10');
    expect(hero.textContent).not.toContain('50');
    const practice = screen.getByTestId('dashboard-stat-unrealised-practice');
    expect(practice.textContent).toContain('50');
  });

  it('navigates to /profiles/$profileId when a card is clicked', async () => {
    const user = userEvent.setup();
    const { router } = setUp(aggregate([row({ profileId: 'a', name: 'profile-a' })]));
    await user.click(await screen.findByTestId('profile-card-a'));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/accounts/${ACCOUNT_ID}/profiles/a`);
    });
  });

  it('renders the empty-state CTA when there are no profiles', async () => {
    const user = userEvent.setup();
    const { router } = setUp(aggregate([]));
    expect(await screen.findByTestId('home-empty')).toBeInTheDocument();
    const cta = screen.getByRole('button', { name: /create your first profile/i });
    await user.click(cta);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/accounts/${ACCOUNT_ID}/profiles/new`);
    });
  });

  it('sums the open-position inputs into the card PnL', async () => {
    setUp(
      aggregate([
        row({
          profileId: 'a',
          name: 'profile-a',
          // (112.34 - 100) * 1 = 12.34
          positions: [
            {
              symbol: 'SOLUSDT',
              avgEntryPrice: asDecimalString('100'),
              currentPrice: asDecimalString('112.34'),
              quantity: asDecimalString('1'),
            },
          ],
        }),
      ]),
    );
    const pnl = await screen.findByTestId('profile-card-a-pnl');
    expect(pnl.textContent).toContain('12.34');
    // The aggregate is labelled with its quote unit, not a bare number.
    expect(pnl.textContent).toContain('USDT');
  });

  it('renders one labelled total per quote asset when a profile holds two quotes', async () => {
    setUp(
      aggregate([
        row({
          profileId: 'a',
          name: 'profile-a',
          positions: [
            // USDT: (112.34 - 100) * 1 = 12.34
            {
              symbol: 'SOLUSDT',
              avgEntryPrice: asDecimalString('100'),
              currentPrice: asDecimalString('112.34'),
              quantity: asDecimalString('1'),
            },
            // BTC: (0.5 - 0.4) * 2 = 0.2
            {
              symbol: 'ETHBTC',
              avgEntryPrice: asDecimalString('0.4'),
              currentPrice: asDecimalString('0.5'),
              quantity: asDecimalString('2'),
            },
          ],
        }),
      ]),
    );
    const pnl = await screen.findByTestId('profile-card-a-pnl');
    // Both quote totals render with their unit, separated by a middot.
    expect(pnl.textContent).toContain('USDT');
    expect(pnl.textContent).toContain('BTC');
    expect(pnl.textContent).toContain('·');
  });

  it('shows an em-dash when a profile is flat', async () => {
    setUp(aggregate([row({ profileId: 'a', name: 'profile-a', positions: [] })]));
    const pnl = await screen.findByTestId('profile-card-a-pnl');
    expect(pnl.textContent).toContain('—');
  });

  it('renders no awaiting-tick hint once a profile has ticked', async () => {
    setUp(
      aggregate([
        row({
          profileId: 'h1',
          name: 'p',
          lastTickAt: '2026-05-18T00:00:00.000Z',
          apiKeyConfigured: true,
        }),
      ]),
    );
    await screen.findByTestId('profile-card-h1');
    expect(screen.queryByTestId('profile-card-h1-awaiting-hint')).toBeNull();
  });

  it('renders the no-key awaiting hint when lastTickAt is null AND apiKeyConfigured=false', async () => {
    setUp(
      aggregate([row({ profileId: 'h2', name: 'p', lastTickAt: null, apiKeyConfigured: false })]),
    );
    const hint = await screen.findByTestId('profile-card-h2-awaiting-hint');
    expect(hint).toHaveAttribute('data-variant', 'no-key');
    expect(hint).toHaveTextContent('Awaiting first tick · configure API key');
    // API key moved to the account level; the hint links to the account's
    // api-key page (one full-screen surface model across the app).
    expect(screen.getByTestId('profile-card-h2-awaiting-hint-link')).toHaveAttribute(
      'href',
      `/accounts/${ACCOUNT_ID}/api-key`,
    );
  });

  it('renders the key-error variant when apiKeyConfigured AND lastTickError set', async () => {
    setUp(
      aggregate([
        row({
          profileId: 'h3',
          name: 'p',
          lastTickAt: null,
          apiKeyConfigured: true,
          lastTickError: 'cold-load-failed',
        }),
      ]),
    );
    const hint = await screen.findByTestId('profile-card-h3-awaiting-hint');
    expect(hint).toHaveAttribute('data-variant', 'key-error');
    expect(hint).toHaveTextContent('Awaiting first tick · check API key permissions');
  });

  it('renders no hint when apiKeyConfigured AND no error — preserves "Never" label', async () => {
    setUp(
      aggregate([
        row({
          profileId: 'h4',
          name: 'p',
          lastTickAt: null,
          apiKeyConfigured: true,
          lastTickError: null,
        }),
      ]),
    );
    await screen.findByTestId('profile-card-h4');
    expect(screen.queryByTestId('profile-card-h4-awaiting-hint')).toBeNull();
  });
});

describe('formatLastTick', () => {
  // Fake the clock so `Date.now()` inside formatLastTick is fixed: tier
  // boundaries can be asserted exactly, with no real-time rounding slack.
  const NOW = new Date('2026-05-18T00:00:00.000Z');
  const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "Never" for a null or unparseable timestamp', () => {
    expect(formatLastTick(null)).toBe('Never');
    expect(formatLastTick('not-a-date')).toBe('Never');
  });

  it('reports seconds up to the minute boundary', () => {
    expect(formatLastTick(ago(0))).toBe('0s ago');
    expect(formatLastTick(ago(59_000))).toBe('59s ago');
    expect(formatLastTick(ago(60_000))).toBe('1m ago');
  });

  it('rolls up to hours at the 60-minute boundary', () => {
    expect(formatLastTick(ago(59 * 60_000))).toBe('59m ago');
    expect(formatLastTick(ago(60 * 60_000))).toBe('1h ago');
  });

  it('rolls up to days at the 24-hour boundary', () => {
    expect(formatLastTick(ago(23 * 3_600_000))).toBe('23h ago');
    expect(formatLastTick(ago(24 * 3_600_000))).toBe('1d ago');
    expect(formatLastTick(ago(2 * 86_400_000))).toBe('2d ago');
  });
});
