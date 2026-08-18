import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LiveVsBacktestCard } from '@/features/dashboard/components/live-vs-backtest-card';
import { createQueryClient } from '@/shared/lib/query-client';

const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';
const RUN_ID = '8a1b2c3d-4e5f-4a1b-9c2d-3e4f5a6b7c8d';

const jsonOf = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const profileBody = (baselineBacktestRunId: string | null) => ({
  id: PROFILE_ID,
  accountId: PROFILE_ID,
  name: 'P',
  strategyName: 'trailing-trade',
  strategyVersion: '1.0.0',
  config: {},
  enabled: false,
  binanceMode: 'test',
  quoteAsset: 'USDT',
  benchmarkMode: 'btc',
  baselineBacktestRunId,
  createdAt: '2026-06-19T00:00:00.000Z',
  updatedAt: '2026-06-19T00:00:00.000Z',
});

// bySource bucket: 4 trades, 3 wins, gross +60 / -20 → PF 3.0, win 75%.
const archiveBody = {
  items: [],
  byIntent: [],
  bySource: [
    {
      quoteAsset: 'USDT',
      source: 'manual',
      tradeCount: 4,
      wins: 3,
      losses: 1,
      profitSum: '40',
      netProfit: '40',
      grossProfit: '60',
      grossLoss: '20',
      totalFees: '2',
    },
  ],
  nextCursor: null,
};

const equityBody = {
  profileId: PROFILE_ID,
  quoteAsset: 'USDT',
  benchmarkMode: 'btc',
  points: [
    {
      capturedAt: '2026-06-19T00:00:00.000Z',
      netPnlQuote: '0',
      realizedNetQuote: '0',
      positionValueQuote: '0',
      positionCostQuote: '100',
      benchmarkAsset: 'BTC',
      benchmarkPriceQuote: '100',
    },
    {
      capturedAt: '2026-06-19T01:00:00.000Z',
      netPnlQuote: '30',
      realizedNetQuote: '30',
      positionValueQuote: '0',
      positionCostQuote: '100',
      benchmarkAsset: 'BTC',
      benchmarkPriceQuote: '100',
    },
    {
      capturedAt: '2026-06-19T02:00:00.000Z',
      netPnlQuote: '10',
      realizedNetQuote: '10',
      positionValueQuote: '0',
      positionCostQuote: '100',
      benchmarkAsset: 'BTC',
      benchmarkPriceQuote: '100',
    },
  ],
};

const metrics = {
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

const paramsBody = {
  symbols: ['BTCUSDT'],
  fromMs: 1,
  toMs: 2,
  strategyInterval: '1h',
  detailInterval: '5m',
  initialQuoteBalance: '1000',
  fees: { makerBps: 10, takerBps: 10 },
  slippageBps: 5,
  discoveryMode: false,
};

const runDetailBody = {
  runId: RUN_ID,
  profileId: PROFILE_ID,
  status: 'done',
  progress: 100,
  createdAt: '2026-06-19T00:00:00.000Z',
  params: paramsBody,
  result: {
    params: paramsBody,
    metrics,
    equityCurve: [],
    drawdownSeries: [],
    trades: [],
    perSymbol: [],
  },
};

const renderCard = (baselineRunId: string | null): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/equity-snapshots')) return jsonOf(equityBody);
      if (url.includes('/trade-archive')) return jsonOf(archiveBody);
      if (url.includes('/backtests/')) return jsonOf(runDetailBody);
      return jsonOf(profileBody(baselineRunId));
    }),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <LiveVsBacktestCard profileId={PROFILE_ID} />
    </QueryClientProvider>,
  );
};

