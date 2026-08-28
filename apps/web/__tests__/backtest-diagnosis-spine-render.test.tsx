import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacktestResult } from '@app/contracts';

import { BacktestResults } from '@/features/backtest/components/backtest-results';
import { type AreaChartModule } from '@/features/backtest/components/equity-area-chart';

const setData = vi.fn();
const remove = vi.fn();
const fitContent = vi.fn();
const addSeries = vi.fn(() => ({ setData }));
const createChart = vi.fn(() => ({ addSeries, timeScale: () => ({ fitContent }), remove }));
const chartStub: AreaChartModule = { createChart, AreaSeries: {} };
const loadChartModule = (): Promise<AreaChartModule> => Promise.resolve(chartStub);

// The reason-code → config-path attribution the strategy provides (threaded from
// the route via the strategy descriptor). The spine names levers off this.
const TT_ATTR = {
  'indicator-rsi': { setting: 'RSI(14) buy ceiling', paths: ['buy.indicatorGate.rsiMaxBuy'] },
  'technicals-sell': {
    setting: 'Technical-rating gate',
    note: 'reads the market, not a setting you tune',
  },
};

// A zero-trade run gated by the RSI indicator: the spine should surface that
// blocker with the strategy-provided lever path.
const GATED_RESULT: BacktestResult = {
  params: {
    symbols: ['BTCUSDT'],
    fromMs: 1,
    toMs: 2,
    strategyInterval: '1h',
    detailInterval: '5m',
    initialQuoteBalance: '1000' as never,
    fees: { makerBps: 10, takerBps: 10 },
    slippageBps: 5,
  },
  metrics: {
    startingBalance: '1000' as never,
    finalBalance: '1000' as never,
    absoluteProfit: '0' as never,
    totalReturnPct: 0,
    cagrPct: 0,
    marketChangePct: 8,
    dcaChangePct: 6,
    alphaVsHoldPct: -8,
    alphaVsDcaPct: -6,
    sharpe: 0,
    sortino: 0,
    calmar: 0,
    sqn: 0,
    maxDrawdownPct: -2,
    absoluteDrawdown: '20' as never,
    drawdownStartMs: 1,
    drawdownEndMs: 2,
    totalTrades: 0,
    winRate: 0,
    wins: 0,
    losses: 0,
    profitFactor: null,
    expectancy: '0' as never,
    bestTradePct: null,
    worstTradePct: null,
    avgTradePnl: '0' as never,
    avgTradeDurationMs: 0,
  },
  equityCurve: [{ tsMs: 60_000, equity: '1000' as never }],
  drawdownSeries: [{ tsMs: 60_000, ddPct: 0 }],
  trades: [],
  roundTrips: [],
  perSymbol: [],
  decisionBreakdown: {
    metrics: [{ name: 'tt_tick_pure_path', tags: { symbol: 'BTCUSDT' }, count: 9000 }],
    logs: [
      { level: 'info', message: 'tt-technicals-gate-veto', reason: 'technicals-sell', count: 8000 },
      { level: 'info', message: 'tt-indicator-gate-veto', reason: 'indicator-rsi', count: 900 },
    ],
  },
  dataWarnings: [],
  regimeBreakdown: [],
  outOfSample: null,
};

const CONFIG = { buy: { indicatorGate: { rsiMaxBuy: '30' } } };

beforeEach(() => vi.clearAllMocks());

describe('BacktestResults diagnosis spine', () => {
  it('renders a diagnosis-spine section above the metrics grid', () => {
    render(
      <BacktestResults
        result={GATED_RESULT}
        config={CONFIG}
        reasonAttribution={TT_ATTR}
        loadChartModule={loadChartModule}
      />,
    );
    const spine = screen.getByTestId('bt-diagnosis-spine');
    const metricsHeading = screen.getByRole('heading', { name: 'Results' });
    // The spine precedes the metrics/evidence in document order.
    expect(
      spine.compareDocumentPosition(metricsHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows a funnel blocker in the spine with its strategy-provided config-path lever', () => {
    render(
      <BacktestResults
        result={GATED_RESULT}
        config={CONFIG}
        reasonAttribution={TT_ATTR}
        loadChartModule={loadChartModule}
      />,
    );
    const spine = screen.getByTestId('bt-diagnosis-spine');
    expect(within(spine).getByText('buy.indicatorGate.rsiMaxBuy')).toBeInTheDocument();
  });

  it('keeps recommendations in the bottom "What next?" section, outside the spine', () => {
    render(
      <BacktestResults
        result={GATED_RESULT}
        config={CONFIG}
        reasonAttribution={TT_ATTR}
        loadChartModule={loadChartModule}
        recommendations={<div data-testid="recs-slot">recs</div>}
      />,
    );
    const spine = screen.getByTestId('bt-diagnosis-spine');
    expect(within(spine).queryByTestId('recs-slot')).toBeNull();
    expect(screen.getByRole('heading', { name: 'What next?' })).toBeInTheDocument();
    expect(screen.getByTestId('recs-slot')).toBeInTheDocument();
  });

  it('labels each numeric count badge with what it counts', () => {
    render(
      <BacktestResults
        result={GATED_RESULT}
        config={CONFIG}
        reasonAttribution={TT_ATTR}
        loadChartModule={loadChartModule}
      />,
    );
    const spine = screen.getByTestId('bt-diagnosis-spine');
    // The RSI blocker fired 900 times. Rendered as a bare number the badge reads out as "900" with no noun, so a screen-reader user gets a figure with no idea what it measures — and sighted readers rely on the adjacent title, which the badge is not programmatically tied to. Queried BY ROLE, because the role is half the fix: ARIA prohibits naming a `generic` element, so real assistive tech drops an `aria-label` on a bare `<span>`. `toHaveAccessibleName` cannot see that — `dom-accessibility-api` implements the naming steps with no notion of the prohibition, and would happily report the label off a `generic`. Only `getByRole('img')` pins the element type that makes the label survive.
    const badge = within(spine).getByRole('img', { name: '900 blocked entries — indicator-rsi' });
    expect(badge).toHaveTextContent('900');
  });

  it('names a gate-fail count for what that kind counts, not the blocker wording', () => {
    // The noun is per-kind, so one exercised kind proves nothing about the others: a gate-fail badge saying "blocked entries" would be wrong in a way the blocker case cannot show.
    render(
      <BacktestResults
        result={GATED_RESULT}
        config={CONFIG}
        reasonAttribution={TT_ATTR}
        loadChartModule={loadChartModule}
        enablementPolicy={{
          enabled: true,
          minProfitFactor: 1.1,
          minTrades: 100,
          minAlphaVsHoldPct: 0,
          requireOutOfSample: true,
          maxDrawdownPct: 30,
        }}
      />,
    );
    const spine = screen.getByTestId('bt-diagnosis-spine');
    const badge = within(spine).getByRole('img', {
      name: /^\d+ failed checks — Live-gate checks not cleared: /,
    });
    expect(badge).toHaveTextContent(/^\d+$/);
  });
});
