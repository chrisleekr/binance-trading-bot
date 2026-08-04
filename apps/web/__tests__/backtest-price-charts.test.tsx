import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BacktestResult, BacktestTrade } from '@app/contracts';

import { createQueryClient } from '@/shared/lib/query-client';
import {
  BacktestPriceCharts,
  CHART_HEIGHT,
  CHART_SM_HEIGHT_CLASS,
} from '@/features/backtest/components/backtest-price-charts';
import type { ChartModule } from '@/features/symbol/components/symbol-candle-chart';

// Minimal lightweight-charts stub so happy-dom's missing canvas never runs.
// `setMarkers` is the seam we assert trade→marker mapping through.
const setMarkers = vi.fn();
const series = { setData: vi.fn(), createPriceLine: vi.fn(() => ({})), removePriceLine: vi.fn() };
const chart = { addSeries: vi.fn(() => series), subscribeCrosshairMove: vi.fn(), remove: vi.fn() };
const chartStub: ChartModule = {
  createChart: vi.fn(() => chart),
  CandlestickSeries: {},
  createSeriesMarkers: vi.fn(() => ({ setMarkers })),
};
const loadModule = (): Promise<ChartModule> => Promise.resolve(chartStub);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR = 3_600_000;

const bar = (tsMs: number): Record<string, string> => ({
  time: new Date(tsMs).toISOString(),
  open: '100',
  high: '110',
  low: '95',
  close: '105',
  volume: '1',
});

const trade = (side: BacktestTrade['side'], reason: string, tsMs: number): BacktestTrade => ({
  symbol: 'BTCUSDT',
  side,
  reason,
  price: side === 'BUY' ? ('100' as never) : ('110' as never),
  qty: '1' as never,
  feeQuote: '0.1' as never,
  tsMs,
});

function makeResult(
  overrides: Partial<BacktestResult['params']>,
  trades: BacktestTrade[],
): BacktestResult {
  return {
    params: {
      symbols: ['BTCUSDT'],
      fromMs: T0,
      toMs: T0 + 1000 * HOUR,
      strategyInterval: '1h',
      detailInterval: '5m',
      initialQuoteBalance: '1000' as never,
      fees: { makerBps: 10, takerBps: 10 },
      slippageBps: 5,
      ...overrides,
    },
    metrics: {} as never,
    equityCurve: [],
    drawdownSeries: [],
    trades,
    perSymbol: [],
  };
}

const renderWith = (result: BacktestResult, candleFn: (sym: string) => unknown[]) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const sym = url.includes('ETHUSDT') ? 'ETHUSDT' : 'BTCUSDT';
    if (url.includes('/candles')) return json(candleFn(sym));
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <BacktestPriceCharts result={result} profileId="p1" loadModule={loadModule} />
    </QueryClientProvider>,
  );
  return { fetchMock };
};

/** Candle-request URLs the chart has fetched so far, in call order. */
const candleUrls = (fetchMock: ReturnType<typeof vi.fn>): string[] =>
  fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/candles'));

