import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GateVerdictSummary,
  describeBacktestCheck,
} from '@/features/profile/components/gate-verdict-summary';
import { createQueryClient } from '@/shared/lib/query-client';

const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';
const RUN_ID = '8a1b2c3d-4e5f-4a1b-9c2d-3e4f5a6b7c8d';
const PINNED_AT = '2026-10-10T03:00:00.000Z';

const jsonOf = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const profileBody = {
  id: PROFILE_ID,
  accountId: PROFILE_ID,
  name: 'P',
  strategyName: 'momentum',
  strategyVersion: '1.0.0',
  config: {},
  enabled: true,
  binanceMode: 'live',
  quoteAsset: 'USDT',
  benchmarkMode: 'btc',
  baselineBacktestRunId: RUN_ID,
  baselinePinnedAt: PINNED_AT,
  createdAt: '2026-06-19T00:00:00.000Z',
  updatedAt: '2026-06-19T00:00:00.000Z',
};

const archiveBody = {
  items: [],
  byIntent: [],
  bySource: [
    {
      quoteAsset: 'USDT',
      source: 'manual',
      tradeCount: 4,
      netTradeCount: 4,
      wins: 3,
      losses: 1,
      profitSum: '40',
      netProfit: '40',
      grossProfit: '60',
      grossLoss: '20',
      totalFees: '2',
      feeBasis: 'exact',
    },
  ],
  nextCursor: null,
  from: PINNED_AT,
  to: '2026-10-11T00:00:00.000Z',
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
    metrics: {
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
    },
    equityCurve: [],
    drawdownSeries: [],
    trades: [],
    perSymbol: [],
  },
};

const gateBody = {
  applicability: 'gated',
  ok: false,
  failure: 'thresholds',
  detail:
    'the backtest does not clear the gate — net profit factor 0.48 (need 1.3); trades 8 (need 30)',
  failedChecks: ['net profit factor 0.48 (need 1.3)', 'trades 8 (need 30)'],
};

describe('describeBacktestCheck', () => {
  it.each([
    { name: 'loading', data: undefined, headline: 'Backtest check: loading…', detail: null },
    {
      // A failed read also has no data; it must not read as loading forever.
      name: 'error',
      data: undefined,
      isError: true,
      headline: "Backtest check: couldn't load the gate status.",
      detail: null,
    },
    {
      name: 'not-live',
      data: { applicability: 'not-live', ok: false, failure: null, detail: '', failedChecks: [] },
      headline: 'Backtest check: applies to live accounts only, and this one is on testnet.',
      detail: null,
    },
    {
      name: 'gate-off',
      data: { applicability: 'gate-off', ok: false, failure: null, detail: '', failedChecks: [] },
      headline: 'Backtest check: off.',
      detail: null,
    },
    {
      name: 'ok',
      data: {
        applicability: 'gated',
        ok: true,
        failure: null,
        detail: 'current config is validated',
        failedChecks: [],
      },
      headline: 'Backtest check: cleared.',
      detail: null,
    },
    {
      // describeGateOutcome writes a lowercase clause with no full stop; it renders as its own sentence.
      name: 'stale',
      data: {
        applicability: 'gated',
        ok: false,
        failure: 'stale',
        detail: 'the matching backtest is 20 days old',
        failedChecks: [],
      },
      headline: 'Backtest check: not cleared.',
      detail: 'The matching backtest is 20 days old.',
    },
    {
      // Already a sentence: no second full stop.
      name: 'no-matching-backtest',
      data: {
        applicability: 'gated',
        ok: false,
        failure: 'no-matching-backtest',
        detail: 'No recent backtest was run.',
        failedChecks: [],
      },
      headline: 'Backtest check: not cleared.',
      detail: 'No recent backtest was run.',
    },
  ] as const)('$name', (row) => {
    const { data, headline, detail } = row;
    const check = describeBacktestCheck(data as never, 'isError' in row && row.isError);
    expect(check.headline).toBe(headline);
    expect(check.detail).toBe(detail);
    expect(check.failedChecks).toEqual([]);
  });

  it('counts and lists the failed checks from the server list, not the sentence', () => {
    const check = describeBacktestCheck(gateBody as never, false);
    expect(check.headline).toBe('Backtest check: not cleared, 2 checks below the bar.');
    expect(check.failedChecks).toEqual(gateBody.failedChecks);
    // The listed checks already say it; the joined sentence would repeat them.
    expect(check.detail).toBeNull();
    // A reworded sentence must not move the count.
    expect(describeBacktestCheck({ ...gateBody, detail: 'x' } as never, false).headline).toBe(
      'Backtest check: not cleared, 2 checks below the bar.',
    );
  });
});

/**
 * Renders the summary over a stubbed api.
 *
 * @param opts.profile - The profile body; defaults to one pinned at PINNED_AT.
 * @param opts.profileResponse - Replaces the profile response outright, for an error status or a read that never settles.
 * @param opts.archiveResponse - Replaces the archive response outright, for an error status.
 * @param opts.gate - The gate-status body.
 * @param opts.gateResponse - Replaces the gate-status response outright, for an error status.
 * @param opts.run - The pinned run detail body.
 * @returns The fetched URLs, in order.
 */
const renderSummary = (
  opts: {
    profile?: unknown;
    profileResponse?: () => Promise<Response>;
    archiveResponse?: () => Promise<Response>;
    gate?: unknown;
    gateResponse?: () => Promise<Response>;
    run?: unknown;
  } = {},
): string[] => {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/gate-status'))
        return opts.gateResponse ? opts.gateResponse() : jsonOf(opts.gate ?? gateBody);
      if (url.includes('/trade-archive'))
        return opts.archiveResponse ? opts.archiveResponse() : jsonOf(archiveBody);
      if (url.includes('/backtests/')) return jsonOf(opts.run ?? runDetailBody);
      return opts.profileResponse ? opts.profileResponse() : jsonOf(opts.profile ?? profileBody);
    }),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <GateVerdictSummary profileId={PROFILE_ID} />
    </QueryClientProvider>,
  );
  return urls;
};

