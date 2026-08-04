// Per-site pending-render tests. The shell owns the only scroll surface and
// kills the rubber-band with `overscroll-behavior: none`, so a surface that
// paints one line of text while its query is in flight leaves nothing with
// scroll range under a thumb: on mobile Safari the app reads as frozen for the
// whole fetch. Each test below drives one surface into its pending state and
// pins that the placeholder carries real height.
//
// happy-dom does no layout — `scrollHeight` is always 0 — so height cannot be
// measured here. The proxies are structural, matching the convention already
// used for the router's pending screen: skeleton bars are present, the
// bare-text branch is gone, and the surface announces itself exactly once.

import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { rootRoute } from '@/app/__root';
import { accountScopeRoute } from '@/features/account/routes/account-scope';
import { dustTransferRoute } from '@/features/account/routes/account.dust-transfer';
import { BacktestPriceCharts } from '@/features/backtest/components/backtest-price-charts';
import { ConfigureTab } from '@/features/backtest/components/configure-tab';
import { SymbolPicker } from '@/features/backtest/components/symbol-picker';
import { useBacktestWorkbench } from '@/features/backtest/components/use-backtest-workbench';
import { ActivityFeed } from '@/features/dashboard/components/activity-feed';
import { LiveVsBacktestCard } from '@/features/dashboard/components/live-vs-backtest-card';
import { MarketTrendCard } from '@/features/dashboard/components/market-trend-card';
import { ScopedBalances } from '@/features/dashboard/components/scoped-balances';
import { SymbolRail } from '@/features/dashboard/components/symbol-rail';
import { SymbolTable } from '@/features/dashboard/components/symbol-table';
import { NotificationsPanel } from '@/features/notifications/components/notifications-panel';
import { profileQueryKey } from '@/features/profile/api/profile';
import { DiscoveryDashboard } from '@/features/profile/components/discovery-dashboard';
import { ProfileConfigPanel } from '@/features/profile/components/profile-config-panel';
import { RealisedPnlCard } from '@/features/profile/components/realised-pnl-card';
import { RiskPanel } from '@/features/profile/components/risk-panel';
import { initialState } from '@/features/profile/wizard/reducer';
import { Step2Strategy } from '@/features/profile/wizard/steps/Step2Strategy';
import { SymbolBalancesPanel } from '@/features/symbol/components/symbol-balances-panel';
import { SymbolLogsPanel } from '@/features/symbol/components/symbol-logs-panel';
import { SymbolOrderBookPanel } from '@/features/symbol/components/symbol-order-book-panel';
import { SymbolOrderHistoryPanel } from '@/features/symbol/components/symbol-order-history-panel';
import { SymbolRecentTradesPanel } from '@/features/symbol/components/symbol-recent-trades-panel';
import { SymbolStatsStrip } from '@/features/symbol/components/symbol-stats-strip';
import { SymbolTechnicalsPanel } from '@/features/symbol/components/symbol-technicals-panel';
import { WorkspaceTradeTab } from '@/features/symbol/components/symbol-workspace-trade';
import { PreviewModelView } from '@/features/symbol/preview/strategy-preview-panel';
import { TechnicalsHealthPill } from '@/features/technicals/components/technicals-health-pill';

import type { ChartModule } from '@/features/symbol/components/symbol-candle-chart';
import type { StrategyView } from '@/features/symbol/strategies/types';
import type { BacktestResult, DashboardAggregateResponse } from '@app/contracts';
import type { PreviewModel } from '@app/strategy-core';

const PROFILE_ID = '00000000-0000-4000-8000-0000000000a1';
// Matches the active account seeded for the whole suite in __tests__/setup.ts,
// which the account-nested API paths and `<Link>` hrefs are built from.
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const SYMBOL = 'BTCUSDT';

// Toast is irrelevant to a pending render, but several of these surfaces import
// it at module scope.
vi.mock('sonner', () => ({
  toast: { success: () => undefined, error: () => undefined },
  Toaster: () => null,
}));

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/**
 * A fetch that never settles. Holding every request open is what pins the
 * surface in its pending branch deterministically, with no timer to race.
 */
const stallFetch = (): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => undefined)),
  );
};

