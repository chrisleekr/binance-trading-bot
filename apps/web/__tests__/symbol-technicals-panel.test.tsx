// SymbolTechnicalsPanel — happy path, no-signal-yet state, staleness pill,
// and the multi-interval tab strip.

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  findHealthForInterval,
  SymbolTechnicalsPanel,
} from '../src/features/symbol/components/symbol-technicals-panel.js';
import { createQueryClient } from '../src/shared/lib/query-client.js';

import type { TechnicalsFetchStatus } from '@app/contracts';

const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';
// Matches the global test-setup default active account; the config link is built
// account-nested from useActiveAccountId.
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const SYMBOL = 'BTCUSDT';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const intervalRow = (interval: string, overrides?: Record<string, unknown>) => ({
  interval,
  whenStrongBuy: true,
  whenBuy: true,
  whenSell: false,
  whenStrongSell: false,
  whenNeutral: false,
  ...overrides,
});

const tvBlock = (
  useOnlyWithinMin = 2,
  ifExpires: 'do-not-buy' | 'allow-anyway' = 'do-not-buy',
) => ({
  useOnlyWithinMin,
  ifExpires,
  intervals: [intervalRow('1m')],
});

const setUp = (
  responder: (url: string) => Response,
  clock: () => number = () => 1_000_000,
): void => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  // Minimal router so the panel's `<Link>` children (heading and the
  // no-intervals empty-state link) have the router context they require.
  // The symbol and config routes resolve href values; navigation itself
  // is not exercised here.
  const rootRoute = createRootRoute();
  const panelRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/profiles/$profileId/symbols/$symbol',
    component: () => <SymbolTechnicalsPanel profileId={PROFILE_ID} symbol={SYMBOL} clock={clock} />,
  });
  const configRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/profiles/$profileId/config',
    component: () => <div>config</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([panelRoute, configRoute]),
    history: createMemoryHistory({
      initialEntries: [`/profiles/${PROFILE_ID}/symbols/${SYMBOL}`],
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

afterEach(() => {
  vi.unstubAllGlobals();
});

// The pure `formatStaleness` assertions moved to format-time.test.ts (folded
// into the `humaniseAge` suite that replaced it). The rendered-output coverage
// below still exercises the staleness string end-to-end.

describe('SymbolTechnicalsPanel', () => {
  const oscillators = {
    rsi: 56.4,
    stochK: 80,
    stochD: 75,
    cci20: 110,
    adx: 22,
    adxPlusDi: 25,
    adxMinusDi: 15,
    ao: 12,
    mom: 30,
    macdMacd: 5,
    macdSignal: 4,
    stochRsiK: 60,
    wr: -20,
    bbPower: 8,
    uo: 55,
  };
  const movingAverages = {
    ema5: 100,
    ema10: 101,
    ema20: 102,
    ema30: 103,
    ema50: 104,
    ema100: 105,
    ema200: 106,
    sma5: 107,
    sma10: 108,
    sma20: 109,
    sma30: 110,
    sma50: 111,
    sma100: 112,
    sma200: 113,
    vwma: 114,
    hullMa9: 115,
    ichimokuBLine: 116,
  };

  const richSignal = {
    symbol: 'BTCUSDT',
    recommendation: 'STRONG_BUY' as const,
    maRecommendation: 'BUY' as const,
    oscRecommendation: 'NEUTRAL' as const,
    receivedAtMs: 999_500,
    indicators: { oscillators, movingAverages },
  };

  it('renders the three verdict gauges and the indicator groups', async () => {
    setUp(
      () =>
        json({
          items: [{ symbol: 'BTCUSDT', signals: [{ interval: '1m', signal: richSignal }] }],
          fetchedAt: '2026-05-10T12:00:00.000Z',
          technicals: tvBlock(),
        }),
      () => 1_000_000,
    );
    await waitFor(() =>
      expect(screen.getByTestId('symbol-tv-recommendation')).toHaveTextContent('Strong buy'),
    );
    expect(screen.getByTestId('symbol-tv-ma-recommendation')).toHaveTextContent('Buy');
    expect(screen.getByTestId('symbol-tv-osc-recommendation')).toHaveTextContent('Neutral');
    // Indicator readings are collapsed by default (iter48); expand to assert
    // the cells render correctly.
    act(() => {
      screen.getByTestId('symbol-tv-indicators-toggle').click();
    });
    expect(screen.getByTestId('tv-indicator-rsi')).toHaveTextContent('56.4');
    expect(screen.getByTestId('tv-indicator-ema200')).toHaveTextContent('106');
    // Each raw indicator name carries a plain-language gloss rendered inline
    // beneath it (visible on mobile/touch, not a hover-only title attribute).
    expect(screen.getByText(/Relative Strength Index/)).toBeInTheDocument();
    expect(screen.getByText(/Hull Moving Average/)).toBeInTheDocument();
    // Operator-trust: cross-checking raw long-MA values against TradingView's
    // full history is expected to diverge slightly, so the compare link's
    // tooltip discloses the recent-candle window (#405).
    expect(screen.getByTestId('symbol-tv-external-link')).toHaveAttribute(
      'title',
      // Pin the load-bearing clauses, not just a fragment, so a future copy
      // edit cannot silently drop the indicator-specific disclosure (#405).
      expect.stringMatching(/EMA\/SMA 100 and 200.*recent-candle window.*signal still matches/s),
    );
    expect(screen.getByTestId('symbol-technicals-staleness')).toHaveTextContent('0s ago');
    // Single-interval profiles keep the compact layout — no tab strip.
    expect(screen.queryByTestId('symbol-tv-interval-tabs')).toBeNull();
  });

  it('renders gauges as em-dashes and omits indicator groups when the signal is thin', async () => {
    setUp(() =>
      json({
        items: [
          {
            symbol: 'BTCUSDT',
            signals: [
              {
                interval: '1m',
                signal: {
                  symbol: 'BTCUSDT',
                  recommendation: 'SELL',
                  maRecommendation: null,
                  oscRecommendation: null,
                  receivedAtMs: 999_500,
                  indicators: null,
                },
              },
            ],
          },
        ],
        fetchedAt: '2026-05-10T12:00:00.000Z',
        technicals: tvBlock(),
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('symbol-tv-recommendation')).toHaveTextContent('Sell'),
    );
    expect(screen.getByTestId('symbol-tv-ma-recommendation')).toHaveTextContent('—');
    expect(screen.queryByTestId('tv-indicator-rsi')).toBeNull();
  });

  it('shows the empty state with the polling-cadence hint when the interval has no signal yet', async () => {
    setUp(() =>
      json({
        items: [{ symbol: 'BTCUSDT', signals: [{ interval: '1m', signal: null }] }],
        fetchedAt: '2026-05-10T12:00:00.000Z',
        technicals: tvBlock(),
      }),
    );
    await waitFor(() => expect(screen.getByTestId('symbol-tv-empty')).toBeInTheDocument());
    expect(screen.getByTestId('symbol-tv-empty')).toHaveTextContent(
      /re-reads the cache every 15s/i,
    );
  });

  it('flags a stale signal when older than the gate freshness window', async () => {
    setUp(
      () =>
        json({
          items: [
            {
              symbol: 'BTCUSDT',
              signals: [
                {
                  interval: '1m',
                  signal: {
                    symbol: 'BTCUSDT',
                    recommendation: 'STRONG_BUY',
                    maRecommendation: null,
                    oscRecommendation: null,
                    receivedAtMs: 0,
                    indicators: null,
                  },
                },
              ],
            },
          ],
          fetchedAt: '2026-05-10T12:00:00.000Z',
          technicals: tvBlock(),
        }),
      () => 3 * 60_000,
    );
    await waitFor(() =>
      expect(screen.getByTestId('symbol-technicals-staleness')).toHaveTextContent(
        /stale \(> 2 min; buy vetoed; force-sell also paused\)/i,
      ),
    );
    expect(screen.getByTestId('symbol-technicals-staleness')).toHaveTextContent('3m ago');
  });

  it('renders the operator-configured freshness window in the stale pill', async () => {
    setUp(
      () =>
        json({
          items: [
            {
              symbol: 'BTCUSDT',
              signals: [
                {
                  interval: '1m',
                  signal: {
                    symbol: 'BTCUSDT',
                    recommendation: 'STRONG_BUY',
                    maRecommendation: null,
                    oscRecommendation: null,
                    receivedAtMs: 0,
                    indicators: null,
                  },
                },
              ],
            },
          ],
          fetchedAt: '2026-05-10T12:00:00.000Z',
          technicals: tvBlock(5, 'allow-anyway'),
        }),
      () => 6 * 60_000,
    );
    await waitFor(() =>
      expect(screen.getByTestId('symbol-technicals-staleness')).toHaveTextContent(
        /stale \(> 5 min; buy still allowed; force-sell also paused\)/i,
      ),
    );
  });

  it('treats a signal at exactly the freshness window as fresh', async () => {
    setUp(
      () =>
        json({
          items: [
            {
              symbol: 'BTCUSDT',
              signals: [
                {
                  interval: '1m',
                  signal: {
                    symbol: 'BTCUSDT',
                    recommendation: 'STRONG_BUY',
                    maRecommendation: null,
                    oscRecommendation: null,
                    receivedAtMs: 0,
                    indicators: null,
                  },
                },
              ],
            },
          ],
          fetchedAt: '2026-05-10T12:00:00.000Z',
          technicals: tvBlock(),
        }),
      () => 2 * 60_000,
    );
    await waitFor(() =>
      expect(screen.getByTestId('symbol-technicals-staleness')).toHaveTextContent('2m ago'),
    );
    expect(screen.getByTestId('symbol-technicals-staleness')).not.toHaveTextContent(/stale/i);
  });

  it('shows the empty state when the symbol is not in the response', async () => {
    setUp(() =>
      json({
        items: [],
        fetchedAt: '2026-05-10T12:00:00.000Z',
        technicals: tvBlock(),
      }),
    );
    await waitFor(() => expect(screen.getByTestId('symbol-tv-empty')).toBeInTheDocument());
  });

  it('renders error banner when the API fails', async () => {
    setUp(
      () =>
        new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await waitFor(() => expect(screen.getByText(/Technicals unavailable/)).toBeInTheDocument());
  });

  it('renders a tab strip when the profile configures more than one interval', async () => {
    setUp(() =>
      json({
        items: [
          {
            symbol: 'BTCUSDT',
            signals: [
              {
                interval: '5m',
                signal: { ...richSignal, recommendation: 'BUY' },
              },
              {
                interval: '1h',
                signal: { ...richSignal, recommendation: 'STRONG_SELL' },
              },
            ],
          },
        ],
        fetchedAt: '2026-05-10T12:00:00.000Z',
        technicals: {
          useOnlyWithinMin: 2,
          ifExpires: 'do-not-buy',
          intervals: [intervalRow('5m'), intervalRow('1h', { whenStrongSell: true })],
        },
      }),
    );
    await waitFor(() => expect(screen.getByTestId('symbol-tv-interval-tabs')).toBeInTheDocument());
    // The first interval is active by default — its signal drives the
    // Summary gauge.
    expect(screen.getByTestId('symbol-tv-recommendation')).toHaveTextContent('Buy');
    expect(screen.getByTestId('symbol-tv-interval-tab-5m')).toBeInTheDocument();
    expect(screen.getByTestId('symbol-tv-interval-tab-1h')).toBeInTheDocument();
    // Compact short codes keep the strip scannable — full label goes to
    // screen readers via aria-label so SR users hear "Strong sell".
    expect(screen.getByTestId('symbol-tv-interval-tab-verdict-5m')).toHaveTextContent('B');
    expect(screen.getByTestId('symbol-tv-interval-tab-verdict-1h')).toHaveTextContent('SS');
    expect(screen.getByTestId('symbol-tv-interval-tab-5m')).toHaveAttribute(
      'aria-label',
      '5m: Buy',
    );
    expect(screen.getByTestId('symbol-tv-interval-tab-1h')).toHaveAttribute(
      'aria-label',
      '1h: Strong sell',
    );
  });

  it('hides the interval chip strip for a single-interval profile', async () => {
    setUp(() =>
      json({
        items: [
          {
            symbol: 'BTCUSDT',
            signals: [{ interval: '5m', signal: { ...richSignal, recommendation: 'BUY' } }],
          },
        ],
        fetchedAt: '2026-05-10T12:00:00.000Z',
        technicals: {
          useOnlyWithinMin: 2,
          ifExpires: 'do-not-buy',
          intervals: [intervalRow('5m')],
        },
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('symbol-tv-recommendation')).toHaveTextContent('Buy'),
    );
    expect(screen.queryByTestId('symbol-tv-interval-tabs')).toBeNull();
  });

  it.each([
    ['STRONG_BUY', 'SB', 'Strong buy'],
    ['BUY', 'B', 'Buy'],
    ['NEUTRAL', 'N', 'Neutral'],
    ['SELL', 'S', 'Sell'],
    ['STRONG_SELL', 'SS', 'Strong sell'],
  ] as const)(
    'chip renders short code %s → "%s" with verbose aria-label "%s"',
    async (rec, short, long) => {
      setUp(() =>
        json({
          items: [
            {
              symbol: 'BTCUSDT',
              signals: [
                { interval: '5m', signal: { ...richSignal, recommendation: rec } },
                { interval: '1h', signal: { ...richSignal, recommendation: 'NEUTRAL' } },
              ],
            },
          ],
          fetchedAt: '2026-05-10T12:00:00.000Z',
          technicals: {
            useOnlyWithinMin: 2,
            ifExpires: 'do-not-buy',
            intervals: [intervalRow('5m'), intervalRow('1h')],
          },
        }),
      );
      await waitFor(() =>
        expect(screen.getByTestId('symbol-tv-interval-tab-verdict-5m')).toHaveTextContent(short),
      );
      expect(screen.getByTestId('symbol-tv-interval-tab-5m')).toHaveAttribute(
        'aria-label',
        `5m: ${long}`,
      );
    },
  );

  // Outage-clarity surfaces (iter46). When the Technicals compute job is
  // failing the panel should not pretend it is "waiting for the first
  // fetch" — it should name the upstream condition. Multi-URL responder
  // so the health endpoint can ship its own payload.
  const multiResponder =
    (recsBody: unknown, healthBody?: unknown) =>
    (url: string): Response => {
      if (url.includes('/technicals/health')) {
        return json(healthBody ?? { intervals: [] });
      }
      return json(recsBody);
    };

  const healthRow = (
    interval: string,
    error: string | null,
    lastFreshAtMs: number | null = null,
  ): TechnicalsFetchStatus => ({
    interval,
    fetchedAtMs: 1_000_000,
    requested: 1,
    written: error ? 0 : 1,
    skippedErrored: error ? 1 : 0,
    skippedInvalid: 0,
    latencyMs: 10,
    lastFreshAtMs,
    error,
  });

  it('renders the Technicals heading as a link to the profile config', async () => {
    setUp(
      multiResponder(
        {
          items: [{ symbol: 'BTCUSDT', signals: [{ interval: '1m', signal: null }] }],
          fetchedAt: '2026-05-10T12:00:00.000Z',
          technicals: tvBlock(),
        },
        { intervals: [healthRow('1m', null)] },
      ),
    );
    const link = await screen.findByTestId('symbol-tv-heading-link');
    // TanStack `<Link>` renders an `<a>`. The href carries the profile id
    // so an operator can deep-link from the panel to the config gate.
    expect(link).toHaveAttribute('href', expect.stringContaining(`/profiles/${PROFILE_ID}/config`));
    expect(link).toHaveTextContent('Technicals');
  });

  it('exposes a refresh button with an aria-label and a tooltip explaining the poll cadence', async () => {
    setUp(
      multiResponder(
        {
          items: [{ symbol: 'BTCUSDT', signals: [{ interval: '1m', signal: null }] }],
          fetchedAt: '2026-05-10T12:00:00.000Z',
          technicals: tvBlock(),
        },
        { intervals: [healthRow('1m', null)] },
      ),
    );
    const btn = await screen.findByTestId('symbol-tv-refresh');
    expect(btn).toHaveAttribute('aria-label', 'Refresh Technicals signal and compute-job health');
    expect(btn).toHaveAttribute('title', expect.stringMatching(/Refresh now/));
    // Click does not throw — the actual refetch wiring is exercised by the
    // live browser walk (vitest's fetch-mock + TanStack Query interaction
    // suppresses the post-refetch dispatch). Smoke-checking the click is
    // enough to guard against the button being unwired by a future change.
    act(() => {
      btn.click();
    });
  });

  it('exposes a screen-reader live region for manual refresh outcomes', async () => {
    setUp(
      multiResponder(
        {
          items: [{ symbol: 'BTCUSDT', signals: [{ interval: '1m', signal: null }] }],
          fetchedAt: '2026-05-10T12:00:00.000Z',
          technicals: tvBlock(),
        },
        { intervals: [healthRow('1m', null)] },
      ),
    );
    const live = await screen.findByTestId('symbol-tv-refresh-announce');
    // role + aria-live = the SR contract; polite (not assertive) so the
    // announcement does not interrupt the operator's current focus.
    expect(live).toHaveAttribute('role', 'status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    // Initially empty so the SR is silent on first paint — the region only
    // speaks after an operator-driven refresh resolves.
    expect(live).toHaveTextContent('');
  });

  it('renders an expiry countdown on a passing buy-gate within 60s of staleness (iter59)', async () => {
    const nowMs = 1_000_000;
    // Signal received 90s ago, window is 2 min — expires in 30s.
    const recentSignal = {
      symbol: 'BTCUSDT',
      recommendation: 'BUY' as const,
      maRecommendation: 'BUY' as const,
      oscRecommendation: 'BUY' as const,
      receivedAtMs: nowMs - 90_000,
      indicators: { oscillators, movingAverages },
    };
    setUp(
      multiResponder({
        items: [{ symbol: 'BTCUSDT', signals: [{ interval: '1m', signal: recentSignal }] }],
        fetchedAt: '2026-05-10T12:00:00.000Z',
        technicals: tvBlock(),
      }),
      () => nowMs,
    );
    await waitFor(() => {
      expect(screen.getByTestId('symbol-technicals-gate-status')).toHaveTextContent(
        /Buy gate: PASSES \(Buy · expires 30s\)/,
      );
    });
  });

  it('replaces the empty-body cadence hint with the compute health label when the interval is failing', async () => {
    setUp(
      multiResponder(
        {
          items: [{ symbol: 'BTCUSDT', signals: [{ interval: '1m', signal: null }] }],
          fetchedAt: '2026-05-10T12:00:00.000Z',
          technicals: tvBlock(),
        },
        {
          intervals: [healthRow('1m', 'Binance klines: HTTP 429')],
        },
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('symbol-tv-empty-health')).toHaveTextContent(
        /binance rate-limited/,
      ),
    );
    expect(screen.getByTestId('symbol-tv-empty')).toHaveTextContent(/Compute reports/);
    expect(screen.getByTestId('symbol-tv-empty')).not.toHaveTextContent(
      /re-reads the cache every 15s/i,
    );
    // Health row has `lastFreshAtMs: null` (the default in this fixture) — the
    // body distinguishes a brand-new outage from a long-running one.
    expect(screen.getByTestId('symbol-tv-empty-health')).toHaveTextContent(
      /no successful fetch yet/,
    );
  });

  it('exposes a screen-reader-friendly aria-label on each interval tab', async () => {
    setUp(
      multiResponder(
        {
          items: [
            {
              symbol: 'BTCUSDT',
              signals: [
                { interval: '5m', signal: null },
                { interval: '1h', signal: null },
              ],
            },
          ],
          fetchedAt: '2026-05-10T12:00:00.000Z',
          technicals: {
            useOnlyWithinMin: 2,
            ifExpires: 'do-not-buy',
            intervals: [intervalRow('5m'), intervalRow('1h')],
          },
        },
        {
          intervals: [
            healthRow('5m', 'Binance klines: HTTP 429'),
            healthRow('1h', 'Binance klines: HTTP 429'),
          ],
        },
      ),
    );
    // Without an explicit aria-label, `getByRole('tab').textContent` reads the
    // two flexbox-margin siblings concatenated — "5mbinance rate-limited" —
    // which is what a screen reader announces. The explicit aria-label fixes
    // the gap.
    await waitFor(() =>
      expect(screen.getByTestId('symbol-tv-interval-tab-5m')).toHaveAttribute(
        'aria-label',
        '5m: binance rate-limited',
      ),
    );
    expect(screen.getByTestId('symbol-tv-interval-tab-1h')).toHaveAttribute(
      'aria-label',
      '1h: binance rate-limited',
    );
  });

  it('labels tab verdicts with the friendly health error when no signal exists', async () => {
    setUp(
      multiResponder(
        {
          items: [
            {
              symbol: 'BTCUSDT',
              signals: [
                { interval: '5m', signal: null },
                { interval: '1h', signal: null },
              ],
            },
          ],
          fetchedAt: '2026-05-10T12:00:00.000Z',
          technicals: {
            useOnlyWithinMin: 2,
            ifExpires: 'do-not-buy',
            intervals: [intervalRow('5m'), intervalRow('1h')],
          },
        },
        {
          intervals: [healthRow('5m', 'Binance klines: HTTP 429'), healthRow('1h', null)],
        },
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('symbol-tv-interval-tab-verdict-5m')).toHaveTextContent(
        'binance rate-limited',
      ),
    );
    // No health error on 1h → "no signal" placeholder instead of a friendly
    // outage label so the operator can tell the two states apart.
    expect(screen.getByTestId('symbol-tv-interval-tab-verdict-1h')).toHaveTextContent('no signal');
  });

  it('surfaces healthy-compute "waiting for next cron tick" diagnostic when compute is clean but lastFreshAtMs known', async () => {
    setUp(
      multiResponder(
        {
          items: [{ symbol: 'BTCUSDT', signals: [{ interval: '1m', signal: null }] }],
          fetchedAt: '2026-05-10T12:00:00.000Z',
          technicals: tvBlock(),
        },
        {
          intervals: [healthRow('1m', null, 1_000_000 - 90_000)],
        },
      ),
      () => 1_000_000,
    );
    await waitFor(() =>
      expect(screen.getByTestId('symbol-tv-empty-fresh')).toHaveTextContent(
        /Compute is healthy \(last fresh 1m ago\); waiting/,
      ),
    );
    // Operator should NOT see the generic 15s-cadence hint when we know a fresh time.
    expect(screen.getByTestId('symbol-tv-empty')).not.toHaveTextContent(
      /re-reads the cache every 15s/i,
    );
  });

  it('hides the 32 indicator readings behind a "Show indicators" toggle', async () => {
    setUp(
      () =>
        json({
          items: [{ symbol: 'BTCUSDT', signals: [{ interval: '1m', signal: richSignal }] }],
          fetchedAt: '2026-05-10T12:00:00.000Z',
          technicals: tvBlock(),
        }),
      () => 1_000_000,
    );
    await waitFor(() =>
      expect(screen.getByTestId('symbol-tv-indicators-toggle')).toHaveTextContent(
        /Show indicators \(32\)/,
      ),
    );
    // Collapsed by default — the indicator cells are absent from the DOM.
    expect(screen.queryByTestId('tv-indicator-rsi')).toBeNull();
    // Expanding reveals them.
    act(() => {
      screen.getByTestId('symbol-tv-indicators-toggle').click();
    });
    await waitFor(() =>
      expect(screen.getByTestId('symbol-tv-indicators-toggle')).toHaveTextContent(
        /Hide indicators \(32\)/,
      ),
    );
    expect(screen.getByTestId('tv-indicator-rsi')).toHaveTextContent('56.4');
  });

  it('renders a config-page link when the profile has no intervals configured', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/technicals/health')) return json({ intervals: [] });
      return json({
        items: [{ symbol: 'BTCUSDT', signals: [] }],
        fetchedAt: '2026-05-10T12:00:00.000Z',
        technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const rootRoute = createRootRoute();
    const panelRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/profiles/$profileId/symbols/$symbol',
      component: () => (
        <SymbolTechnicalsPanel profileId={PROFILE_ID} symbol={SYMBOL} clock={() => 1_000_000} />
      ),
    });
    const configRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/profiles/$profileId/config',
      component: () => <div>config</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([panelRoute, configRoute]),
      history: createMemoryHistory({
        initialEntries: [`/profiles/${PROFILE_ID}/symbols/${SYMBOL}`],
      }),
    });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RouterProvider
          router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
        />
      </QueryClientProvider>,
    );
    const link = await screen.findByTestId('symbol-tv-empty-config-link');
    expect(link).toHaveAttribute('href', `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/config`);
  });
});

describe('findHealthForInterval (pure)', () => {
  const rows: TechnicalsFetchStatus[] = [
    {
      interval: '5m',
      fetchedAtMs: 1,
      requested: 1,
      written: 1,
      skippedErrored: 0,
      skippedInvalid: 0,
      latencyMs: 1,
      lastFreshAtMs: null,
      error: null,
    },
  ];
  it('returns the matching row when present', () => {
    expect(findHealthForInterval(rows, '5m')?.interval).toBe('5m');
  });
  it('returns undefined when the interval is not in the list', () => {
    expect(findHealthForInterval(rows, '1h')).toBeUndefined();
  });
  it('returns undefined when the list is itself undefined (no health response yet)', () => {
    expect(findHealthForInterval(undefined, '5m')).toBeUndefined();
  });
});