describe('GateVerdictSummary', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('states the check and what live results are compared with, windowed at the pin', async () => {
    const urls = renderSummary();

    await waitFor(() =>
      expect(screen.getByTestId('gate-verdict-check')).toHaveTextContent(
        'Backtest check: not cleared, 2 checks below the bar.',
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('gate-verdict-edge')).toHaveTextContent(
        /^Live vs backtest: comparing 4 trades recorded since you pinned this baseline on .*2026.* with run 8a1b2c3d \(profit factor 1\.80\)\.$/,
      ),
    );
    const archiveUrl = urls.find((u) => u.includes('/trade-archive')) as string;
    expect(new URL(archiveUrl, 'http://localhost').searchParams.get('from')).toBe(PINNED_AT);
  });

  it('renders a non-threshold failure detail once, as a sentence', async () => {
    renderSummary({
      gate: {
        applicability: 'gated',
        ok: false,
        failure: 'stale',
        detail: 'the matching backtest is 20 days old',
        failedChecks: [],
      },
    });
    expect(await screen.findByText('The matching backtest is 20 days old.')).toBeInTheDocument();
  });

  it('says no baseline is pinned once the profile has loaded without one', async () => {
    renderSummary({
      profile: { ...profileBody, baselineBacktestRunId: null, baselinePinnedAt: null },
    });
    await waitFor(() =>
      expect(screen.getByTestId('gate-verdict-edge')).toHaveTextContent(
        /^Live vs backtest: no baseline pinned\./,
      ),
    );
  });

  it('says "from all time" for a baseline pinned before pin times were recorded, with an infinite profit factor', async () => {
    renderSummary({
      profile: { ...profileBody, baselinePinnedAt: null },
      run: {
        ...runDetailBody,
        result: {
          ...runDetailBody.result,
          metrics: { ...runDetailBody.result.metrics, profitFactor: null },
        },
      },
    });
    await waitFor(() =>
      expect(screen.getByTestId('gate-verdict-edge')).toHaveTextContent(
        'Live vs backtest: comparing 4 trades from all time with run 8a1b2c3d (profit factor ∞).',
      ),
    );
  });

  it('shows a placeholder, not "no baseline pinned", while the profile is still loading', async () => {
    renderSummary({ profileResponse: () => new Promise<Response>(() => {}) });
    await waitFor(() =>
      expect(screen.getByTestId('gate-verdict-check')).toHaveTextContent(/not cleared/),
    );
    expect(screen.queryByTestId('gate-verdict-edge')).not.toBeInTheDocument();
    expect(
      screen.getByTestId('gate-verdict-summary').querySelector('[data-skeleton-bar]'),
    ).not.toBeNull();
  });

  it("says it couldn't load the profile instead of claiming no baseline", async () => {
    // 503 is the one status the client never retries, so the error lands inside the wait window.
    renderSummary({ profileResponse: async () => new Response('down', { status: 503 }) });
    await waitFor(() =>
      expect(screen.getByTestId('gate-verdict-edge')).toHaveTextContent(
        "Live vs backtest: couldn't load this profile.",
      ),
    );
    expect(screen.queryByText(/no baseline pinned/)).not.toBeInTheDocument();
  });

  it("says the gate status couldn't load instead of loading forever", async () => {
    // 503 is the one status the client never retries, so the error lands inside the wait window.
    renderSummary({ gateResponse: async () => new Response('down', { status: 503 }) });
    await waitFor(() =>
      expect(screen.getByTestId('gate-verdict-check')).toHaveTextContent(
        "Backtest check: couldn't load the gate status.",
      ),
    );
  });

  it("says the live trades couldn't load rather than comparing 0 trades", async () => {
    renderSummary({ archiveResponse: async () => new Response('down', { status: 503 }) });
    await waitFor(() =>
      expect(screen.getByTestId('gate-verdict-edge')).toHaveTextContent(
        "Live vs backtest: couldn't load this profile's live trades.",
      ),
    );
    // An archive that never loaded is no sample, so no verdict may state "0 live trades".
    expect(screen.queryByTestId('gate-verdict-edge-detail')).not.toBeInTheDocument();
  });

  it('drops the verdict when a later archive refetch fails, not only the first read', async () => {
    let archiveDown = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/gate-status')) return jsonOf(gateBody);
        if (url.includes('/trade-archive'))
          return archiveDown ? new Response('down', { status: 503 }) : jsonOf(archiveBody);
        if (url.includes('/backtests/')) return jsonOf(runDetailBody);
        return jsonOf(profileBody);
      }),
    );
    const client = createQueryClient();
    render(
      <QueryClientProvider client={client}>
        <GateVerdictSummary profileId={PROFILE_ID} />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('gate-verdict-edge-detail')).toBeInTheDocument();
    // A failed refetch keeps the last good data, so the old verdict would otherwise sit under the "couldn't load" line.
    archiveDown = true;
    await act(() => client.refetchQueries());
    await waitFor(() =>
      expect(screen.getByTestId('gate-verdict-edge')).toHaveTextContent(
        "Live vs backtest: couldn't load this profile's live trades.",
      ),
    );
    expect(screen.queryByTestId('gate-verdict-edge-detail')).not.toBeInTheDocument();
  });
});
