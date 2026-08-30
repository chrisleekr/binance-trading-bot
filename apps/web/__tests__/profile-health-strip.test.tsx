import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeeBasis, GateStatusResponse } from '@app/contracts';

import {
  pickHealthHeadline,
  ProfileHealthStrip,
} from '@/features/dashboard/components/profile-health-strip';
import { createQueryClient } from '@/shared/lib/query-client';

const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';
// The global test-setup default active account, which the strip reads via useActiveAccountId to build the backtest link.
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';

describe('pickHealthHeadline', () => {
  const gateWarn = { tone: 'warning' as const, title: 'Unproven config.', body: 'gate body' };
  const gateDown = { tone: 'down' as const, title: 'New buys paused.', body: 'gate body' };
  const gateUp = { tone: 'up' as const, title: 'Live trading validated.', body: 'gate body' };

  it('returns the gate headline when there is no edge verdict', () => {
    expect(pickHealthHeadline(gateWarn, null)).toEqual(gateWarn);
  });

  it('lets a breached edge override a merely-unproven gate', () => {
    const r = pickHealthHeadline(gateWarn, {
      verdict: 'breached',
      reason: 'live profit factor 0.45 below 1.0',
    });
    expect(r.tone).toBe('down');
    expect(r.title).toBe('Edge below baseline.');
    expect(r.body).toBe('live profit factor 0.45 below 1.0.');
  });

  it('keeps the paused gate headline even when the edge is breached (gate wins ties)', () => {
    expect(pickHealthHeadline(gateDown, { verdict: 'breached', reason: 'x' })).toEqual(gateDown);
  });

  it('lets a breached edge override a gate-off (muted) headline', () => {
    const gateOff = { tone: 'muted' as const, title: 'Live gate off.', body: 'gate body' };
    const r = pickHealthHeadline(gateOff, {
      verdict: 'breached',
      reason: 'live profit factor 0.45 below 1.0',
    });
    // A losing live edge is a real-money signal that must not be hidden just
    // because the operator turned the backtest gate off.
    expect(r.tone).toBe('down');
    expect(r.title).toBe('Edge below baseline.');
  });

  it('lets an edge warning override a healthy gate', () => {
    const r = pickHealthHeadline(gateUp, { verdict: 'warning', reason: 'edge weakening' });
    expect(r.tone).toBe('warning');
    expect(r.title).toBe('Edge weakening.');
  });

  it('ignores non-actionable edge verdicts (healthy / insufficient / no-baseline / monitor-off)', () => {
    for (const verdict of ['healthy', 'insufficient-data', 'no-baseline', 'monitor-off']) {
      expect(pickHealthHeadline(gateUp, { verdict, reason: 'x' })).toEqual(gateUp);
    }
  });
});

const jsonOf = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const profileBody = {
  id: PROFILE_ID,
  accountId: PROFILE_ID,
  name: 'P',
  strategyName: 'trailing-trade',
  strategyVersion: '1.0.0',
  config: {},
  enabled: true,
  binanceMode: 'live',
  quoteAsset: 'USDT',
  benchmarkMode: 'btc',
  baselineBacktestRunId: null,
  createdAt: '2026-06-19T00:00:00.000Z',
  updatedAt: '2026-06-19T00:00:00.000Z',
};

const emptyArchive = { items: [], byIntent: [], bySource: [], nextCursor: null };
const emptyEquity = { profileId: PROFILE_ID, quoteAsset: 'USDT', benchmarkMode: 'btc', points: [] };
const EDGE_RUN_ID = '8a1b2c3d-4e5f-4a1b-9c2d-3e4f5a6b7c8d';
const edgeMetrics = {
  startingBalance: '1000',
  finalBalance: '1100',
  absoluteProfit: '100',
  totalReturnPct: 10,
  cagrPct: 0,
  marketChangePct: 5,
  dcaChangePct: 4,
  alphaVsHoldPct: 5,
  alphaVsDcaPct: 6,
  sharpe: 1,
  sortino: 1,
  calmar: 1,
  sqn: 1,
  maxDrawdownPct: -8,
  absoluteDrawdown: '80',
  drawdownStartMs: null,
  drawdownEndMs: null,
  totalTrades: 10,
  winRate: 60,
  wins: 6,
  losses: 4,
  profitFactor: 1.8,
  expectancy: '10',
  bestTradePct: 5,
  worstTradePct: -3,
  avgTradePnl: '10',
  avgTradeDurationMs: 3600000,
};