/** Resolve the URLs a test needs loaded; every other request stays pending. */
const stallFetchExcept = (routes: readonly (readonly [RegExp, unknown])[]): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      for (const [pattern, body] of routes)
        if (pattern.test(url)) return Promise.resolve(json(body));
      return new Promise<Response>(() => undefined);
    }),
  );
};

const renderStalled = (ui: React.ReactNode, seed?: (client: QueryClient) => void): HTMLElement => {
  const queryClient = createQueryClient();
  seed?.(queryClient);
  const { container } = render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
  return container;
};

/**
 * Same, inside a throwaway router — for surfaces whose pending branch still
 * renders `<Link>` / calls `useNavigate`, which need router context to mount.
 * `extraPaths` register the link targets so hrefs resolve.
 */
const renderStalledInRouter = (
  component: () => React.JSX.Element,
  { path = '/', extraPaths = [] as readonly string[] } = {},
): HTMLElement => {
  const queryClient = createQueryClient();
  const root = createRootRoute();
  const children = [
    createRoute({ getParentRoute: () => root, path, component }),
    ...extraPaths.map((p) =>
      createRoute({ getParentRoute: () => root, path: p, component: () => null }),
    ),
  ];
  const router = createRouter({
    routeTree: root.addChildren(children),
    history: createMemoryHistory({ initialEntries: [path.replace(/\$\w+/g, 'x')] }),
  });
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return container;
};

/**
 * The three structural proxies for "this placeholder occupies the height the
 * loaded surface will".
 *
 * `statuses` counts the live regions that WRAP the placeholder bars, not every
 * `role="status"` on the surface. The bars are `aria-hidden`, so the invariant
 * is that a screen reader hears the load announced exactly once however many
 * bars are drawn — counting raw status elements instead would also count
 * unrelated permanent live regions a surface already owns (the Technicals panel
 * keeps one for refresh announcements in every state, loading or not).
 *
 * A leaf surface is 1. `0` means bare bars with no region of their own, for an
 * inline element inside a surface that already announces. Composite surfaces
 * that mount several independently-loading panels pass `'at-least-one'`; the
 * exactly-one rule is enforced by each leaf's own test below, and re-asserting
 * it on the composite would only pin how many panels happen to be in flight
 * together.
 */
const expectPendingHasHeight = (
  scope: HTMLElement,
  { statuses = 1 as number | 'at-least-one' } = {},
): void => {
  const bars = [...scope.querySelectorAll('[data-skeleton-bar]')];
  expect(bars.length).toBeGreaterThan(0);
  // `.sr-only` is excluded on purpose: a skeleton's own visually-hidden
  // announcement says "Loading" by design and occupies no layout. What must be
  // gone is the *visible* one-liner that stood in for the whole surface.
  expect(
    within(scope).queryAllByText(/^\s*Loading/i, { ignore: 'script, style, .sr-only' }),
  ).toHaveLength(0);

  // Bars with no enclosing region are silent by design (the inline pill), so
  // they are dropped rather than counted; what is pinned is how many distinct
  // regions announce this surface's load.
  const announcing = new Set(
    bars.map((bar) => bar.closest('[role="status"]')).filter((region) => region !== null),
  );
  if (statuses === 'at-least-one') expect(announcing.size).toBeGreaterThanOrEqual(1);
  else expect(announcing.size).toBe(statuses);
};

type AggregateRow = DashboardAggregateResponse['profiles'][number];