const twoBars = (): unknown[] => [bar(T0), bar(T0 + HOUR)];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('BacktestPriceCharts', () => {
  it('renders one chart for a single-symbol run and maps trades to buy/sell/stop-loss markers', async () => {
    const result = makeResult({}, [
      trade('BUY', 'grid-buy', T0 + 1000),
      trade('SELL', 'grid-sell', T0 + HOUR),
      trade('SELL', 'grid-stop-loss', T0 + HOUR + 1000),
    ]);
    renderWith(result, twoBars);
    await waitFor(() => expect(setMarkers).toHaveBeenCalled());
    const markers = setMarkers.mock.calls.at(-1)?.[0] as {
      time: number;
      position: string;
      text: string;
    }[];
    expect(markers).toHaveLength(3);
    expect(markers.map((m) => m.position)).toEqual(
      expect.arrayContaining(['belowBar', 'aboveBar', 'inBar']),
    );
    expect(markers.filter((m) => m.text === 'SL')).toHaveLength(1);
    // ascending time order is required by lightweight-charts
    expect(markers.map((m) => m.time)).toEqual(
      [...markers.map((m) => m.time)].sort((a, b) => a - b),
    );
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('drops trade markers outside the loaded candle window — even on an interval the symbol map omits', async () => {
    // 2h interval is absent from the symbol feature's interval→ms map; the
    // window span must come from the candle data, not that map.
    const result = makeResult({ strategyInterval: '2h' }, [
      trade('BUY', 'grid-buy', T0 + 1000), // inside the loaded window
      trade('SELL', 'grid-sell', T0 + 10 * HOUR), // far past the last bar → dropped
    ]);
    renderWith(result, () => [bar(T0), bar(T0 + 2 * HOUR)]);
    await waitFor(() => expect(setMarkers).toHaveBeenCalled());
    const markers = setMarkers.mock.calls.at(-1)?.[0] as { position: string }[];
    expect(markers).toHaveLength(1);
    expect(markers[0]?.position).toBe('belowBar');
  });

  it('keeps a single-candle window’s own close-stamped trade (no derivable span)', async () => {
    // One 1h candle; the trade is stamped at the bar CLOSE (open + interval - 1),
    // which is past the bar's open time — it must not be dropped.
    const result = makeResult({}, [trade('BUY', 'grid-buy', T0 + HOUR - 1)]);
    renderWith(result, () => [bar(T0)]);
    await waitFor(() => expect(setMarkers).toHaveBeenCalled());
    const markers = setMarkers.mock.calls.at(-1)?.[0] as { position: string }[];
    expect(markers).toHaveLength(1);
    expect(markers[0]?.position).toBe('belowBar');
  });

  it('notes truncation when the candle page hits the 1000-row cap', async () => {
    const result = makeResult({}, [trade('BUY', 'grid-buy', T0 + 1000)]);
    const thousand = Array.from({ length: 1000 }, (_, i) => bar(T0 + i * HOUR));
    renderWith(result, () => thousand);
    expect(await screen.findByText(/Showing the first 1000 1h candles/)).toBeInTheDocument();
  });

  it('defaults the interval to fit the whole run, then refetches when zoomed in', async () => {
    // A 200-day run at 1h would be ~4800 bars — past the 1000 cap — so the
    // default picks 6h (~800 bars) to show the whole window in one fetch.
    const longRun = makeResult({ fromMs: T0, toMs: T0 + 4800 * HOUR }, [
      trade('BUY', 'grid-buy', T0 + 1000),
    ]);
    const { fetchMock } = renderWith(longRun, twoBars);
    await waitFor(() => expect(setMarkers).toHaveBeenCalled());

    expect(screen.getByRole('button', { name: '6h' })).toHaveAttribute('aria-pressed', 'true');
    expect(candleUrls(fetchMock).at(-1)).toContain('interval=6h');

    // Picking a finer interval zooms in: a new candle fetch at that interval.
    await userEvent.click(screen.getByRole('button', { name: '1h' }));
    await waitFor(() => expect(candleUrls(fetchMock).at(-1)).toContain('interval=1h'));
    expect(screen.getByRole('button', { name: '1h' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders a tab per symbol for a multi-symbol run', async () => {
    renderWith(makeResult({ symbols: ['BTCUSDT', 'ETHUSDT'] }, []), twoBars);
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));
    expect(screen.getByRole('tab', { name: 'BTCUSDT' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'ETHUSDT' })).toBeInTheDocument();
  });

  it('keeps the pending placeholder height pinned to the chart height', () => {
    // The class must be a source-text literal for Tailwind's JIT to compile it,
    // so the compiler cannot catch a drift from CHART_HEIGHT. This can.
    expect(CHART_SM_HEIGHT_CLASS).toBe(`sm:h-[${CHART_HEIGHT}px]`);
  });
});