const stubFetch = (gate: GateStatusResponse): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/gate-status')) return jsonOf(gate);
      if (url.includes('/trade-archive')) return jsonOf(emptyArchive);
      if (url.includes('/equity-snapshots')) return jsonOf(emptyEquity);
      return jsonOf(profileBody);
    }),
  );
};

const stubEdgeFetch = (feeBasis: FeeBasis) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/gate-status'))
      return jsonOf({
        applicability: 'gated',
        ok: false,
        failure: 'thresholds',
        detail: 'the backtest does not clear the gate',
        halted: false,
      });
    if (url.includes('/trade-archive'))
      return jsonOf({
        items: [],
        byIntent: [],
        bySource: [
          {
            quoteAsset: 'USDT',
            source: 'manual',
            tradeCount: 12,
            wins: 3,
            losses: 9,
            profitSum: '-40',
            netProfit: '-40',
            grossProfit: '20',
            grossLoss: '60',
            totalFees: '1',
            feeBasis,
          },
        ],
        nextCursor: null,
      });
    if (url.includes('/equity-snapshots')) return jsonOf(emptyEquity);
    if (url.includes('/backtests/'))
      return jsonOf({
        runId: EDGE_RUN_ID,
        profileId: PROFILE_ID,
        status: 'done',
        progress: 100,
        createdAt: '2026-06-19T00:00:00.000Z',
        params: {
          symbols: ['BTCUSDT'],
          fromMs: 1,
          toMs: 2,
          strategyInterval: '1h',
          detailInterval: '5m',
          initialQuoteBalance: '1000',
          fees: { makerBps: 10, takerBps: 10 },
          slippageBps: 5,
          discoveryMode: false,
        },
        result: {
          params: {
            symbols: ['BTCUSDT'],
            fromMs: 1,
            toMs: 2,
            strategyInterval: '1h',
            detailInterval: '5m',
            initialQuoteBalance: '1000',
            fees: { makerBps: 10, takerBps: 10 },
            slippageBps: 5,
            discoveryMode: false,
          },
          metrics: edgeMetrics,
          equityCurve: [],
          drawdownSeries: [],
          trades: [],
          perSymbol: [],
        },
      });
    return jsonOf({ ...profileBody, baselineBacktestRunId: EDGE_RUN_ID });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