const aggregateRow = (overrides: Partial<AggregateRow> = {}): AggregateRow => ({
  profileId: PROFILE_ID,
  name: 'btc-bot',
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

beforeEach(() => {
  // Several surfaces log a react-query error on unmount while a request is
  // still open; the pending render is what is under test.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  stallFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('symbol panels', () => {
  it('SymbolBalancesPanel reserves the balances table while it loads', () => {
    const c = renderStalled(<SymbolBalancesPanel profileId={PROFILE_ID} symbol={SYMBOL} />);
    expectPendingHasHeight(c);
  });

  it('SymbolOrderBookPanel reserves the ladder while it loads', () => {
    const c = renderStalled(
      <SymbolOrderBookPanel profileId={PROFILE_ID} symbol={SYMBOL} lastPrice={null} />,
    );
    expectPendingHasHeight(c);
  });

  it('SymbolOrderHistoryPanel reserves the order list while it loads', () => {
    const c = renderStalled(<SymbolOrderHistoryPanel profileId={PROFILE_ID} symbol={SYMBOL} />);
    expectPendingHasHeight(c);
  });

  it('SymbolRecentTradesPanel reserves the tape while it loads', () => {
    const c = renderStalled(<SymbolRecentTradesPanel profileId={PROFILE_ID} symbol={SYMBOL} />);
    expectPendingHasHeight(c);
  });

  it('SymbolLogsPanel reserves the virtualised log feed while it loads', () => {
    const c = renderStalled(
      <SymbolLogsPanel profileId={PROFILE_ID} symbol={SYMBOL} liveFrame={null} />,
    );
    expectPendingHasHeight(c);
  });

  it('SymbolStatsStrip reserves the 24h strip while it loads', () => {
    const c = renderStalled(<SymbolStatsStrip profileId={PROFILE_ID} symbol={SYMBOL} />);
    expectPendingHasHeight(c);
  });

  it('SymbolTechnicalsPanel reserves the ratings table while it loads', () => {
    // The heading and empty-state are `<Link>`s, so the panel needs a router.
    const c = renderStalledInRouter(
      () => <SymbolTechnicalsPanel profileId={PROFILE_ID} symbol={SYMBOL} clock={() => 1_000} />,
      {
        path: '/profiles/$profileId/symbols/$symbol',
        extraPaths: ['/profiles/$profileId/config'],
      },
    );
    expectPendingHasHeight(c);
  });
});

describe('symbol workspace TRADE tab', () => {
  const view: StrategyView = {
    strategyName: 'trailing-trade',
    SignalPanel: () => <div data-testid="signal-panel" />,
  };

  const tradeTab = (overrides: {
    candlesLoading: boolean;
    stateLoading: boolean;
  }): React.JSX.Element => (
    <WorkspaceTradeTab
      profileId={PROFILE_ID}
      symbol={SYMBOL}
      candles={undefined}
      candlesError={null}
      overlays={{}}
      filterTickSize={null}
      interval="1h"
      onIntervalChange={() => undefined}
      state={undefined}
      currentPrice={null}
      view={view}
      operatorActions={new Set<string>()}
      onSymbolWiped={() => undefined}
      {...overrides}
    />
  );

  it('reserves the chart box while candles load', () => {
    const c = renderStalled(tradeTab({ candlesLoading: true, stateLoading: false }));
    expectPendingHasHeight(c, { statuses: 'at-least-one' });
  });

  it('reserves the strategy-state card while symbol state loads', () => {
    const c = renderStalled(tradeTab({ candlesLoading: false, stateLoading: true }));
    expectPendingHasHeight(c, { statuses: 'at-least-one' });
  });
});

describe('strategy preview', () => {
  it('keeps the Preview chrome and reserves the projection rows while loading', () => {
    const empty: PreviewModel = { sections: [] };
    const c = renderStalled(<PreviewModelView model={empty} currentPrice={null} isLoading />);
    // The panel must not vanish: its heading is the operator's anchor for where
    // the projection will land.
    expect(within(c).getByTestId('strategy-preview-panel')).toBeInTheDocument();
    expect(within(c).getByText('Preview')).toBeInTheDocument();
    expectPendingHasHeight(c);
  });
});

describe('profile surfaces', () => {
  it('RiskPanel keeps its panel chrome and reserves the form while loading', () => {
    const c = renderStalled(<RiskPanel profileId={PROFILE_ID} />);
    // Today the whole panel is replaced by one line of text; the title has to
    // survive the pending render or the section disappears mid-load.
    expect(within(c).getByText('Daily-loss circuit breaker')).toBeInTheDocument();
    expectPendingHasHeight(c);
  });

  it('DiscoveryDashboard reserves the scoreboard while it loads', () => {
    const c = renderStalled(<DiscoveryDashboard profileId={PROFILE_ID} />);
    expectPendingHasHeight(c);
  });

  it('ProfileConfigPanel keeps the Strategy panel while the config schema loads', () => {
    // Profile resolved, strategy registry still in flight — the branch that
    // today blanks the generated config form.
    const c = renderStalled(<ProfileConfigPanel profileId={PROFILE_ID} />, (client) => {
      client.setQueryData(profileQueryKey(PROFILE_ID), {
        id: PROFILE_ID,
        accountId: ACCOUNT_ID,
        name: 'btc-bot',
        strategyName: 'trailing-trade',
        strategyVersion: '2.0.0',
        config: {},
        enabled: true,
        binanceMode: 'live',
        baselineBacktestRunId: null,
      });
    });
    expect(within(c).getByTestId('profile-config-panel')).toBeInTheDocument();
    expect(within(c).getByText('Strategy')).toBeInTheDocument();
    expectPendingHasHeight(c, { statuses: 'at-least-one' });
  });

  it('RealisedPnlCard reserves the figure block while closed trades load', () => {
    const c = renderStalled(
      <RealisedPnlCard profileId={PROFILE_ID} period="d" onPeriodChange={() => undefined} />,
    );
    expectPendingHasHeight(c);
  });

  it('Step2Strategy reserves the strategy list while the registry loads', () => {
    const c = renderStalled(
      <Step2Strategy
        state={{ ...initialState, step: 2 }}
        dispatch={() => undefined}
        strategies={[]}
        loading
        error={null}
        onSubmit={async () => undefined}
      />,
    );
    expectPendingHasHeight(c);
  });
});

describe('dashboard surfaces', () => {
  it('MarketTrendCard keeps its heading and reserves the band while loading', () => {
    const c = renderStalled(<MarketTrendCard />);
    expect(within(c).getByTestId('market-trend-card')).toBeInTheDocument();
    expectPendingHasHeight(c);
  });

  it('LiveVsBacktestCard reserves the baseline comparison while it loads', () => {
    // A pinned baseline is what makes the comparison block render at all; with
    // it seeded, the baseline run request is the one left in flight.
    const c = renderStalled(<LiveVsBacktestCard profileId={PROFILE_ID} />, (client) => {
      client.setQueryData(profileQueryKey(PROFILE_ID), {
        id: PROFILE_ID,
        accountId: ACCOUNT_ID,
        name: 'btc-bot',
        strategyName: 'trailing-trade',
        strategyVersion: '2.0.0',
        config: {},
        enabled: true,
        binanceMode: 'live',
        baselineBacktestRunId: '00000000-0000-4000-8000-0000000000b1',
      });
    });
    expectPendingHasHeight(c);
  });

  it('ActivityFeed reserves the event list while it loads', () => {
    const c = renderStalled(<ActivityFeed rows={[aggregateRow()]} />);
    expectPendingHasHeight(c);
  });

  it('SymbolTable reserves the row block while the per-profile fan-out loads', () => {
    const c = renderStalledInRouter(() => <SymbolTable rows={[aggregateRow()]} />, {
      extraPaths: ['/accounts/$accountId/profiles/$profileId/symbols/$symbol'],
    });
    expectPendingHasHeight(c);
  });

  it('SymbolRail reserves the rail rows while the fan-out loads', () => {
    const c = renderStalledInRouter(
      () => <SymbolRail rows={[aggregateRow()]} selected={`${PROFILE_ID}:${SYMBOL}`} />,
      { extraPaths: ['/accounts/$accountId/profiles/$profileId/symbols/$symbol'] },
    );
    expectPendingHasHeight(c);
  });

  it('ScopedBalances reserves the balances card while the dashboard loads', () => {
    const c = renderStalled(<ScopedBalances profileId={PROFILE_ID} />);
    expectPendingHasHeight(c);
  });
});

describe('notifications', () => {
  it('reserves the provider list while it loads', () => {
    const c = renderStalled(<NotificationsPanel profileId={PROFILE_ID} />);
    expectPendingHasHeight(c, { statuses: 'at-least-one' });
  });

  it('reserves the provider config form while the saved config loads', () => {
    // Providers resolved, the per-provider GET still open — the branch that
    // gates the AutoForm so `defaultValues` is populated at mount.
    const c = renderStalled(<NotificationsPanel profileId={PROFILE_ID} />, (client) => {
      client.setQueryData(
        ['notify-providers', PROFILE_ID],
        [
          {
            name: 'slack',
            version: '1.0.0',
            displayName: 'Slack',
            secretFields: ['webhookUrl'],
            configSchema: { type: 'object', properties: { channel: { type: 'string' } } },
          },
        ],
      );
    });
    expect(within(c).getByText('Slack')).toBeInTheDocument();
    expectPendingHasHeight(c, { statuses: 'at-least-one' });
  });
});

describe('backtest surfaces', () => {
  // Minimal lightweight-charts stub: happy-dom has no canvas, so the real
  // module must never mount.
  const chartStub: ChartModule = {
    createChart: () => ({
      addSeries: () => ({
        setData: () => undefined,
        createPriceLine: () => ({}),
        removePriceLine: () => undefined,
      }),
      subscribeCrosshairMove: () => undefined,
      remove: () => undefined,
    }),
    CandlestickSeries: {},
    createSeriesMarkers: () => ({ setMarkers: () => undefined }),
  } as unknown as ChartModule;

  const result = {
    params: {
      symbols: [SYMBOL],
      fromMs: Date.parse('2026-01-01T00:00:00.000Z'),
      toMs: Date.parse('2026-02-01T00:00:00.000Z'),
      strategyInterval: '1h',
      detailInterval: '5m',
      initialQuoteBalance: '1000',
      fees: { makerBps: 10, takerBps: 10 },
      slippageBps: 5,
    },
    metrics: {},
    equityCurve: [],
    drawdownSeries: [],
    trades: [],
    perSymbol: [],
  } as unknown as BacktestResult;

  it('BacktestPriceCharts reserves the chart box while candles load', () => {
    const c = renderStalled(
      <BacktestPriceCharts
        result={result}
        profileId={PROFILE_ID}
        loadModule={() => Promise.resolve(chartStub)}
      />,
    );
    expectPendingHasHeight(c);
  });

  it('SymbolPicker reserves the symbol list while exchange info loads', async () => {
    // The searchable list lives behind the "Change" affordance, so the pending
    // branch is only reachable once the picker is opened.
    const c = renderStalled(<SymbolPicker value="BTCUSDT" onChange={() => undefined} />);
    await userEvent.click(within(c).getByRole('button', { name: 'Change' }));
    expectPendingHasHeight(c);
  });

  it('ConfigureTab reserves the config form while the profile and registry load', () => {
    // The workbench is a hook, so the tab is driven through a host that mounts
    // it; it calls `useNavigate`, hence the router.
    function Host(): React.JSX.Element {
      const wb = useBacktestWorkbench(PROFILE_ID, {});
      return <ConfigureTab wb={wb} />;
    }
    const c = renderStalledInRouter(() => <Host />);
    expectPendingHasHeight(c, { statuses: 'at-least-one' });
  });
});

describe('account surfaces', () => {
  it('the dust-transfer route reserves the balance list while it loads', async () => {
    stallFetchExcept([[/\/accounts$/, [{ id: ACCOUNT_ID, name: 'Main', binanceMode: 'test' }]]]);
    const queryClient = createQueryClient();
    queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
    queryClient.setQueryData(
      ['accounts'],
      [
        {
          id: ACCOUNT_ID,
          name: 'Main',
          binanceMode: 'test' as const,
          apiKeyConfigured: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    );
    const stub = (path: string) =>
      createRoute({ getParentRoute: () => rootRoute, path, component: () => null });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        stub('/'),
        stub('/onboarding'),
        stub('/login'),
        stub('/account'),
        accountScopeRoute.addChildren([dustTransferRoute]),
      ]),
      context: { queryClient },
      history: createMemoryHistory({
        initialEntries: [`/accounts/${ACCOUNT_ID}/dust-transfer?profileId=${PROFILE_ID}`],
      }),
    });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider
          router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
        />
      </QueryClientProvider>,
    );
    // The router resolves the account-scope beforeLoad before the page mounts.
    await screen.findByRole('heading', { name: 'Dust transfer' });
    expectPendingHasHeight(container, { statuses: 'at-least-one' });
  });
});

describe('technicals health pill', () => {
  it('renders bare skeleton bars with no announcement of its own', () => {
    // The pill is an inline element inside a larger surface that already owns a
    // `role="status"`; a second live region here would make a screen reader
    // announce the same load twice.
    const c = renderStalled(<TechnicalsHealthPill clock={() => 1_000} />);
    expectPendingHasHeight(c, { statuses: 0 });
    // The bar is `aria-hidden`, so this off-screen text is the pill's ONLY
    // accessible name. It has to be real text, not `aria-label`: ARIA
    // prohibits naming `role="generic"`, which is what a plain span exposes.
    expect(within(c).getByText('Technicals compute health loading')).toHaveClass('sr-only');
  });
});