describe('LiveVsBacktestCard', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks the archive for the rollup only, not a page of trades it never renders', async () => {
    // This card and the edge-verdict badge beside it both read one field, `bySource`, over all time — and both poll it every 60s. The all-time archive page they ask for also builds a page of rows, a recoverable-coin scan and an unreconstructable-coin scan, none of which reach this render. The request has to say what it wants, or the server has no way to serve less.
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.includes('/equity-snapshots')) return jsonOf(equityBody);
        if (url.includes('/trade-archive')) return jsonOf(archiveBody);
        if (url.includes('/backtests/')) return jsonOf(runDetailBody);
        return jsonOf(profileBody(null));
      }),
    );
    render(
      <QueryClientProvider client={createQueryClient()}>
        <LiveVsBacktestCard profileId={PROFILE_ID} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(urls.some((u) => u.includes('/trade-archive'))).toBe(true));
    const archiveUrl = urls.find((u) => u.includes('/trade-archive')) as string;
    expect(new URL(archiveUrl, 'http://localhost').searchParams.get('view')).toBe('rollup');
  });

  it('shows live win-rate / profit-factor / max-drawdown and a pin hint when no baseline is set', async () => {
    renderCard(null);
    // Win 75% (3/4), PF 3.00 (60/20).
    await waitFor(() => expect(screen.getByText('75.00%')).toBeInTheDocument());
    expect(screen.getByText('3.00')).toBeInTheDocument();
    expect(screen.getByText(/Pin a finished backtest/)).toBeInTheDocument();
  });

  it('compares live win-rate (with a delta) and profit factor (side by side) against the pinned backtest', async () => {
    renderCard(RUN_ID);
    // Backtest win 60% → live 75% (+15pp); PF 1.80 → 3.00 shown without a delta.
    await waitFor(() => expect(screen.getByText(/vs pinned backtest/i)).toBeInTheDocument());
    expect(screen.getByText('(+15%)')).toBeInTheDocument();
    expect(screen.getByText('1.80 → 3.00')).toBeInTheDocument();
    // PF must NOT carry a misleading ratio-difference delta.
    expect(screen.queryByText('(+1.20)')).toBeNull();
  });

  it('surfaces a terminal notice when the pinned baseline run cannot be read', async () => {
    // A failed read must not sit on a pulsing skeleton forever: nothing is in
    // flight, so a placeholder there would claim data that never arrives.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/equity-snapshots')) return jsonOf(equityBody);
        if (url.includes('/trade-archive')) return jsonOf(archiveBody);
        if (url.includes('/backtests/')) return new Response('boom', { status: 500 });
        return jsonOf(profileBody(RUN_ID));
      }),
    );
    render(
      // Retries would keep the query pending past the assertion window.
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <LiveVsBacktestCard profileId={PROFILE_ID} />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText(/Couldn't load the pinned backtest baseline/i)).toBeInTheDocument(),
    );
    expect(document.querySelectorAll('[data-skeleton-bar]')).toHaveLength(0);
  });

  it('says the pinned run has no result yet rather than pulsing forever', async () => {
    // Pinned, fetched, still queued or running: terminal for this render.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/equity-snapshots')) return jsonOf(equityBody);
        if (url.includes('/trade-archive')) return jsonOf(archiveBody);
        if (url.includes('/backtests/'))
          return jsonOf({ ...runDetailBody, status: 'running', progress: 40, result: null });
        return jsonOf(profileBody(RUN_ID));
      }),
    );
    render(
      <QueryClientProvider client={createQueryClient()}>
        <LiveVsBacktestCard profileId={PROFILE_ID} />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText(/pinned backtest has no result yet/i)).toBeInTheDocument(),
    );
    expect(document.querySelectorAll('[data-skeleton-bar]')).toHaveLength(0);
  });

  it('shows an edge-weakening badge when live profit factor decays below the baseline', async () => {
    // 12 trades, gross +60 / -50 → live PF 1.20; baseline PF 1.80 → warn<1.53,
    // breach<1.08, so 1.20 lands in the warning band (default warn mode).
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/equity-snapshots')) return jsonOf(equityBody);
        if (url.includes('/trade-archive'))
          return jsonOf({
            items: [],
            byIntent: [],
            bySource: [
              {
                quoteAsset: 'USDT',
                source: 'manual',
                tradeCount: 12,
                wins: 7,
                losses: 5,
                profitSum: '10',
                netProfit: '10',
                grossProfit: '60',
                grossLoss: '50',
                totalFees: '1',
              },
            ],
            nextCursor: null,
          });
        if (url.includes('/backtests/')) return jsonOf(runDetailBody);
        return jsonOf(profileBody(RUN_ID));
      }),
    );
    render(
      <QueryClientProvider client={createQueryClient()}>
        <LiveVsBacktestCard profileId={PROFILE_ID} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('edge-decay-badge')).toBeInTheDocument());
    expect(screen.getByTestId('edge-decay-badge')).toHaveTextContent(/Edge weakening/);
  });

  it('shows an empty state when there are no closed trades', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/equity-snapshots')) return jsonOf(equityBody);
        if (url.includes('/trade-archive'))
          return jsonOf({ items: [], byIntent: [], bySource: [], nextCursor: null });
        return jsonOf(profileBody(null));
      }),
    );
    render(
      <QueryClientProvider client={createQueryClient()}>
        <LiveVsBacktestCard profileId={PROFILE_ID} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText(/No closed trades yet/)).toBeInTheDocument());
    expect(screen.queryByText('Win rate')).toBeNull();
  });
});