// The expanded strip renders LiveGateStatusCard, which links to the backtest
// workbench in the unproven state — so it needs a RouterProvider with that route.
const renderStrip = (): void => {
  const qc = createQueryClient();
  const root = createRootRoute({
    component: () => (
      <>
        <ProfileHealthStrip profileId={PROFILE_ID} />
        <Outlet />
      </>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/', component: () => null }),
      createRoute({
        getParentRoute: () => root,
        path: '/profiles/$profileId/backtest',
        component: () => null,
      }),
    ]),
    context: { queryClient: qc },
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
};

describe('ProfileHealthStrip', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders nothing for a not-live (testnet) profile', async () => {
    stubFetch({
      applicability: 'not-live',
      ok: true,
      failure: null,
      detail: 'testnet',
      halted: false,
    });
    renderStrip();
    await waitFor(() =>
      expect(screen.queryByTestId('profile-health-strip')).not.toBeInTheDocument(),
    );
  });

  it('shows the gate verdict as one line and expands to the full scorecards on click', async () => {
    stubFetch({
      applicability: 'gated',
      ok: false,
      failure: 'no-matching-backtest',
      detail: 'no recent backtest was run on the current configuration',
      halted: true,
    });
    renderStrip();

    const toggle = await screen.findByTestId('profile-health-strip-toggle');
    // The gate is advisory-only now: an unproven config reads "Unproven config."
    // (it never pauses buys), not the removed "New buys paused." halt copy.
    expect(toggle).toHaveTextContent('Unproven config.');
    // Detail cards are hidden until expanded.
    expect(screen.queryByTestId('live-gate-status-card')).toBeNull();

    await userEvent.click(toggle);

    expect(await screen.findByTestId('live-gate-status-card')).toBeInTheDocument();
    expect(screen.getByTestId('live-vs-backtest-card')).toBeInTheDocument();
  });

  it('overrides the gate headline when the live edge is breached (end-to-end via the hook)', async () => {
    stubEdgeFetch('exact');
    renderStrip();

    const toggle = await screen.findByTestId('profile-health-strip-toggle');
    // Once the edge query resolves to "breached", it outranks the warning gate.
    await waitFor(() => expect(toggle).toHaveTextContent('Edge below baseline.'));
    expect(toggle).not.toHaveTextContent('Unproven config.');
    // ...and the backtest CTA goes with it. A breached edge is not fixed by
    // re-running a backtest, so the headline it owns must not inherit that
    // action. This is the `tone !== 'down'` clause; without an assertion it can
    // be deleted with a green suite.
    expect(screen.queryByTestId('health-strip-run-backtest')).toBeNull();
  });

  it('keeps the gate headline when the same live edge has incomplete fee evidence', async () => {
    const fetchMock = stubEdgeFetch('unknown');
    renderStrip();

    const toggle = await screen.findByTestId('profile-health-strip-toggle');
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/backtests/'))).toBe(
        true,
      ),
    );
    expect(toggle).toHaveTextContent('Unproven config.');
    expect(toggle).not.toHaveTextContent('Edge below baseline.');
  });

  it('issues the edge verdict from a reconstructed fee total, matching the alert cron', async () => {
    // The middle tier is the one a two-state gate gets wrong, and the safe-looking direction is the wrong one. `edge-decay-monitor.cron.ts` abstains only on `unknown`, so withholding the screen verdict at `estimated` would hide a decay the Slack channel DOES alert on. Worse, it would hide it permanently on an account Binance bills in BNB, where every cycle's commission is reconstructed from the rate table and the tier is never `exact`. Pinned here because both sites read the same tier over the same rows and only their predicate differs, which is a one-token edit away from diverging again.
    stubEdgeFetch('estimated');
    renderStrip();

    const toggle = await screen.findByTestId('profile-health-strip-toggle');
    await waitFor(() => expect(toggle).toHaveTextContent('Edge below baseline.'));
    expect(toggle).not.toHaveTextContent('Unproven config.');
  });

  it('offers the backtest CTA on the collapsed line when the gate is merely unproven', async () => {
    // The defect this closes: the only link that performs the action the
    // headline recommends lived inside the collapsed detail, so the one line
    // naming an action offered no way to take it.
    stubFetch({
      applicability: 'gated',
      ok: false,
      failure: 'no-matching-backtest',
      detail: 'no recent backtest was run on the current configuration',
      halted: true,
    });
    renderStrip();

    const cta = await screen.findByTestId('health-strip-run-backtest');
    expect(cta).toHaveAttribute(
      'href',
      `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/backtest?view=configure`,
    );
    // Beside the toggle, not inside it: an anchor nested in a button is invalid.
    expect(cta.closest('button')).toBeNull();
  });

  it('withholds the CTA when the gate passes, there being nothing to re-prove', async () => {
    stubFetch({
      applicability: 'gated',
      ok: true,
      failure: null,
      detail: 'backtest matches the current configuration',
      halted: false,
    });
    renderStrip();
    await screen.findByTestId('profile-health-strip-toggle');
    expect(screen.queryByTestId('health-strip-run-backtest')).toBeNull();
  });
});
