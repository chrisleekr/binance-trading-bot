import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the route's WebSocket frame handler so a test can drive a
// backtest-complete frame directly (no live socket in the test env).
const socketMock = vi.hoisted(() => ({ onMessage: null as ((f: unknown) => void) | null }));
vi.mock('@/features/profile/socket', () => ({
  useProfileSocketHandlers: (opts: { onMessage?: (f: unknown) => void }) => {
    socketMock.onMessage = opts.onMessage ?? null;
  },
}));

import { createQueryClient } from '@/shared/lib/query-client';
import { rootRoute } from '@/app/__root';
import { accountScopeRoute } from '@/features/account/routes/account-scope';

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const TEST_ACCOUNT = {
  id: ACCOUNT_ID,
  name: 'Main',
  binanceMode: 'test' as const,
  apiKeyConfigured: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};
import { profileDetailRoute } from '@/features/profile/routes/profiles.$profileId';
import { backtestRoute } from '@/features/backtest/routes/profiles.$profileId.backtest';
import {
  __resetAreaChartLoader,
  __setAreaChartLoader,
  type AreaChartModule,
} from '@/features/backtest/components/equity-area-chart';

// The route renders the equity/drawdown charts deep in the tree with their
// default loader; inject a stub so the real lightweight-charts (and happy-dom's
// missing canvas) never mounts. Without this the run emits an unhandled
// "Failed to parse color" that fails the suite locally.
const areaStub: AreaChartModule = {
  createChart: () => ({
    addSeries: () => ({ setData: () => undefined }),
    timeScale: () => ({ fitContent: () => undefined }),
    remove: () => undefined,
  }),
  AreaSeries: {},
};

// Minimal config schema the API would ship. The route strips `symbol` (the
// picker owns it) and seeds the rest from the profile config.
const configSchema = {
  type: 'object' as const,
  properties: {
    symbol: { type: 'string', minLength: 1 },
    buy: {
      type: 'object',
      properties: { maxPurchaseAmount: { type: 'string' } },
    },
    sell: {
      type: 'object',
      properties: { stopLossPercentage: { type: 'string' } },
    },
  },
  required: ['symbol'],
};

const sampleProfile = {
  id: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000010',
  name: 'BTC bot',
  strategyName: 'trailing-trade',
  strategyVersion: '2.0.0',
  config: {
    symbol: 'BTCUSDT',
    buy: { maxPurchaseAmount: '10' },
    sell: { stopLossPercentage: '5' },
  },
  enabled: true,
  binanceMode: 'live' as const,
  quoteAsset: 'USDT',
  createdAt: '2026-05-10T05:00:00.000Z',
  updatedAt: '2026-05-10T05:00:00.000Z',
};

const sampleStrategies = [
  {
    name: 'trailing-trade',
    version: '2.0.0',
    displayName: 'Trailing Trade',
    description: 'Trailing grid strategy',
    configSchema,
    overrideConfigSchema: configSchema,
    defaultConfig: {
      symbol: 'BTCUSDT',
      buy: { maxPurchaseAmount: '10' },
      sell: { stopLossPercentage: '5' },
    },
    operatorActions: [],
  },
];

const exchangeInfo = { symbols: [], fetchedAt: '2026-05-10T05:00:00.000Z' };

// The picker seeds its default from the profile dashboard, preferring a held
// position. ETHUSDT is listed first but flat; BTCUSDT carries a position, so it
// wins the seed — this exercises the `quantity > 0` ranking the route applies.
const sampleDashboard = {
  profileId: sampleProfile.id,
  enabled: true,
  binanceMode: 'live' as const,
  balances: [],
  totalProfit: '0',
  enabledNotifierCount: 0,
  symbols: [
    {
      symbol: 'ETHUSDT',
      enabled: true,
      avgEntryPrice: null,
      currentPrice: null,
      quantity: null,
      openOrderCount: 0,
      openOrders: [],
    },
    {
      symbol: 'BTCUSDT',
      enabled: true,
      avgEntryPrice: '100',
      currentPrice: '110',
      quantity: '0.5',
      openOrderCount: 0,
      openOrders: [],
    },
  ],
  cachedAt: '2026-05-10T05:00:00.000Z',
};

const doneResult = (override?: Record<string, unknown>) => ({
  params: {
    symbols: ['BTCUSDT'],
    fromMs: 1,
    toMs: 2,
    strategyInterval: '1h',
    detailInterval: '5m',
    initialQuoteBalance: '1000',
    fees: { makerBps: 10, takerBps: 10 },
    slippageBps: 5,
    ...(override ? { strategyConfigOverride: override } : {}),
  },
  metrics: {
    startingBalance: '1000',
    finalBalance: '1123',
    absoluteProfit: '123',
    totalReturnPct: 12.34,
    cagrPct: 0,
    marketChangePct: 0,
    dcaChangePct: 0,
    alphaVsHoldPct: 0,
    alphaVsDcaPct: 0,
    sharpe: 0,
    sortino: 0,
    calmar: 0,
    sqn: 0,
    maxDrawdownPct: 0,
    absoluteDrawdown: '0',
    drawdownStartMs: null,
    drawdownEndMs: null,
    totalTrades: 0,
    winRate: 0,
    wins: 0,
    losses: 0,
    profitFactor: null,
    expectancy: '0',
    bestTradePct: null,
    worstTradePct: null,
    avgTradePnl: '0',
    avgTradeDurationMs: null,
  },
  equityCurve: [],
  drawdownSeries: [],
  trades: [],
  roundTrips: [],
  perSymbol: [],
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// The runs list endpoint replies with a paginated `{items,nextCursor,total}`
// envelope. Inject the window fields + total so fixtures that predate the C3/C4
// schema fields still parse; an item may override the default window.
const runsList = (
  items: unknown[],
  nextCursor: string | null = null,
  total: number = items.length,
): Response =>
  json({
    items: items.map((it) => ({
      fromMs: 1_700_000_000_000,
      toMs: 1_700_600_000_000,
      ...(it as Record<string, unknown>),
    })),
    nextCursor,
    total,
  });

const stub = (path: string) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => null });

const setUp = (
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
  initialEntry = `/accounts/${ACCOUNT_ID}/profiles/p1/backtest`,
) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
  queryClient.setQueryData(['accounts'], [TEST_ACCOUNT]);
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      stub('/'),
      stub('/onboarding'),
      stub('/login'),
      accountScopeRoute.addChildren([profileDetailRoute.addChildren([backtestRoute])]),
    ]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return { fetchMock, router };
};

// Shared responder for the form's standing dependencies (profile, strategies,
// exchangeInfo). Tests layer their backtest-specific routes on top.
const base = (url: string): Response | null => {
  if (url.endsWith('/profiles/p1/dashboard')) return json(sampleDashboard);
  if (url.endsWith('/profiles/p1')) return json(sampleProfile);
  if (url.endsWith('/strategies')) return json(sampleStrategies);
  if (url.endsWith('/exchange-info')) return json(exchangeInfo);
  // The advisor panel polls its saved variants on mount for any anchored run;
  // serve an empty list so that background query never 404s the responder.
  if (url.endsWith('/advisor')) return json({ results: [] });
  return null;
};

// A basket (rebalance) strategy: no top-level `symbol`; the symbols live in a
// weighted `targets` array. The route hides the picker and derives the run's
// symbols from this config.
const rebalanceConfigSchema = {
  type: 'object' as const,
  properties: {
    enabled: { type: 'boolean' },
    candleInterval: { type: 'string', enum: ['1h'] },
    targets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          symbol: { type: 'string', minLength: 1 },
          weight: { type: 'string' },
        },
        required: ['symbol', 'weight'],
      },
    },
  },
};

const rebalanceStrategies = [
  {
    name: 'rebalance',
    version: '1.0.0',
    displayName: 'Rebalance',
    description: 'Fixed-weight basket',
    configSchema: rebalanceConfigSchema,
    overrideConfigSchema: rebalanceConfigSchema,
    defaultConfig: { enabled: false, candleInterval: '1h', targets: [] },
    operatorActions: [],
  },
];

const rebalanceProfile = (targets: { symbol: string; weight: string }[]) => ({
  ...sampleProfile,
  name: 'Basket bot',
  strategyName: 'rebalance',
  strategyVersion: '1.0.0',
  config: { enabled: false, candleInterval: '1h', targets },
});

// Standing dependencies for a rebalance profile, mirroring `base` but serving
// the basket strategy + the given profile.
const rebalanceBase =
  (profile: ReturnType<typeof rebalanceProfile>) =>
  (url: string): Response | null => {
    if (url.endsWith('/profiles/p1/dashboard')) return json(sampleDashboard);
    if (url.endsWith('/profiles/p1')) return json(profile);
    if (url.endsWith('/strategies')) return json(rebalanceStrategies);
    if (url.endsWith('/exchange-info')) return json(exchangeInfo);
    if (url.endsWith('/advisor')) return json({ results: [] });
    return null;
  };

beforeEach(() => __setAreaChartLoader(() => Promise.resolve(areaStub)));

afterEach(() => {
  __resetAreaChartLoader();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('/profiles/$profileId/backtest', () => {
  it('renders the form, prefills the profile symbol, and shows an empty runs list', async () => {
    setUp((url) => {
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests')) return runsList([]);
      return new Response('not found', { status: 404 });
    });
    await waitFor(() => expect(screen.getByText('Run backtest')).toBeInTheDocument());
    expect(screen.getByText('Strategy config')).toBeInTheDocument();
    // The symbol picker is seeded from the profile config asynchronously, so
    // await it rather than asserting synchronously (avoids a render race).
    expect(await screen.findByText('BTCUSDT')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('No runs yet.')).toBeInTheDocument());
    // Every strategy renders the generic "what will happen" preview in the
    // form's aside, resolved through its lazy PreviewModel module.
    expect(await screen.findByTestId('strategy-preview-panel')).toBeInTheDocument();
  });

  it('?autorun=1 launches a run on the current config exactly once and clears the param', async () => {
    // "Backtest this config" hands the operator straight into a running
    // backtest instead of a form they must re-submit. The launch is a side
    // effect of a search param, so it must be idempotent: the app's global
    // MutationCache invalidate re-renders this tree on every settled mutation,
    // and a naive effect would fire a second POST off that re-render. Clearing
    // the param is what makes the launch a one-shot rather than a standing
    // instruction that re-fires on reload.
    const RUN_ID = 'e1111111-1111-4111-8111-111111111111';
    let posts = 0;
    const { router } = setUp((url, init) => {
      const b = base(url);
      if (b) return b;
      const method = init?.method ?? 'GET';
      if (url.includes('/backtests') && !url.includes(`/${RUN_ID}`) && method === 'POST') {
        posts += 1;
        return json({ runId: RUN_ID }, 202);
      }
      if (url.endsWith('/backtests') && method === 'GET') return runsList([]);
      if (url.includes(`/backtests/${RUN_ID}`)) return json(runDetailBody(RUN_ID, 'running'));
      return new Response('not found', { status: 404 });
    }, `/accounts/${ACCOUNT_ID}/profiles/p1/backtest?autorun=1`);

    // The run starts with no interaction at all.
    await waitFor(() => expect(posts).toBe(1));
    await waitFor(() => {
      const search = router.state.location.search as Record<string, unknown>;
      expect(search['autorun']).toBeUndefined();
    });
    // Settle: no second launch once the tree has re-rendered around the run.
    await screen.findByRole('progressbar');
    expect(posts).toBe(1);
  });

  it('shows the "Configure a backtest" heading when there is no run to adjust', async () => {
    // No past runs and no ?run= deep-link, so nothing auto-anchors: activeRunId
    // stays null and the config section heading is the empty-state copy.
    setUp((url) => {
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests')) return runsList([]);
      return new Response('not found', { status: 404 });
    });
    expect(
      await screen.findByRole('heading', { name: 'Configure a backtest' }),
    ).toBeInTheDocument();
  });

  it('shows an honest profile-load error, not a missing-schema message, when the profile fails to load (#575)', async () => {
    // A profile that fails response validation returns non-2xx, so profile.data is
    // undefined and strategyKey collapses to "". The config section must blame the
    // failed load, not misreport it as a missing strategy schema with an empty name.
    setUp((url) => {
      if (url.endsWith('/profiles/p1/dashboard')) return json(sampleDashboard);
      if (url.endsWith('/profiles/p1'))
        return json({ error: { code: 'VALIDATION_FAILED', message: 'invalid' } }, 422);
      if (url.endsWith('/strategies')) return json(sampleStrategies);
      if (url.endsWith('/exchange-info')) return json(exchangeInfo);
      if (url.endsWith('/advisor')) return json({ results: [] });
      if (url.endsWith('/backtests')) return runsList([]);
      return new Response('not found', { status: 404 });
    });
    expect(await screen.findByText("Couldn't load this profile")).toBeInTheDocument();
    expect(screen.queryByText(/No config schema for strategy/)).not.toBeInTheDocument();
  });

  it('seeds the cost model from the profile’s configured fees', async () => {
    // A profile that carries live fees in its config should pre-fill the
    // backtest cost model so the run measures the same round-trip cost as live,
    // instead of the generic 10/10 default.
    const profileWithFees = {
      ...sampleProfile,
      config: { ...sampleProfile.config, fees: { makerBps: '7.5', takerBps: '7.5' } },
    };
    setUp((url) => {
      if (url.endsWith('/profiles/p1/dashboard')) return json(sampleDashboard);
      if (url.endsWith('/profiles/p1')) return json(profileWithFees);
      if (url.endsWith('/strategies')) return json(sampleStrategies);
      if (url.endsWith('/exchange-info')) return json(exchangeInfo);
      if (url.endsWith('/backtests')) return runsList([]);
      return new Response('not found', { status: 404 });
    });
    await waitFor(() => expect(screen.getByText('Run backtest')).toBeInTheDocument());
    const maker = (await screen.findByLabelText('Maker fee (bps)')) as HTMLInputElement;
    const taker = screen.getByLabelText('Taker fee (bps)') as HTMLInputElement;
    await waitFor(() => expect(maker.value).toBe('7.5'));
    expect(taker.value).toBe('7.5');
  });

  it('seeds the held-position symbol, not the first-listed flat symbol', async () => {
    setUp((url) => {
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests')) return runsList([]);
      return new Response('not found', { status: 404 });
    });
    await waitFor(() => expect(screen.getByText('Run backtest')).toBeInTheDocument());
    // ETHUSDT is listed first but flat; the held BTCUSDT wins the seed. The flat
    // symbol is not pre-selected (the picker only renders the seeded symbol since
    // exchange-info ships no options in this test).
    expect(await screen.findByText('BTCUSDT')).toBeInTheDocument();
    expect(screen.queryByText('ETHUSDT')).not.toBeInTheDocument();
  });

  it('submits the prefilled symbol + edited config as an override', async () => {
    let postBody: unknown;
    const RUN_ID = '11111111-1111-4111-8111-111111111111';
    setUp((url, init) => {
      const b = base(url);
      if (b) return b;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/backtests') && method === 'POST') {
        postBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return json({ runId: RUN_ID }, 202);
      }
      if (url.endsWith('/backtests') && method === 'GET') return runsList([]);
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json({
          runId: RUN_ID,
          profileId: sampleProfile.id,
          params: doneResult().params,
          status: 'running',
          progress: 30,
          error: null,
          createdAt: '2026-05-10T05:00:00.000Z',
          startedAt: '2026-05-10T05:00:01.000Z',
          finishedAt: null,
          result: null,
        });
      }
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Run backtest')).toBeInTheDocument());
    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), '2026-01-01T00:00');
    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), '2026-02-01T00:00');
    await user.click(screen.getByText('Run backtest'));

    await waitFor(() => expect(screen.getByRole('progressbar')).toBeInTheDocument());
    const body = postBody as {
      symbols: string[];
      strategyInterval: string;
      fromMs: number;
      strategyConfigOverride: { symbol: string };
    };
    expect(body.symbols).toEqual(['BTCUSDT']);
    expect(body.strategyInterval).toBe('1h');
    expect(Number.isNaN(body.fromMs)).toBe(false);
    // The override carries the edited config with the picked symbol folded in.
    expect(body.strategyConfigOverride.symbol).toBe('BTCUSDT');
  });

  it('shows the live phase label and candle counter while a run replays (#534)', async () => {
    const RUN_ID = '11111111-1111-4111-8111-111111111111';
    setUp((url, init) => {
      const b = base(url);
      if (b) return b;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/backtests') && method === 'POST') return json({ runId: RUN_ID }, 202);
      if (url.endsWith('/backtests') && method === 'GET') return runsList([]);
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json({
          runId: RUN_ID,
          profileId: sampleProfile.id,
          params: doneResult().params,
          status: 'running',
          progress: 30,
          progressDetail: { phase: 'replay', processed: 300, total: 1000 },
          error: null,
          createdAt: '2026-05-10T05:00:00.000Z',
          startedAt: '2026-05-10T05:00:01.000Z',
          finishedAt: null,
          result: null,
        });
      }
      return new Response('not found', { status: 404 });
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Run backtest')).toBeInTheDocument());
    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), '2026-01-01T00:00');
    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), '2026-02-01T00:00');
    await user.click(screen.getByText('Run backtest'));
    const detail = await screen.findByTestId('bt-progress-detail');
    expect(detail).toHaveTextContent('Replaying strategy');
    expect(detail).toHaveTextContent('candle 300 of 1,000');
  });

  it('refetches the run when a backtest-complete frame arrives for the active run', async () => {
    const RUN_ID = '11111111-1111-4111-8111-111111111111';
    let detailFetches = 0;
    setUp((url, init) => {
      const b = base(url);
      if (b) return b;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/backtests') && method === 'POST') return json({ runId: RUN_ID }, 202);
      if (url.endsWith('/backtests') && method === 'GET') return runsList([]);
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        detailFetches += 1;
        return json({
          runId: RUN_ID,
          profileId: sampleProfile.id,
          params: doneResult().params,
          status: 'running',
          progress: 50,
          progressDetail: { phase: 'replay', processed: 5, total: 10 },
          error: null,
          createdAt: '2026-05-10T05:00:00.000Z',
          startedAt: '2026-05-10T05:00:01.000Z',
          finishedAt: null,
          result: null,
        });
      }
      return new Response('not found', { status: 404 });
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Run backtest')).toBeInTheDocument());
    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), '2026-01-01T00:00');
    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), '2026-02-01T00:00');
    await user.click(screen.getByText('Run backtest'));
    await screen.findByTestId('bt-progress-detail');
    const before = detailFetches;
    // The worker's completion push must invalidate the run query immediately —
    // faster than the 1.5s poll, so an increase within the default waitFor window
    // is attributable to the handler, not the interval.
    act(() => socketMock.onMessage?.({ topic: 'backtest-complete', payload: { runId: RUN_ID } }));
    await waitFor(() => expect(detailFetches).toBeGreaterThan(before));
  });

  it('shows the warm-up phase label without a candle counter (#334)', async () => {
    const RUN_ID = '11111111-1111-4111-8111-111111111111';
    setUp((url, init) => {
      const b = base(url);
      if (b) return b;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/backtests') && method === 'POST') return json({ runId: RUN_ID }, 202);
      if (url.endsWith('/backtests') && method === 'GET') return runsList([]);
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json({
          runId: RUN_ID,
          profileId: sampleProfile.id,
          params: doneResult().params,
          status: 'running',
          progress: 0,
          progressDetail: { phase: 'warmup' },
          error: null,
          createdAt: '2026-05-10T05:00:00.000Z',
          startedAt: '2026-05-10T05:00:01.000Z',
          finishedAt: null,
          result: null,
        });
      }
      return new Response('not found', { status: 404 });
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Run backtest')).toBeInTheDocument());
    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), '2026-01-01T00:00');
    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), '2026-02-01T00:00');
    await user.click(screen.getByText('Run backtest'));
    const detail = await screen.findByTestId('bt-progress-detail');
    expect(detail).toHaveTextContent('Warming up indicators');
    expect(detail).not.toHaveTextContent('candle');
  });

  it('reveals the reset-to-live button only after the config form drifts, then reverts it', async () => {
    let posted = false;
    setUp((url, init) => {
      const b = base(url);
      if (b) return b;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/backtests') && method === 'POST') {
        posted = true;
        return json({ runId: '66666666-6666-4666-8666-666666666666' }, 202);
      }
      if (url.endsWith('/backtests') && method === 'GET') return runsList([]);
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Run backtest')).toBeInTheDocument());
    // The form is seeded from the live config, so it starts clean — no affordance.
    expect(screen.queryByTestId('backtest-reset-live')).not.toBeInTheDocument();

    // Editing a config field drifts the form from the live config (fireEvent so
    // the edit does not depend on the group's collapsed/expanded state).
    const field = screen.getByLabelText('Max Purchase Amount');
    fireEvent.change(field, { target: { value: '99' } });
    const reset = await screen.findByTestId('backtest-reset-live');

    // Resetting reseeds the live config, hides the affordance again, and posts
    // nothing (it restores the form, it does not run a backtest).
    await user.click(reset);
    await waitFor(() =>
      expect(screen.queryByTestId('backtest-reset-live')).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Max Purchase Amount')).toHaveValue('10');
    expect(posted).toBe(false);
  });

  it('shows the headline and a full bar when a run is done', async () => {
    const RUN_ID = '22222222-2222-4222-8222-222222222222';
    setUp((url, init) => {
      const b = base(url);
      if (b) return b;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/backtests') && method === 'POST') return json({ runId: RUN_ID }, 202);
      if (url.endsWith('/backtests') && method === 'GET') return runsList([]);
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json({
          runId: RUN_ID,
          profileId: sampleProfile.id,
          params: doneResult().params,
          status: 'done',
          progress: 100,
          error: null,
          createdAt: '2026-05-10T05:00:00.000Z',
          startedAt: '2026-05-10T05:00:01.000Z',
          finishedAt: '2026-05-10T05:05:00.000Z',
          result: doneResult(),
        });
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Run backtest')).toBeInTheDocument());
    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), '2026-01-01T00:00');
    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), '2026-02-01T00:00');
    await user.click(screen.getByText('Run backtest'));

    await waitFor(() => expect(screen.getByText('12.34%')).toBeInTheDocument());
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('blocks submit with a friendly message when dates are missing', async () => {
    setUp((url) => {
      const b = base(url);
      if (b) return b;
      return url.endsWith('/backtests') ? runsList([]) : new Response('nf', { status: 404 });
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Run backtest')).toBeInTheDocument());
    // #669 seeds a year-long window on the bare Configure landing; clear both dates
    // so the missing-dates guard is what's exercised here.
    await user.clear(screen.getByLabelText('From'));
    await user.clear(screen.getByLabelText('To'));
    await user.click(screen.getByText('Run backtest'));
    await waitFor(() => expect(screen.getByText('Pick a From and To date.')).toBeInTheDocument());
  });

  it('blocks submit when the detail interval is coarser than the strategy interval', async () => {
    let posted = false;
    setUp((url, init) => {
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests') && (init?.method ?? 'GET') === 'POST') posted = true;
      return url.endsWith('/backtests') ? runsList([]) : new Response('nf', { status: 404 });
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Run backtest')).toBeInTheDocument());
    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), '2026-01-01T00:00');
    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), '2026-02-01T00:00');
    // The decision interval is the config's candleInterval ('1h' here); a detail
    // interval coarser than it ('1d') must block the run. The standalone strategy-
    // interval field was removed (#578); the constraint now names the Candle Interval.
    await user.selectOptions(screen.getByLabelText('Detail interval'), '1d');
    await user.click(screen.getByText('Run backtest'));
    await waitFor(() =>
      expect(
        screen.getByText(/Detail interval must be the same as or finer than your Candle Interval/),
      ).toBeInTheDocument(),
    );
    expect(posted).toBe(false);
  });

  it('clamps the seeded 5m detail interval down to a finer strategy interval so a fresh form is runnable', async () => {
    // A strategy whose candleInterval is finer than the fixed 5m default (here 1m)
    // must not seed the form blocked: the detail interval clamps to the decision
    // interval so Run is enabled without a manual fix, while an explicit coarser
    // pick still surfaces the error (covered by the test above).
    const fineSchema = {
      ...rebalanceConfigSchema,
      properties: {
        ...rebalanceConfigSchema.properties,
        candleInterval: { type: 'string', enum: ['1m'] },
      },
    };
    const fineStrategies = [
      {
        ...rebalanceStrategies[0],
        configSchema: fineSchema,
        overrideConfigSchema: fineSchema,
        defaultConfig: { enabled: false, candleInterval: '1m', targets: [] },
      },
    ];
    const fineProfile = {
      ...rebalanceProfile([{ symbol: 'BTCUSDT', weight: '1' }]),
      config: {
        enabled: false,
        candleInterval: '1m',
        targets: [{ symbol: 'BTCUSDT', weight: '1' }],
      },
    };
    setUp((url) => {
      if (url.endsWith('/profiles/p1/dashboard')) return json(sampleDashboard);
      if (url.endsWith('/profiles/p1')) return json(fineProfile);
      if (url.endsWith('/strategies')) return json(fineStrategies);
      if (url.endsWith('/exchange-info')) return json(exchangeInfo);
      if (url.endsWith('/backtests')) return runsList([]);
      return new Response('nf', { status: 404 });
    });
    await waitFor(() => expect(screen.getByText('Run backtest')).toBeInTheDocument());
    // Decision interval is 1m (from the config's candleInterval); the 5m default
    // detail interval clamps down to 1m so the run is not seeded blocked.
    await waitFor(() => expect(screen.getByLabelText('Detail interval')).toHaveValue('1m'));
    expect(
      screen.queryByText(/Detail interval must be the same as or finer than your Candle Interval/),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run backtest' })).not.toBeDisabled();
  });

  it('sends the strategy interval from the config candleInterval (parity)', async () => {
    // A strategy that owns `candleInterval` (here rebalance) drives the run's
    // interval from that field — the same field live keys off — so the standalone
    // strategy-interval control is gone (#578) and the POSTed strategyInterval
    // always equals the config's candleInterval. This is what prevents the run
    // from streaming an interval the strategy never reads.
    let postBody: { strategyInterval?: string } | undefined;
    const profile = rebalanceProfile([
      { symbol: 'BTCUSDT', weight: '0.5' },
      { symbol: 'ETHUSDT', weight: '0.5' },
    ]);
    setUp((url, init) => {
      const b = rebalanceBase(profile)(url);
      if (b) return b;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/backtests') && method === 'POST') {
        postBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return json({ runId: '55555555-5555-4555-8555-555555555555' }, 202);
      }
      return url.endsWith('/backtests') ? runsList([]) : new Response('nf', { status: 404 });
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Run backtest')).toBeInTheDocument());

    // The standalone strategy-interval control is gone; the POSTed interval is
    // derived from the config's candleInterval, asserted below.
    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), '2026-01-01T00:00');
    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), '2026-02-01T00:00');
    await user.click(screen.getByText('Run backtest'));
    await waitFor(() => expect(postBody).toBeDefined());
    expect(postBody?.strategyInterval).toBe('1h');
  });

  it('hides the picker for a basket strategy and derives symbols from the config targets', async () => {
    let postBody: unknown;
    const RUN_ID = '44444444-4444-4444-8444-444444444444';
    const profile = rebalanceProfile([
      { symbol: 'BTCUSDT', weight: '0.5' },
      { symbol: 'ETHUSDT', weight: '0.5' },
    ]);
    setUp((url, init) => {
      const b = rebalanceBase(profile)(url);
      if (b) return b;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/backtests') && method === 'POST') {
        postBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return json({ runId: RUN_ID }, 202);
      }
      if (url.endsWith('/backtests') && method === 'GET') return runsList([]);
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json({
          runId: RUN_ID,
          profileId: sampleProfile.id,
          params: doneResult().params,
          status: 'running',
          progress: 30,
          error: null,
          createdAt: '2026-05-10T05:00:00.000Z',
          startedAt: '2026-05-10T05:00:01.000Z',
          finishedAt: null,
          result: null,
        });
      }
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Run backtest')).toBeInTheDocument());
    // No single-symbol picker (its value span is gone); a basket note points at
    // the config instead. `getByLabelText('Symbol')` can't disambiguate here —
    // the AutoForm targets rows label each symbol field "Symbol" too — so assert
    // on the picker's unique value-span id.
    expect(screen.getByTestId('backtest-basket-note')).toBeInTheDocument();
    expect(document.getElementById('bt-symbol')).toBeNull();
    // A basket strategy (rebalance) still renders the generic preview panel
    // (its allocation table), resolved through its lazy PreviewModel module.
    expect(await screen.findByTestId('strategy-preview-panel')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), '2026-01-01T00:00');
    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), '2026-02-01T00:00');
    await user.click(screen.getByText('Run backtest'));

    await waitFor(() => expect(screen.getByRole('progressbar')).toBeInTheDocument());
    const body = postBody as {
      symbols: string[];
      strategyConfigOverride: { symbol?: string; targets?: unknown[] };
    };
    // Both basket symbols are loaded, and no single `symbol` is folded in.
    expect(body.symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(body.strategyConfigOverride.symbol).toBeUndefined();
    expect(body.strategyConfigOverride.targets).toHaveLength(2);
  });

  it('blocks a basket submit with fewer than two symbols', async () => {
    let posted = false;
    const profile = rebalanceProfile([{ symbol: 'BTCUSDT', weight: '1' }]);
    setUp((url, init) => {
      const b = rebalanceBase(profile)(url);
      if (b) return b;
      if (url.endsWith('/backtests') && (init?.method ?? 'GET') === 'POST') posted = true;
      return url.endsWith('/backtests') ? runsList([]) : new Response('nf', { status: 404 });
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Run backtest')).toBeInTheDocument());
    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), '2026-01-01T00:00');
    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), '2026-02-01T00:00');
    await user.click(screen.getByText('Run backtest'));
    await waitFor(() =>
      expect(
        screen.getByText('Add at least two symbols to the basket under Strategy config.'),
      ).toBeInTheDocument(),
    );
    expect(posted).toBe(false);
  });

  it('auto-anchors to the most-recent run and shows its result on load when there is no ?run=', async () => {
    // With no `?run=` deep link, the route must still surface the latest run's
    // result on load — anchoring to the most-recent past run rather than showing
    // nothing until the operator launches or clicks one.
    const RUN_ID = 'b1111111-1111-4111-8111-111111111111';
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests') && method === 'GET') {
        return runsList([listRow(RUN_ID, 'done')]);
      }
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json(runDetailBody(RUN_ID, 'done', { result: doneResult() }));
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    // No user interaction: the result panel must appear from the auto-anchor
    // alone. The "Run <id> — done" heading and the full progress bar live only
    // in the active-run results panel, never in a Past-runs row, so they are
    // unambiguous evidence the run's RESULT rendered (not just a list row).
    expect(await screen.findByText(`Run ${RUN_ID.slice(0, 8)} — done`)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    // A run is active, so the config section shows its active-branch heading
    // (the empty-state "Configure a backtest" branch is covered elsewhere).
    expect(screen.getByRole('heading', { name: 'Adjust & re-run' })).toBeInTheDocument();
  });

  it('stays on Configure with ?view=configure and does not auto-anchor a past run (#619)', async () => {
    // "Run backtest on current config" links here with ?view=configure so the
    // operator lands on the live-config form. A newest past run exists, but the
    // explicit Configure view must suppress the auto-anchor that would otherwise
    // redirect to that run's Results (the reported bug).
    const RUN_ID = 'd1111111-1111-4111-8111-111111111111';
    const { router } = setUp((url, init) => {
      const method = init?.method ?? 'GET';
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests') && method === 'GET') {
        return runsList([listRow(RUN_ID, 'done')]);
      }
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json(runDetailBody(RUN_ID, 'done', { result: doneResult() }));
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    }, `/accounts/${ACCOUNT_ID}/profiles/p1/backtest?view=configure`);

    // The empty-state config heading proves no run anchored; the anchored-run
    // result heading must be absent.
    expect(
      await screen.findByRole('heading', { name: 'Configure a backtest' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(`Run ${RUN_ID.slice(0, 8)} — done`)).toBeNull();
    // The URL was not rewritten to the anchored run's Results.
    const search = router.state.location.search as Record<string, unknown>;
    expect(search.view).toBe('configure');
    expect(search.run).toBeUndefined();
  });

  it('stays on History with ?view=history and does not auto-anchor a past run (#619)', async () => {
    // An explicit non-Results view is the operator's choice; the auto-anchor must
    // not hijack it to Results (regression guard for the configure→history path).
    const RUN_ID = 'e1111111-1111-4111-8111-111111111111';
    const { router } = setUp((url, init) => {
      const method = init?.method ?? 'GET';
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests') && method === 'GET') {
        return runsList([listRow(RUN_ID, 'done')]);
      }
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json(runDetailBody(RUN_ID, 'done', { result: doneResult() }));
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    }, `/accounts/${ACCOUNT_ID}/profiles/p1/backtest?view=history`);

    // The History list row renders, but the anchored-run result heading must not,
    // and the URL must not be rewritten to the run's Results.
    await screen.findByRole('tab', { name: 'History', selected: true });
    expect(screen.queryByText(`Run ${RUN_ID.slice(0, 8)} — done`)).toBeNull();
    const search = router.state.location.search as Record<string, unknown>;
    expect(search.view).toBe('history');
    expect(search.run).toBeUndefined();
  });

  it('seeds the config form from the anchored run’s resolvedConfig, not the live config (#547 C1)', async () => {
    // The auto-anchored run's effective (resolved) config carries
    // maxPurchaseAmount 25, while the live profile config is 10. The "Adjust &
    // re-run" Draft must seed from the anchored run's resolvedConfig so the
    // operator edits the config that run actually executed, not the live one.
    const RUN_ID = 'c1111111-1111-4111-8111-111111111111';
    const resolved = {
      symbol: 'BTCUSDT',
      buy: { maxPurchaseAmount: '25' },
      sell: { stopLossPercentage: '5' },
    };
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests') && method === 'GET') {
        return runsList([listRow(RUN_ID, 'done')]);
      }
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        // doneResult() carries NO strategyConfigOverride, so the only source of
        // the 25 value is resolvedConfig: a merge of live+override would yield 10.
        return json(
          runDetailBody(RUN_ID, 'done', { result: { ...doneResult(), resolvedConfig: resolved } }),
        );
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    // No user interaction: the auto-anchor alone must seed the form.
    expect(await screen.findByRole('heading', { name: 'Adjust & re-run' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Max Purchase Amount')).toHaveValue('25'));
  });

  it('after auto-anchor, offers reset-to-live when the run config drifts from live', async () => {
    // The anchored run's resolved config differs from the live config (25 vs 10),
    // so the Draft is seeded from the run and the reset-to-live affordance shows.
    const RUN_ID = 'c2222222-2222-4222-8222-222222222222';
    const resolved = {
      symbol: 'BTCUSDT',
      buy: { maxPurchaseAmount: '25' },
      sell: { stopLossPercentage: '5' },
    };
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests') && method === 'GET') {
        return runsList([listRow(RUN_ID, 'done')]);
      }
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json(
          runDetailBody(RUN_ID, 'done', { result: { ...doneResult(), resolvedConfig: resolved } }),
        );
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    expect(await screen.findByTestId('backtest-reset-live')).toBeInTheDocument();
  });

  it('after auto-anchor, hides reset-to-live when the run config equals live (no drift)', async () => {
    // A no-override run whose resolved config equals the live config must NOT seed
    // a drifted Draft: the reset-to-live affordance stays hidden (a #534 regression
    // guard for the auto-anchor seed).
    const RUN_ID = 'c3333333-3333-4333-8333-333333333333';
    const resolved = {
      symbol: 'BTCUSDT',
      buy: { maxPurchaseAmount: '10' },
      sell: { stopLossPercentage: '5' },
    };
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests') && method === 'GET') {
        return runsList([listRow(RUN_ID, 'done')]);
      }
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json(
          runDetailBody(RUN_ID, 'done', { result: { ...doneResult(), resolvedConfig: resolved } }),
        );
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    // Wait for the run's result to anchor (so the seed effect has run), then assert
    // the form stayed on the live config with no reset affordance.
    expect(await screen.findByText(`Run ${RUN_ID.slice(0, 8)} — done`)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Max Purchase Amount')).toHaveValue('10'));
    expect(screen.queryByTestId('backtest-reset-live')).not.toBeInTheDocument();
  });

  it('blocks on a dedup dialog instead of auto-navigating when a re-run dedups (#547 C7)', async () => {
    // The API matched an identical completed run and returned it with
    // deduped:true instead of enqueuing. The route must NOT silently anchor to
    // it: it presents a blocking choice (load existing vs run fresh anyway).
    const EXISTING_ID = 'c7777777-7777-4777-8777-777777777777';
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests') && method === 'POST') {
        return json({ runId: EXISTING_ID, deduped: true }, 202);
      }
      if (url.endsWith('/backtests') && method === 'GET') return runsList([]);
      if (url.endsWith(`/backtests/${EXISTING_ID}`)) {
        return json(runDetailBody(EXISTING_ID, 'done', { result: doneResult() }));
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Run backtest')).toBeInTheDocument());
    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), '2026-01-01T00:00');
    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), '2026-02-01T00:00');
    await user.click(screen.getByText('Run backtest'));

    // The blocking dialog appears with both choices...
    const dialog = await screen.findByTestId('backtest-dedup-dialog');
    expect(within(dialog).getByTestId('backtest-dedup-load-existing')).toBeInTheDocument();
    expect(within(dialog).getByTestId('backtest-dedup-run-fresh')).toBeInTheDocument();
    // ...and the route did NOT auto-navigate to the existing run.
    expect(screen.queryByText(`Run ${EXISTING_ID.slice(0, 8)} — done`)).not.toBeInTheDocument();

    // Choosing "load existing" anchors to the already-completed run.
    await user.click(within(dialog).getByTestId('backtest-dedup-load-existing'));
    expect(await screen.findByText(`Run ${EXISTING_ID.slice(0, 8)} — done`)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('re-requests with ?force=true and navigates when "run fresh anyway" is chosen (#557 C9)', async () => {
    // Same identical-config launch: the first POST dedups. "Run fresh anyway"
    // must re-POST with ?force=true (which the API answers deduped:false), then
    // anchor to the fresh queued run.
    const EXISTING_ID = 'c7777777-7777-4777-8777-777777777777';
    const FRESH_ID = 'd8888888-8888-4888-8888-888888888888';
    const forcedUrls: string[] = [];
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      const b = base(url);
      if (b) return b;
      if (url.includes('/backtests') && !url.includes(`/${EXISTING_ID}`) && method === 'POST') {
        // The forced re-request carries ?force=true and creates a fresh run.
        if (url.includes('force=true')) {
          forcedUrls.push(url);
          return json({ runId: FRESH_ID, deduped: false }, 202);
        }
        return json({ runId: EXISTING_ID, deduped: true }, 202);
      }
      if (url.endsWith('/backtests') && method === 'GET') return runsList([]);
      if (url.includes(`/backtests/${FRESH_ID}`)) {
        return json(runDetailBody(FRESH_ID, 'queued'));
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Run backtest')).toBeInTheDocument());
    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), '2026-01-01T00:00');
    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), '2026-02-01T00:00');
    await user.click(screen.getByText('Run backtest'));

    const dialog = await screen.findByTestId('backtest-dedup-dialog');
    await user.click(within(dialog).getByTestId('backtest-dedup-run-fresh'));

    // A forced re-request went out, and the route anchored to the fresh run.
    await waitFor(() => expect(forcedUrls.length).toBe(1));
    expect(await screen.findByText(`Run ${FRESH_ID.slice(0, 8)} — queued`)).toBeInTheDocument();
    expect(screen.queryByTestId('backtest-dedup-dialog')).not.toBeInTheDocument();
  });

  it('renders a Configure/Results/History tab bar and shows the anchored run on Results', async () => {
    // #563 reorganizes the workbench into three tabs. On load the route
    // auto-anchors to the latest run and opens on Results, so its result renders
    // without a tab click; all three tab triggers are present.
    const RUN_ID = 'b2222222-2222-4222-8222-222222222222';
    // Override present so `testedConfig` is set and the "Apply to live config"
    // button (a results-panel-only locator) actually mounts.
    const tested = { symbol: 'BTCUSDT', buy: { maxPurchaseAmount: '25' } };
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests') && method === 'GET') {
        return runsList([listRow(RUN_ID, 'done')]);
      }
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json(runDetailBody(RUN_ID, 'done', { result: doneResult(tested) }));
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    // Result is visible from the auto-anchor alone (Results is the default tab).
    expect(await screen.findByRole('button', { name: 'Apply to live config' })).toBeInTheDocument();
    // The three-tab workbench bar is present.
    expect(screen.getByTestId('bt-tab-configure')).toBeInTheDocument();
    expect(screen.getByTestId('bt-tab-results')).toBeInTheDocument();
    expect(screen.getByTestId('bt-tab-history')).toBeInTheDocument();
  });

  it('applies a finished run’s config to the live profile after confirm', async () => {
    let patchBody: unknown;
    const RUN_ID = '33333333-3333-4333-8333-333333333333';
    const tested = { symbol: 'BTCUSDT', buy: { maxPurchaseAmount: '25' } };
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/profiles/p1') && method === 'PATCH') {
        patchBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return json({ ...sampleProfile, config: tested });
      }
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests') && method === 'GET') {
        return runsList([
          {
            runId: RUN_ID,
            status: 'done',
            progress: 100,
            symbols: ['BTCUSDT'],
            createdAt: '2026-05-10T05:00:00.000Z',
            finishedAt: '2026-05-10T05:05:00.000Z',
            totalReturnPct: 12.34,
          },
        ]);
      }
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json({
          runId: RUN_ID,
          profileId: sampleProfile.id,
          params: doneResult().params,
          status: 'done',
          progress: 100,
          error: null,
          createdAt: '2026-05-10T05:00:00.000Z',
          startedAt: '2026-05-10T05:00:01.000Z',
          finishedAt: '2026-05-10T05:05:00.000Z',
          result: doneResult(tested),
        });
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    // Load the finished run from the past-runs Table (no form submit needed).
    const pastRuns = await screen.findByRole('region', { name: 'Past runs' });
    const loadBtn = await within(pastRuns).findByRole('button', { name: /^Load/ });
    await user.click(loadBtn);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Apply to live config' })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'Apply to live config' }));
    // Confirm dialog lists the changed field, then PATCHes.
    await user.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(patchBody).toBeDefined());
    expect(
      (patchBody as { config: { buy: { maxPurchaseAmount: string } } }).config.buy
        .maxPurchaseAmount,
    ).toBe('25');
  });

  it('loads a selected run’s config into the config form', async () => {
    const RUN_ID = '88888888-8888-4888-8888-888888888888';
    const tested = { symbol: 'BTCUSDT', buy: { maxPurchaseAmount: '25' } };
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests') && method === 'GET') {
        return runsList([
          {
            runId: RUN_ID,
            status: 'done',
            progress: 100,
            symbols: ['BTCUSDT'],
            createdAt: '2026-05-10T05:00:00.000Z',
            finishedAt: '2026-05-10T05:05:00.000Z',
            totalReturnPct: 12.34,
          },
        ]);
      }
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json({
          runId: RUN_ID,
          profileId: sampleProfile.id,
          params: doneResult().params,
          status: 'done',
          progress: 100,
          error: null,
          createdAt: '2026-05-10T05:00:00.000Z',
          startedAt: '2026-05-10T05:00:01.000Z',
          finishedAt: '2026-05-10T05:05:00.000Z',
          result: doneResult(tested),
        });
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    // The form starts seeded from the live config (maxPurchaseAmount '10').
    await waitFor(() => expect(screen.getByLabelText('Max Purchase Amount')).toHaveValue('10'));
    const pastRuns = await screen.findByRole('region', { name: 'Past runs' });
    await user.click(await within(pastRuns).findByRole('button', { name: /^Load/ }));
    // Clicking the run reseeds the form with that run's tested config, and offers
    // a reset back to the live config.
    await waitFor(() => expect(screen.getByLabelText('Max Purchase Amount')).toHaveValue('25'));
    expect(screen.getByTestId('backtest-reset-live')).toBeInTheDocument();
    // The config group auto-expands so the loaded values are visible, not hidden
    // in a collapsed section.
    expect(screen.getByLabelText('Max Purchase Amount').closest('details')).toHaveAttribute('open');
    // Picking a past run shows the run's result inline (above the config) while
    // the config form is reseeded on the same surface (asserted above).
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('seeds untouched sections from the merged config when a run carried a partial override', async () => {
    // The run's override changed only buy.maxPurchaseAmount; the regime/sell
    // settings it actually ran with came from the profile base config. Loading it
    // must fill the form from the MERGED effective config, not the partial
    // override — otherwise sell.stopLossPercentage would blank out to its default.
    const RUN_ID = '77777777-7777-4777-8777-777777777777';
    const tested = { symbol: 'BTCUSDT', buy: { maxPurchaseAmount: '25' } }; // no sell
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests') && method === 'GET') {
        return runsList([
          {
            runId: RUN_ID,
            status: 'done',
            progress: 100,
            symbols: ['BTCUSDT'],
            createdAt: '2026-05-10T05:00:00.000Z',
            finishedAt: '2026-05-10T05:05:00.000Z',
            totalReturnPct: 12.34,
          },
        ]);
      }
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json({
          runId: RUN_ID,
          profileId: sampleProfile.id,
          params: doneResult().params,
          status: 'done',
          progress: 100,
          error: null,
          createdAt: '2026-05-10T05:00:00.000Z',
          startedAt: '2026-05-10T05:00:01.000Z',
          finishedAt: '2026-05-10T05:05:00.000Z',
          result: doneResult(tested),
        });
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByLabelText('Max Purchase Amount')).toHaveValue('10'));
    const pastRuns = await screen.findByRole('region', { name: 'Past runs' });
    await user.click(await within(pastRuns).findByRole('button', { name: /^Load/ }));
    // The overridden field takes the run's value...
    await waitFor(() => expect(screen.getByLabelText('Max Purchase Amount')).toHaveValue('25'));
    // ...and the section the override never touched is filled from the merged base
    // config, not blanked to its schema default.
    const stopLoss = document.querySelector<HTMLInputElement>(
      'input[name="sell.stopLossPercentage"]',
    );
    expect(stopLoss?.value).toBe('5');
  });

  it('seeds the merged config when an in-flight (running) run carrying a partial override is loaded (#563)', async () => {
    // Loading a QUEUED/RUNNING run (result still null) must seed the Configure
    // form from the run's params.strategyConfigOverride MERGED onto the live
    // profile config — not the bare override, which drops every field the
    // override never touched. Here the override changed only buy.maxPurchaseAmount;
    // sell.stopLossPercentage came from the profile base and must survive the load.
    const RUN_ID = 'e5555555-5555-4555-8555-555555555555';
    // The profile's stop-loss ('8') differs from the schema default ('5'), so the
    // non-overridden assertion proves the PROFILE value flowed through the merge,
    // not a default fallback and not a blank (which a bare-override seed produces).
    const profile = {
      ...sampleProfile,
      config: {
        symbol: 'BTCUSDT',
        buy: { maxPurchaseAmount: '10' },
        sell: { stopLossPercentage: '8' },
      },
    };
    // The in-flight run's override changed only maxPurchaseAmount, to a value that
    // differs from both the profile ('10') and the schema default ('10'); no sell.
    const override = { symbol: 'BTCUSDT', buy: { maxPurchaseAmount: '42' } };
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/profiles/p1') && method === 'GET') return json(profile);
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests') && method === 'GET') {
        return runsList([listRow(RUN_ID, 'running')]);
      }
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json({
          runId: RUN_ID,
          profileId: sampleProfile.id,
          // params carries the override; result stays null while in-flight, so the
          // load takes the else branch that reconstructs the merged config.
          params: doneResult(override).params,
          status: 'running',
          progress: 30,
          error: null,
          createdAt: '2026-05-10T05:00:00.000Z',
          startedAt: '2026-05-10T05:00:01.000Z',
          finishedAt: null,
          result: null,
        });
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    // The form starts seeded from the live config (maxPurchaseAmount '10').
    await waitFor(() => expect(screen.getByLabelText('Max Purchase Amount')).toHaveValue('10'));
    const pastRuns = await screen.findByRole('region', { name: 'Past runs' });
    await user.click(await within(pastRuns).findByRole('button', { name: /^Load/ }));

    // The overridden field takes the run's value...
    await waitFor(() => expect(screen.getByLabelText('Max Purchase Amount')).toHaveValue('42'));
    // ...and the section the override never touched is filled from the MERGED base
    // config (profile '8'), not blanked/defaulted — the guard for the merge fix.
    const stopLoss = document.querySelector<HTMLInputElement>(
      'input[name="sell.stopLossPercentage"]',
    );
    expect(stopLoss?.value).toBe('8');
    // The run is in-flight, so no result renders: the results-only "Apply to live
    // config" button stays absent (metrics gated on `done`).
    expect(screen.queryByRole('button', { name: 'Apply to live config' })).not.toBeInTheDocument();
  });

  it('loads a suggested config change into the config section when a recommendation is applied', async () => {
    const RUN_ID = '99999999-9999-4999-9999-999999999999';
    // A gated run: the RSI ceiling (armed at 30) blocked every entry that passed
    // the rating gate, so the recommendations panel offers to remove it.
    const tested = {
      symbol: 'BTCUSDT',
      buy: { indicatorGate: { rsiMaxBuy: '30', smaBias: 'off', emaBias: 'off' } },
    };
    const detail = {
      ...doneResult(tested),
      decisionBreakdown: {
        metrics: [{ name: 'tt_tick_pure_path', tags: { symbol: 'BTCUSDT' }, count: 100 }],
        logs: [
          { level: 'info', message: 'tt-indicator-gate-veto', reason: 'indicator-rsi', count: 100 },
        ],
      },
    };
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests') && method === 'GET') {
        return runsList([
          {
            runId: RUN_ID,
            status: 'done',
            progress: 100,
            symbols: ['BTCUSDT'],
            createdAt: '2026-05-10T05:00:00.000Z',
            finishedAt: '2026-05-10T05:05:00.000Z',
            totalReturnPct: 0,
          },
        ]);
      }
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json({
          runId: RUN_ID,
          profileId: sampleProfile.id,
          params: doneResult().params,
          status: 'done',
          progress: 100,
          error: null,
          createdAt: '2026-05-10T05:00:00.000Z',
          startedAt: '2026-05-10T05:00:01.000Z',
          finishedAt: '2026-05-10T05:05:00.000Z',
          result: detail,
        });
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    const pastRuns = await screen.findByRole('region', { name: 'Past runs' });
    await user.click(await within(pastRuns).findByRole('button', { name: /^Load/ }));
    // Selecting the run shows its result inline, where the recommendation appears.
    const rsiToggle = await screen.findByTestId('backtest-rec-toggle-indicator-rsi');
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    // Staging a suggestion does not load or run anything yet.
    await user.click(rsiToggle);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    // Pressing the load button seeds the config section for a re-run the operator
    // triggers themselves (never straight to live) and says so — the gate stays in the loop.
    await user.click(screen.getByTestId('backtest-rec-load-selected'));
    await waitFor(() =>
      expect(screen.getByText(/Loaded your selected changes/)).toBeInTheDocument(),
    );
  });

  it('fills the window, intervals, and cost model from a selected run (#534)', async () => {
    // Clicking a past run must repopulate the WHOLE form, not just the strategy
    // config — the window (From/To) and intervals were previously left blank.
    const RUN_ID = 'a8888888-8888-4888-8888-888888888888';
    const tested = { symbol: 'BTCUSDT', buy: { maxPurchaseAmount: '25' } };
    const detail = doneResult(tested);
    // A concrete window; the assertions below check the datetime-local value
    // round-trips back to these exact instants, so the test is independent of the
    // runner's timezone (no reliance on a calendar-date margin).
    const fromMs = Date.UTC(2026, 0, 15, 12, 0);
    const toMs = Date.UTC(2026, 1, 15, 12, 0);
    const runDetail = {
      ...detail,
      params: {
        ...detail.params,
        fromMs,
        toMs,
        strategyInterval: '4h',
        detailInterval: '15m',
        initialQuoteBalance: '5000',
        fees: { makerBps: 7.5, takerBps: 8.5 },
        slippageBps: 3,
        spreadBps: 4,
        volumeCapPct: 42,
      },
    };
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests') && method === 'GET') {
        return runsList([
          {
            runId: RUN_ID,
            status: 'done',
            progress: 100,
            symbols: ['BTCUSDT'],
            createdAt: '2026-05-10T05:00:00.000Z',
            finishedAt: '2026-05-10T05:05:00.000Z',
            totalReturnPct: 12.34,
          },
        ]);
      }
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json({
          runId: RUN_ID,
          profileId: sampleProfile.id,
          params: runDetail.params,
          status: 'done',
          progress: 100,
          error: null,
          createdAt: '2026-05-10T05:00:00.000Z',
          startedAt: '2026-05-10T05:00:01.000Z',
          finishedAt: '2026-05-10T05:05:00.000Z',
          result: runDetail,
        });
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    // #669 seeds a year-long window on the bare Configure landing; clear it so the
    // Load-from-run path below is what fills From/To (the behavior under test).
    await waitFor(() => expect(screen.getByLabelText('From')).toBeInTheDocument());
    await user.clear(screen.getByLabelText('From'));
    await user.clear(screen.getByLabelText('To'));
    const pastRuns = await screen.findByRole('region', { name: 'Past runs' });
    await user.click(await within(pastRuns).findByRole('button', { name: /^Load/ }));

    // Period (From/To) is filled from the run's window — the headline bug. Assert
    // the round-trip identity (the datetime-local string parses back to the run's
    // exact instant) so the time-of-day is checked and the test holds in any zone.
    await waitFor(() =>
      expect((screen.getByLabelText('From') as HTMLInputElement).value).not.toBe(''),
    );
    expect(new Date((screen.getByLabelText('From') as HTMLInputElement).value).getTime()).toBe(
      fromMs,
    );
    expect(new Date((screen.getByLabelText('To') as HTMLInputElement).value).getTime()).toBe(toMs);
    // Detail interval comes back from the run, not the default. The strategy
    // interval is derived from the config's candleInterval (no standalone field).
    expect(screen.getByLabelText('Detail interval')).toHaveValue('15m');
    // The full cost model round-trips too.
    expect(screen.getByLabelText('Starting balance (quote)')).toHaveValue('5000');
    expect(screen.getByLabelText('Maker fee (bps)')).toHaveValue('7.5');
    expect(screen.getByLabelText('Taker fee (bps)')).toHaveValue('8.5');
    expect(screen.getByLabelText('Slippage (bps)')).toHaveValue('3');
    expect(screen.getByLabelText('Spread (bps)')).toHaveValue('4');
    expect(screen.getByLabelText('Max fill per candle (% volume)')).toHaveValue('42');
  });

  it('fills the window from a run made on the live config, no override (#534)', async () => {
    // A run launched on the live config carries no strategyConfigOverride. Clicking
    // it must still fill the backtest-only window and intervals, while the config
    // form falls back to the live config (which is what that run used).
    const RUN_ID = 'a9999999-9999-4999-8999-999999999999';
    const detail = doneResult(); // no override
    const fromMs = Date.UTC(2026, 2, 1, 9, 0);
    const toMs = Date.UTC(2026, 3, 1, 9, 0);
    const runDetail = {
      ...detail,
      params: { ...detail.params, fromMs, toMs, strategyInterval: '2h', detailInterval: '30m' },
    };
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests') && method === 'GET') {
        return runsList([
          {
            runId: RUN_ID,
            status: 'done',
            progress: 100,
            symbols: ['BTCUSDT'],
            createdAt: '2026-05-10T05:00:00.000Z',
            finishedAt: '2026-05-10T05:05:00.000Z',
            totalReturnPct: 1.0,
          },
        ]);
      }
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json({
          runId: RUN_ID,
          profileId: sampleProfile.id,
          params: runDetail.params,
          status: 'done',
          progress: 100,
          error: null,
          createdAt: '2026-05-10T05:00:00.000Z',
          startedAt: '2026-05-10T05:00:01.000Z',
          finishedAt: '2026-05-10T05:05:00.000Z',
          result: runDetail,
        });
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByLabelText('Max Purchase Amount')).toHaveValue('10'));
    const pastRuns = await screen.findByRole('region', { name: 'Past runs' });
    await user.click(await within(pastRuns).findByRole('button', { name: /^Load/ }));

    // The window and intervals fill even though the run carried no config override.
    await waitFor(() =>
      expect((screen.getByLabelText('From') as HTMLInputElement).value).not.toBe(''),
    );
    expect(new Date((screen.getByLabelText('From') as HTMLInputElement).value).getTime()).toBe(
      fromMs,
    );
    expect(screen.getByLabelText('Detail interval')).toHaveValue('30m');
    // The config form stays at the live config; no "showing a past run's config".
    expect(screen.getByLabelText('Max Purchase Amount')).toHaveValue('10');
    expect(screen.queryByTestId('backtest-reset-live')).not.toBeInTheDocument();
  });

  it('does not load config into the form after running a fresh backtest', async () => {
    // Seeding the form from a run is for explicit history picks only. A fresh
    // run already reflects the form, so it must not reseed (which would wrongly
    // flag the form as "showing a past run's config").
    const RUN_ID = '99999999-9999-4999-8999-999999999999';
    const tested = { symbol: 'BTCUSDT', buy: { maxPurchaseAmount: '25' } };
    setUp((url, init) => {
      const b = base(url);
      if (b) return b;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/backtests') && method === 'POST') return json({ runId: RUN_ID }, 202);
      if (url.endsWith('/backtests') && method === 'GET') return runsList([]);
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json({
          runId: RUN_ID,
          profileId: sampleProfile.id,
          params: doneResult().params,
          status: 'done',
          progress: 100,
          error: null,
          createdAt: '2026-05-10T05:00:00.000Z',
          startedAt: '2026-05-10T05:00:01.000Z',
          finishedAt: '2026-05-10T05:05:00.000Z',
          result: doneResult(tested),
        });
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Run backtest')).toBeInTheDocument());
    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), '2026-01-01T00:00');
    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), '2026-02-01T00:00');
    await user.click(screen.getByText('Run backtest'));
    await waitFor(() => expect(screen.getByText('12.34%')).toBeInTheDocument());
    // No "showing a past run's config" affordance — the run came from a launch.
    expect(screen.queryByText(/showing a past run.s config/i)).not.toBeInTheDocument();
    // And the config group is not force-expanded (no run was loaded into the form).
    expect(screen.getByLabelText('Max Purchase Amount').closest('details')).not.toHaveAttribute(
      'open',
    );
  });

  it('warns next to Apply when the run lost to holding (apply ≠ enable)', async () => {
    const RUN_ID = '77777777-7777-4777-8777-777777777777';
    const tested = { symbol: 'BTCUSDT', buy: { maxPurchaseAmount: '25' } };
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests') && method === 'GET') {
        return runsList([
          {
            runId: RUN_ID,
            status: 'done',
            progress: 100,
            symbols: ['BTCUSDT'],
            createdAt: '2026-05-10T05:00:00.000Z',
            finishedAt: '2026-05-10T05:05:00.000Z',
            totalReturnPct: 4.41,
          },
        ]);
      }
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        const r = doneResult(tested);
        return json({
          runId: RUN_ID,
          profileId: sampleProfile.id,
          params: doneResult().params,
          status: 'done',
          progress: 100,
          error: null,
          createdAt: '2026-05-10T05:00:00.000Z',
          startedAt: '2026-05-10T05:00:01.000Z',
          finishedAt: '2026-05-10T05:05:00.000Z',
          // A positive return that lost to holding → recommend hold → warn.
          result: { ...r, metrics: { ...r.metrics, totalReturnPct: 4.41, alphaVsHoldPct: -99.66 } },
        });
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    const pastRuns = await screen.findByRole('region', { name: 'Past runs' });
    await user.click(await within(pastRuns).findByRole('button', { name: /^Load/ }));
    await screen.findByRole('button', { name: 'Apply to live config' });
    expect(screen.getByText(/didn.t clear the live gate/)).toBeInTheDocument();
  });

  it('pins a finished run as the live baseline', async () => {
    let patchBody: unknown;
    const RUN_ID = '55555555-5555-4555-8555-555555555555';
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/profiles/p1') && method === 'PATCH') {
        patchBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return json(sampleProfile);
      }
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests') && method === 'GET') {
        return runsList([
          {
            runId: RUN_ID,
            status: 'done',
            progress: 100,
            symbols: ['BTCUSDT'],
            createdAt: '2026-05-10T05:00:00.000Z',
            finishedAt: '2026-05-10T05:05:00.000Z',
            totalReturnPct: 12.34,
          },
        ]);
      }
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json({
          runId: RUN_ID,
          profileId: sampleProfile.id,
          params: doneResult().params,
          status: 'done',
          progress: 100,
          error: null,
          createdAt: '2026-05-10T05:00:00.000Z',
          startedAt: '2026-05-10T05:00:01.000Z',
          finishedAt: '2026-05-10T05:05:00.000Z',
          result: doneResult(),
        });
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    const pastRuns = await screen.findByRole('region', { name: 'Past runs' });
    await user.click(await within(pastRuns).findByRole('button', { name: /^Load/ }));
    await user.click(await screen.findByTestId('backtest-pin-baseline'));

    await waitFor(() => expect(patchBody).toBeDefined());
    expect((patchBody as { baselineBacktestRunId: string }).baselineBacktestRunId).toBe(RUN_ID);
  });

  it('the Next control fetches page 2 and is disabled when nextCursor is null', async () => {
    const NEXT_CURSOR = '2026-05-10T05:00:00.000Z__aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const page1Row = {
      runId: '44444444-4444-4444-8444-444444444444',
      status: 'done' as const,
      progress: 100,
      symbols: ['BTCUSDT'],
      createdAt: '2026-05-10T05:00:00.000Z',
      finishedAt: '2026-05-10T05:05:00.000Z',
      totalReturnPct: 1.5,
    };
    const page2Row = {
      ...page1Row,
      runId: '55555555-5555-4555-8555-555555555555',
      symbols: ['ETHUSDT'],
      totalReturnPct: 2.5,
    };
    setUp((url) => {
      const b = base(url);
      if (b) return b;
      if (url.includes('/backtests')) {
        // Page 1 (no cursor) advertises a next page; page 2 (cursor present)
        // is the last page and reports nextCursor null.
        return url.includes('cursor=')
          ? runsList([page2Row], null)
          : runsList([page1Row], NEXT_CURSOR);
      }
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    const pastRuns = await screen.findByRole('region', { name: 'Past runs' });
    await within(pastRuns).findByText('BTCUSDT');
    const next = within(pastRuns).getByRole('button', { name: 'Next ›' });
    expect(next).toBeEnabled();

    await user.click(next);

    // Page 2 row loads; the last page disables Next and enables Prev.
    await within(pastRuns).findByText('ETHUSDT');
    expect(within(pastRuns).getByRole('button', { name: 'Next ›' })).toBeDisabled();
    expect(within(pastRuns).getByRole('button', { name: '‹ Prev' })).toBeEnabled();

    // Prev pops the cursor history back to page 1 and disables itself there.
    await user.click(within(pastRuns).getByRole('button', { name: '‹ Prev' }));
    await within(pastRuns).findByText('BTCUSDT');
    expect(within(pastRuns).getByRole('button', { name: '‹ Prev' })).toBeDisabled();
    expect(within(pastRuns).getByRole('button', { name: 'Next ›' })).toBeEnabled();
  });

  it('drives the runs list outcome filter and page size through server query params', async () => {
    const row = {
      runId: '44444444-4444-4444-8444-444444444444',
      status: 'done' as const,
      progress: 100,
      symbols: ['BTCUSDT'],
      createdAt: '2026-05-10T05:00:00.000Z',
      finishedAt: '2026-05-10T05:05:00.000Z',
      totalReturnPct: 1.5,
    };
    const listUrls: string[] = [];
    setUp((url) => {
      const b = base(url);
      if (b) return b;
      if (url.includes('/backtests')) {
        listUrls.push(url);
        return runsList([row], null);
      }
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    const pastRuns = await screen.findByRole('region', { name: 'Past runs' });
    await within(pastRuns).findByText('BTCUSDT');

    // The default first page omits both params: page size 10 equals the server
    // default (so no `limit`), and the "All" filter sends no `filter`.
    expect(
      listUrls.some(
        (u) => u.includes('/backtests') && !u.includes('limit=') && !u.includes('filter='),
      ),
    ).toBe(true);

    // Filtering by Profit narrows the server query to filter=profit.
    await user.click(within(pastRuns).getByTestId('bt-runs-filter-profit'));
    await waitFor(() => expect(listUrls.some((u) => u.includes('filter=profit'))).toBe(true));

    // Switching to Error sends filter=error.
    await user.click(within(pastRuns).getByTestId('bt-runs-filter-error'));
    await waitFor(() => expect(listUrls.some((u) => u.includes('filter=error'))).toBe(true));

    // Raising rows-per-page sends an explicit limit.
    await user.selectOptions(within(pastRuns).getByTestId('bt-runs-page-size'), '25');
    await waitFor(() => expect(listUrls.some((u) => u.includes('limit=25'))).toBe(true));

    // The Manual type filter sends `kind`, orthogonal to the outcome filter.
    await user.click(within(pastRuns).getByTestId('bt-runs-kind-manual'));
    await waitFor(() => expect(listUrls.some((u) => u.includes('kind=manual'))).toBe(true));
  });

  it('shows the run result inline when a run is launched', async () => {
    const RUN_ID = 'c1111111-1111-4111-8111-111111111111';
    setUp((url, init) => {
      const b = base(url);
      if (b) return b;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/backtests') && method === 'POST') return json({ runId: RUN_ID }, 202);
      if (url.endsWith('/backtests') && method === 'GET') return runsList([]);
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json({
          runId: RUN_ID,
          profileId: sampleProfile.id,
          params: doneResult().params,
          status: 'running',
          progress: 30,
          error: null,
          createdAt: '2026-05-10T05:00:00.000Z',
          startedAt: '2026-05-10T05:00:01.000Z',
          finishedAt: null,
          result: null,
        });
      }
      return new Response('not found', { status: 404 });
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Run backtest')).toBeInTheDocument());
    // No run yet, so no progress/result is shown.
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), '2026-01-01T00:00');
    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), '2026-02-01T00:00');
    await user.click(screen.getByText('Run backtest'));
    // Launching surfaces the run's progress inline, above the config form.
    await waitFor(() => expect(screen.getByRole('progressbar')).toBeInTheDocument());
  });

  it('shows the result area and config form on one surface, keeping config edits', async () => {
    setUp((url) => {
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests')) return runsList([]);
      return new Response('not found', { status: 404 });
    });
    await waitFor(() => expect(screen.getByLabelText('Max Purchase Amount')).toHaveValue('10'));
    // The results area and the config form are both present at once (no tabs).
    expect(screen.getByText(/No run yet/)).toBeInTheDocument();
    // Edit a config field (fireEvent so it works whether the group is collapsed).
    fireEvent.change(screen.getByLabelText('Max Purchase Amount'), { target: { value: '42' } });
    // The always-mounted config form holds the edit.
    expect(screen.getByLabelText('Max Purchase Amount')).toHaveValue('42');
  });

  it('fills From and To from a one-click window preset', async () => {
    setUp((url) => {
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests')) return runsList([]);
      return new Response('not found', { status: 404 });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('backtest-window-30d'));
    const from = screen.getByLabelText('From') as HTMLInputElement;
    const to = screen.getByLabelText('To') as HTMLInputElement;
    expect(from.value).not.toBe('');
    expect(to.value).not.toBe('');
    // ~30 days wide, allowing one DST hour of slack in the local round-trip.
    const span = new Date(to.value).getTime() - new Date(from.value).getTime();
    expect(Math.abs(span - 30 * 86_400_000)).toBeLessThanOrEqual(3_600_000);
  });

  it('defaults From and To to a 365-day window when the form opens empty (#659 C3)', async () => {
    // Opening the empty Configure form with no run and no window should pre-fill a
    // sensible year-long lookback (today-365 .. today) instead of forcing the
    // operator to pick both dates before they can run anything.
    // The Backtest link and the Configure tab both land here with ?view=configure;
    // that deliberate Configure entry is what triggers the empty-window default
    // (the bare default landing and the run-load paths must stay untouched).
    setUp((url) => {
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests')) return runsList([]);
      return new Response('not found', { status: 404 });
    }, `/accounts/${ACCOUNT_ID}/profiles/p1/backtest?view=configure`);
    const from = (await screen.findByLabelText('From')) as HTMLInputElement;
    const to = screen.getByLabelText('To') as HTMLInputElement;
    // Filled without any interaction.
    expect(from.value).not.toBe('');
    expect(to.value).not.toBe('');
    // ~365 days wide, one DST hour of slack in the local round-trip.
    const span = new Date(to.value).getTime() - new Date(from.value).getTime();
    expect(Math.abs(span - 365 * 86_400_000)).toBeLessThanOrEqual(3_600_000);
    // To anchors on ~now (within a day).
    expect(Math.abs(new Date(to.value).getTime() - Date.now())).toBeLessThanOrEqual(86_400_000);
  });

  it('does not clobber a run-loaded window with the empty-form default (#659 C3 guard)', async () => {
    // A ?run= deep link loads the run's own window via paramStateFromResult. The
    // 365-day empty-form default must NOT overwrite a window that was seeded from a
    // loaded run — doneResult's fromMs is 1 (a 1970 window), so if the default
    // clobbered it the year would flip to the current one.
    setUp((url) => {
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests')) return runsList([listRow(DONE_ID, 'done')]);
      if (url.endsWith(`/backtests/${DONE_ID}`)) {
        return json(runDetailBody(DONE_ID, 'done', { result: doneResult() }));
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    }, `/accounts/${ACCOUNT_ID}/profiles/p1/backtest?run=${DONE_ID}`);

    await screen.findByText(`Run ${DONE_ID.slice(0, 8)} — done`);
    const from = screen.getByLabelText('From') as HTMLInputElement;
    await waitFor(() => expect(from.value).not.toBe(''));
    // The loaded 1970 window wins over the year-long default.
    expect(new Date(from.value).getFullYear()).toBe(1970);
  });

  it('seeds the 365-day window on the bare Configure landing (#669)', async () => {
    // The empty-window default fires on the deliberate Configure entry
    // (?view=configure) AND on the bare Configure landing (no ?view=, no ?run=,
    // no ?autorun=, no active run — activeTab falls back to 'configure'). #669
    // broadens the #659 default to the bare landing so the operator lands on a
    // ready-to-run year-long window instead of two empty date fields.
    setUp((url) => {
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests')) return runsList([]);
      return new Response('not found', { status: 404 });
    });
    // Configure is the active tab (nothing anchors), and the window is seeded.
    await waitFor(() => expect(screen.getByText('No runs yet.')).toBeInTheDocument());
    expect(
      await screen.findByRole('heading', { name: 'Configure a backtest' }),
    ).toBeInTheDocument();
    const from = screen.getByLabelText('From') as HTMLInputElement;
    const to = screen.getByLabelText('To') as HTMLInputElement;
    // Filled without any interaction.
    expect(from.value).not.toBe('');
    expect(to.value).not.toBe('');
    // ~365 days wide, one DST hour of slack in the local round-trip.
    const span = new Date(to.value).getTime() - new Date(from.value).getTime();
    expect(Math.abs(span - 365 * 86_400_000)).toBeLessThanOrEqual(3_600_000);
    // To anchors on ~now (within a day).
    expect(Math.abs(new Date(to.value).getTime() - Date.now())).toBeLessThanOrEqual(86_400_000);
  });

  it('does not seed the 365-day window over the autorun 90-day default (#659 gate)', async () => {
    // Autorun (?autorun=1) launches on the current config with its own 90-day
    // lookback; the Configure empty-window default must not clobber that window.
    const RUN_ID = 'f1111111-1111-4111-8111-111111111111';
    let postBody: Record<string, unknown> | undefined;
    setUp((url, init) => {
      const b = base(url);
      if (b) return b;
      const method = init?.method ?? 'GET';
      if (url.includes('/backtests') && !url.includes(`/${RUN_ID}`) && method === 'POST') {
        postBody = JSON.parse(init?.body as string);
        return json({ runId: RUN_ID }, 202);
      }
      if (url.endsWith('/backtests') && method === 'GET') return runsList([]);
      if (url.includes(`/backtests/${RUN_ID}`)) return json(runDetailBody(RUN_ID, 'running'));
      return new Response('not found', { status: 404 });
    }, `/accounts/${ACCOUNT_ID}/profiles/p1/backtest?autorun=1`);

    await waitFor(() => expect(postBody).toBeDefined());
    const span = (postBody!.toMs as number) - (postBody!.fromMs as number);
    // 90-day autorun default, not the 365-day Configure seed. One DST hour slack.
    expect(Math.abs(span - 90 * 86_400_000)).toBeLessThanOrEqual(3_600_000);
    expect(Math.abs(span - 365 * 86_400_000)).toBeGreaterThan(3_600_000);
  });

  // --- Abort / retry of stuck and failed runs -------------------------------

  const RUNNING_ID = 'b1111111-1111-4111-8111-111111111111';
  const ERROR_ID = 'b2222222-2222-4222-8222-222222222222';
  const DONE_ID = 'b3333333-3333-4333-8333-333333333333';
  const CANCELLED_ID = 'b4444444-4444-4444-8444-444444444444';

  const listRow = (runId: string, status: string) => ({
    runId,
    status,
    progress: status === 'done' ? 100 : 0,
    symbols: ['BTCUSDT'],
    createdAt: '2026-05-10T05:00:00.000Z',
    finishedAt: status === 'queued' || status === 'running' ? null : '2026-05-10T05:05:00.000Z',
    totalReturnPct: status === 'done' ? 1.5 : null,
  });

  const runDetailBody = (
    runId: string,
    status: string,
    overrides?: { result?: unknown; startedAt?: string | null },
  ) => ({
    runId,
    profileId: sampleProfile.id,
    status,
    progress: status === 'done' ? 100 : 0,
    error: null,
    createdAt: '2026-05-10T05:00:00.000Z',
    startedAt: overrides?.startedAt ?? null,
    finishedAt: null,
    // Detail always carries the run's launch params (required by the schema);
    // mirror the result's params when present so a loaded run's window matches.
    params: (overrides?.result as { params?: unknown } | undefined)?.params ?? doneResult().params,
    result: overrides?.result ?? null,
  });

  it('groups row actions in an overflow menu: abort in-flight, retry failed, delete terminal', async () => {
    setUp((url) => {
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests'))
        return runsList([
          listRow(RUNNING_ID, 'running'),
          listRow(ERROR_ID, 'error'),
          listRow(DONE_ID, 'done'),
          listRow(CANCELLED_ID, 'cancelled'),
        ]);
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();

    // In-flight row: Abort only (delete must abort first; nothing to retry).
    await user.click(await screen.findByTestId(`backtest-row-actions-${RUNNING_ID}`));
    expect(await screen.findByTestId(`backtest-abort-${RUNNING_ID}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`backtest-retry-${RUNNING_ID}`)).toBeNull();
    expect(screen.queryByTestId(`backtest-delete-${RUNNING_ID}`)).toBeNull();
    await user.keyboard('{Escape}');

    // Failed row: Retry + Delete, no Abort.
    await user.click(await screen.findByTestId(`backtest-row-actions-${ERROR_ID}`));
    expect(await screen.findByTestId(`backtest-retry-${ERROR_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId(`backtest-delete-${ERROR_ID}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`backtest-abort-${ERROR_ID}`)).toBeNull();
    await user.keyboard('{Escape}');

    // Cancelled row behaves like a failed row: Retry + Delete, no Abort.
    await user.click(await screen.findByTestId(`backtest-row-actions-${CANCELLED_ID}`));
    expect(await screen.findByTestId(`backtest-retry-${CANCELLED_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId(`backtest-delete-${CANCELLED_ID}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`backtest-abort-${CANCELLED_ID}`)).toBeNull();
    await user.keyboard('{Escape}');

    // Done row: Delete only.
    await user.click(await screen.findByTestId(`backtest-row-actions-${DONE_ID}`));
    expect(await screen.findByTestId(`backtest-delete-${DONE_ID}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`backtest-abort-${DONE_ID}`)).toBeNull();
    expect(screen.queryByTestId(`backtest-retry-${DONE_ID}`)).toBeNull();
  });

  it('Abort posts to the abort endpoint and does not also select the row', async () => {
    const { fetchMock } = setUp((url) => {
      const b = base(url);
      if (b) return b;
      if (url.includes('/abort')) return json(runDetailBody(RUNNING_ID, 'cancelled'));
      // Head the list with a done run so the auto-anchor on load targets it, not
      // the running row under test — keeping the "no detail GET for RUNNING_ID"
      // assertion a clean probe of the Abort click's stopPropagation alone.
      if (url.endsWith('/backtests'))
        return runsList([listRow(DONE_ID, 'done'), listRow(RUNNING_ID, 'running')]);
      const m = url.match(/\/backtests\/([0-9a-f-]{36})$/);
      if (m) return json(runDetailBody(m[1] as string, 'queued'));
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    await user.click(await screen.findByTestId(`backtest-row-actions-${RUNNING_ID}`));
    await user.click(await screen.findByTestId(`backtest-abort-${RUNNING_ID}`));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u, init]) =>
            String(u).endsWith(`/backtests/${RUNNING_ID}/abort`) &&
            (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true),
    );
    // stopPropagation: clicking Abort must not trigger the row's config-load,
    // which would GET the bare run-detail URL for the same run.
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith(`/backtests/${RUNNING_ID}`))).toBe(
      false,
    );
  });

  it('Retry posts to the retry endpoint for a failed run', async () => {
    const NEW_ID = 'b5555555-5555-4555-8555-555555555555';
    const { fetchMock } = setUp((url) => {
      const b = base(url);
      if (b) return b;
      if (url.includes('/retry')) return json({ runId: NEW_ID }, 202);
      if (url.endsWith('/backtests')) return runsList([listRow(ERROR_ID, 'error')]);
      const m = url.match(/\/backtests\/([0-9a-f-]{36})$/);
      if (m) return json(runDetailBody(m[1] as string, 'queued'));
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    await user.click(await screen.findByTestId(`backtest-row-actions-${ERROR_ID}`));
    await user.click(await screen.findByTestId(`backtest-retry-${ERROR_ID}`));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u, init]) =>
            String(u).endsWith(`/backtests/${ERROR_ID}/retry`) &&
            (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true),
    );
  });

  it('hydrates the active run from a ?run= deep link and shows its result inline', async () => {
    setUp((url) => {
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests')) return runsList([listRow(DONE_ID, 'done')]);
      const m = url.match(/\/backtests\/([0-9a-f-]{36})$/);
      if (m) return json({ ...runDetailBody(m[1] as string, 'done'), result: doneResult() });
      return new Response('not found', { status: 404 });
    }, `/accounts/${ACCOUNT_ID}/profiles/p1/backtest?run=${DONE_ID}`);

    // The run's result panel appears with no click — the progress heading carries
    // the deep-linked run's id and status.
    expect(await screen.findByText(`Run ${DONE_ID.slice(0, 8)} — done`)).toBeInTheDocument();
  });

  it('a ?run= deep link wins over the auto-anchor when they differ', async () => {
    // The list head is the NEWEST run, but the URL deep-links an OLDER run. The
    // `runParam` guard makes the deep link own the surface: the older run's result
    // shows and the newer (head) run never auto-anchors. Removing that guard would
    // let the newest run hijack the deep link.
    setUp((url) => {
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests')) {
        // Head = newest, so the auto-anchor would target 'newer-run' absent the guard.
        return runsList([listRow('newer-run', 'done'), listRow('older-run', 'done')]);
      }
      if (url.endsWith('/backtests/older-run')) {
        return json(runDetailBody('older-run', 'done', { result: doneResult() }));
      }
      if (url.endsWith('/backtests/newer-run')) {
        return json(runDetailBody('newer-run', 'done', { result: doneResult() }));
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    }, `/accounts/${ACCOUNT_ID}/profiles/p1/backtest?run=older-run`);

    // The deep-linked OLDER run's result heading appears ("Run older-ru — done")...
    expect(await screen.findByText(/Run older-ru/i)).toBeInTheDocument();
    // ...and the newer (head) run never anchored.
    expect(screen.queryByText(/Run newer-ru/i)).not.toBeInTheDocument();
  });

  it('Delete opens a confirm dialog and DELETEs the run only on confirm', async () => {
    const { fetchMock } = setUp((url, init) => {
      const b = base(url);
      if (b) return b;
      const method = init?.method ?? 'GET';
      if (url.endsWith(`/backtests/${DONE_ID}`) && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/backtests')) return runsList([listRow(DONE_ID, 'done')]);
      const m = url.match(/\/backtests\/([0-9a-f-]{36})$/);
      if (m) return json({ ...runDetailBody(m[1] as string, 'done'), result: doneResult() });
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    await user.click(await screen.findByTestId(`backtest-row-actions-${DONE_ID}`));
    await user.click(await screen.findByTestId(`backtest-delete-${DONE_ID}`));
    // The confirm dialog gates the destructive call; no DELETE until confirm.
    expect(
      fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'DELETE'),
    ).toBe(false);
    await user.click(await screen.findByTestId('backtest-delete-confirm'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u, i]) =>
            String(u).endsWith(`/backtests/${DONE_ID}`) &&
            (i as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true),
    );
  });

  it('the pinned baseline row offers Unpin and keeps Delete disabled with a reason', async () => {
    setUp((url) => {
      if (url.endsWith('/profiles/p1'))
        return json({ ...sampleProfile, baselineBacktestRunId: DONE_ID });
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests')) return runsList([listRow(DONE_ID, 'done')]);
      const m = url.match(/\/backtests\/([0-9a-f-]{36})$/);
      if (m) return json({ ...runDetailBody(m[1] as string, 'done'), result: doneResult() });
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    await user.click(await screen.findByTestId(`backtest-row-actions-${DONE_ID}`));
    // Unpin is offered so the baseline is not a dead end; Delete stays present but
    // disabled with the reason — never silently absent.
    expect(await screen.findByTestId(`backtest-unpin-baseline-${DONE_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId(`backtest-delete-${DONE_ID}`)).toBeInTheDocument();
    expect(screen.getByText('Unpin the baseline first')).toBeInTheDocument();
  });

  it('Unpin baseline PATCHes baselineBacktestRunId to null', async () => {
    let patchBody: unknown;
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/profiles/p1') && method === 'PATCH') {
        patchBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return json(sampleProfile);
      }
      if (url.endsWith('/profiles/p1'))
        return json({ ...sampleProfile, baselineBacktestRunId: DONE_ID });
      const b = base(url);
      if (b) return b;
      if (url.endsWith('/backtests')) return runsList([listRow(DONE_ID, 'done')]);
      const m = url.match(/\/backtests\/([0-9a-f-]{36})$/);
      if (m) return json({ ...runDetailBody(m[1] as string, 'done'), result: doneResult() });
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    await user.click(await screen.findByTestId(`backtest-row-actions-${DONE_ID}`));
    await user.click(await screen.findByTestId(`backtest-unpin-baseline-${DONE_ID}`));

    await waitFor(() => expect(patchBody).toBeDefined());
    expect(
      (patchBody as { baselineBacktestRunId: string | null }).baselineBacktestRunId,
    ).toBeNull();
  });

  it('bulk-selects deletable runs and deletes them on confirm', async () => {
    const RUN_A = 'd1111111-1111-4111-8111-111111111111';
    const RUN_B = 'd2222222-2222-4222-8222-222222222222';
    const { fetchMock } = setUp((url, init) => {
      const b = base(url);
      if (b) return b;
      const method = init?.method ?? 'GET';
      const del = url.match(/\/backtests\/([0-9a-f-]{36})$/);
      if (del && method === 'DELETE') return new Response(null, { status: 204 });
      if (url.endsWith('/backtests'))
        return runsList([listRow(RUN_A, 'done'), listRow(RUN_B, 'error')]);
      if (del) return json({ ...runDetailBody(del[1] as string, 'done'), result: doneResult() });
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    // Select-all picks both deletable rows; the bulk bar reports the count.
    await user.click(await screen.findByTestId('backtest-select-all'));
    const bulk = await screen.findByTestId('backtest-delete-selected');
    expect(bulk).toHaveTextContent('Delete selected (2)');

    await user.click(bulk);
    // Gated by the confirm dialog: nothing deleted until confirm.
    expect(
      fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'DELETE'),
    ).toBe(false);
    await user.click(await screen.findByTestId('backtest-delete-confirm'));

    await waitFor(() => {
      const deletes = fetchMock.mock.calls.filter(
        ([u, i]) =>
          /\/backtests\/[0-9a-f-]{36}$/.test(String(u)) &&
          (i as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(deletes.map(([u]) => String(u).endsWith(RUN_A)).includes(true)).toBe(true);
      expect(deletes.map(([u]) => String(u).endsWith(RUN_B)).includes(true)).toBe(true);
    });
  });

  it('reports a partial outcome when some bulk deletes fail', async () => {
    const RUN_OK = 'd3333333-3333-4333-8333-333333333333';
    const RUN_BAD = 'd4444444-4444-4444-8444-444444444444';
    setUp((url, init) => {
      const b = base(url);
      if (b) return b;
      const method = init?.method ?? 'GET';
      // RUN_BAD's delete 409s (e.g. it raced into the baseline); RUN_OK's 204s.
      if (url.endsWith(`/backtests/${RUN_BAD}`) && method === 'DELETE')
        return new Response(null, { status: 409 });
      const del = url.match(/\/backtests\/([0-9a-f-]{36})$/);
      if (del && method === 'DELETE') return new Response(null, { status: 204 });
      if (url.endsWith('/backtests'))
        return runsList([listRow(RUN_OK, 'done'), listRow(RUN_BAD, 'done')]);
      if (del) return json({ ...runDetailBody(del[1] as string, 'done'), result: doneResult() });
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('backtest-select-all'));
    await user.click(await screen.findByTestId('backtest-delete-selected'));
    await user.click(await screen.findByTestId('backtest-delete-confirm'));

    // The banner pins both the count math and the copy: 1 of 2 deleted, 1 failed.
    expect(await screen.findByText('Deleted 1 of 2; 1 could not be deleted.')).toBeInTheDocument();
  });

  // --- Run comparison + durable lineage (#546) ------------------------------

  it('offers no comparison anchor when the run has no parent and no baseline, and does not crash (#546 C7)', async () => {
    // A plain auto-anchored run: no parentRunId on the run, no baselineBacktestRunId
    // on the profile. The Verdict header must offer no comparison anchor and still
    // render the run normally (a regression guard for the no-lineage case).
    const RUN_ID = 'e7777777-7777-4777-8777-777777777777';
    setUp((url, init) => {
      const b = base(url);
      if (b) return b;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/backtests') && method === 'GET')
        return runsList([listRow(RUN_ID, 'done')]);
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json(runDetailBody(RUN_ID, 'done', { result: doneResult() }));
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    expect(await screen.findByText(`Run ${RUN_ID.slice(0, 8)} — done`)).toBeInTheDocument();
    expect(screen.queryByTestId('backtest-compare-parent')).toBeNull();
    expect(screen.queryByTestId('backtest-compare-baseline')).toBeNull();
  });

  it('offers Parent and Baseline comparison anchors when a parent and a baseline exist (#546 C4)', async () => {
    const RUN_ID = 'e4444444-4444-4444-8444-444444444444';
    const PARENT_ID = 'ea444444-4444-4444-8444-444444444444';
    const BASE_ID = 'eb444444-4444-4444-8444-444444444444';
    setUp((url, init) => {
      // The profile carries a pinned baseline; check before base() (which also
      // matches /profiles/p1) so this override wins.
      if (url.endsWith('/profiles/p1')) {
        return json({ ...sampleProfile, baselineBacktestRunId: BASE_ID });
      }
      const b = base(url);
      if (b) return b;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/backtests') && method === 'GET')
        return runsList([listRow(RUN_ID, 'done')]);
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json({
          ...runDetailBody(RUN_ID, 'done', { result: doneResult() }),
          parentRunId: PARENT_ID,
        });
      }
      if (url.endsWith(`/backtests/${PARENT_ID}`)) {
        return json(runDetailBody(PARENT_ID, 'done', { result: doneResult() }));
      }
      if (url.endsWith(`/backtests/${BASE_ID}`)) {
        return json(runDetailBody(BASE_ID, 'done', { result: doneResult() }));
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    expect(await screen.findByTestId('backtest-compare-parent')).toBeInTheDocument();
    expect(await screen.findByTestId('backtest-compare-baseline')).toBeInTheDocument();
  });

  it('shows metric deltas vs the selected anchor when they share the same market (#546 C5)', async () => {
    // The viewed run and its parent ran the SAME market window (identical params),
    // so selecting the Parent anchor renders metric deltas (return, alpha, drawdown).
    const RUN_ID = 'e5555555-5555-4555-8555-555555555555';
    const PARENT_ID = 'ea555555-5555-4555-8555-555555555555';
    const parentResult = {
      ...doneResult(),
      metrics: {
        ...doneResult().metrics,
        totalReturnPct: 10,
        alphaVsHoldPct: 2,
        maxDrawdownPct: -4,
      },
    };
    setUp((url, init) => {
      const b = base(url);
      if (b) return b;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/backtests') && method === 'GET')
        return runsList([listRow(RUN_ID, 'done')]);
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json({
          ...runDetailBody(RUN_ID, 'done', { result: doneResult() }),
          parentRunId: PARENT_ID,
        });
      }
      if (url.endsWith(`/backtests/${PARENT_ID}`)) {
        return json({
          ...runDetailBody(PARENT_ID, 'done', { result: parentResult }),
          parentRunId: null,
        });
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('backtest-compare-parent'));
    const deltas = await screen.findByTestId('backtest-compare-deltas');
    // Deltas are viewed − anchor. viewed: return 12.34, alpha 0, drawdown 0;
    // parent: return 10, alpha 2, drawdown -4. A sign flip here must fail.
    const cell = (label: string): HTMLElement =>
      within(deltas).getByText(label).parentElement as HTMLElement;
    expect(within(cell('Return Δ')).getByText('+2.34%')).toHaveClass('text-up');
    // Alpha fell vs the parent (0 < 2) → negative delta, red.
    expect(within(cell('Alpha Δ')).getByText('-2.00%')).toHaveClass('text-down');
    // maxDrawdownPct is signed (≤ 0); viewed 0 is less-negative than parent -4,
    // so the +4.00% delta is an improvement and tints green (higher-is-better).
    expect(within(cell('Drawdown Δ')).getByText('+4.00%')).toHaveClass('text-up');
  });

  it('does not offer a self-comparison when the viewed run is the pinned baseline (#546 A)', async () => {
    // The viewed run IS the profile's pinned baseline (and has no parent). A
    // disabled query still serves cached data for the shared key, so the route's
    // identity guard must drop the anchor — a run is never its own anchor.
    const RUN_ID = 'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    setUp((url, init) => {
      if (url.endsWith('/profiles/p1')) {
        return json({ ...sampleProfile, baselineBacktestRunId: RUN_ID });
      }
      const b = base(url);
      if (b) return b;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/backtests') && method === 'GET')
        return runsList([listRow(RUN_ID, 'done')]);
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json(runDetailBody(RUN_ID, 'done', { result: doneResult() }));
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    expect(await screen.findByText(`Run ${RUN_ID.slice(0, 8)} — done`)).toBeInTheDocument();
    expect(screen.queryByTestId('backtest-compare-baseline')).toBeNull();
    expect(screen.queryByTestId('backtest-compare-parent')).toBeNull();
  });

  it('shows "Not comparable" and no deltas when the run and anchor differ in market (#546 C6)', async () => {
    // The viewed run ran BTCUSDT; its parent ran ETHUSDT — a different market dim,
    // so no deltas are meaningful and the header says so instead.
    const RUN_ID = 'e6666666-6666-4666-8666-666666666666';
    const PARENT_ID = 'ea666666-6666-4666-8666-666666666666';
    const parentResult = {
      ...doneResult(),
      params: { ...doneResult().params, symbols: ['ETHUSDT'] },
    };
    setUp((url, init) => {
      const b = base(url);
      if (b) return b;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/backtests') && method === 'GET')
        return runsList([listRow(RUN_ID, 'done')]);
      if (url.endsWith(`/backtests/${RUN_ID}`)) {
        return json({
          ...runDetailBody(RUN_ID, 'done', { result: doneResult() }),
          parentRunId: PARENT_ID,
        });
      }
      if (url.endsWith(`/backtests/${PARENT_ID}`)) {
        return json({
          ...runDetailBody(PARENT_ID, 'done', { result: parentResult }),
          parentRunId: null,
        });
      }
      if (url.includes('/candles')) return json([]);
      return new Response('not found', { status: 404 });
    });

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('backtest-compare-parent'));
    expect(
      await screen.findByText('Not comparable — different market window.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('backtest-compare-deltas')).toBeNull();
  });
});
