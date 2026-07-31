import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENABLEMENT_POLICY, type BacktestResult } from '@app/contracts';

import { BacktestResults } from '@/features/backtest/components/backtest-results';
import {
  EquityAreaChart,
  type AreaChartModule,
} from '@/features/backtest/components/equity-area-chart';

const setData = vi.fn();
const remove = vi.fn();
const fitContent = vi.fn();
const addSeries = vi.fn(() => ({ setData }));
const createChart = vi.fn(() => ({ addSeries, timeScale: () => ({ fitContent }), remove }));
const chartStub: AreaChartModule = { createChart, AreaSeries: {} };
const loadChartModule = (): Promise<AreaChartModule> => Promise.resolve(chartStub);

// The strategy now provides the reason-code gloss + kind on its descriptor (was
// hardcoded in apps/web). Passed as the `reasonAttribution` prop so the funnel
// renders the same plain-language labels and tints. Byte-matches trailing-trade.
const TT_ATTR = {
  'technicals-sell': {
    setting: 'Technical-rating gate',
    gloss: 'Technical rating was bearish (Sell / Strong-Sell)',
    kind: 'market' as const,
  },
  'indicator-rsi': {
    setting: 'RSI(14) buy ceiling',
    paths: ['buy.indicatorGate.rsiMaxBuy'],
    gloss: 'RSI(14) was above your buy ceiling',
    kind: 'config' as const,
  },
  'min-purchase': {
    setting: 'Minimum-purchase floor',
    paths: ['buy.gridLevels[0].minPurchaseAmount'],
    gloss: 'Order fell below your configured minimum-purchase floor',
    kind: 'sizing' as const,
  },
  // A warm-up code: gloss-only, no lever. Glossing it keeps the funnel label
  // distinct from the raw reason code shown in the collapsible counts table.
  'technicals-no-signal': {
    gloss: 'No technical rating yet (still warming up)',
    kind: 'data' as const,
  },
};

const RESULT: BacktestResult = {
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
    finalBalance: '1123' as never,
    absoluteProfit: '123' as never,
    totalReturnPct: 12.34,
    cagrPct: 50,
    marketChangePct: 8,
    dcaChangePct: 6,
    alphaVsHoldPct: 4.34,
    alphaVsDcaPct: 6.34,
    sharpe: 1.25,
    sortino: 1.5,
    calmar: 0.9,
    sqn: 2.1,
    maxDrawdownPct: -8.4,
    absoluteDrawdown: '84' as never,
    drawdownStartMs: 1500,
    drawdownEndMs: 1800,
    totalTrades: 2,
    winRate: 50,
    wins: 1,
    losses: 1,
    profitFactor: 1.2,
    expectancy: '5' as never,
    bestTradePct: 4.2,
    worstTradePct: -1.1,
    avgTradePnl: '2.5' as never,
    avgTradeDurationMs: 3_600_000,
  },
  equityCurve: [
    { tsMs: 60_000, equity: '1000' as never },
    { tsMs: 120_000, equity: '1123' as never },
  ],
  drawdownSeries: [
    { tsMs: 60_000, ddPct: 0 },
    { tsMs: 120_000, ddPct: -8.4 },
  ],
  trades: [
    {
      symbol: 'BTCUSDT',
      side: 'BUY',
      reason: 'grid-buy',
      price: '100' as never,
      qty: '1' as never,
      feeQuote: '0.1' as never,
      tsMs: 60_000,
    },
  ],
  roundTrips: [
    {
      symbol: 'BTCUSDT',
      entryPrice: '100' as never,
      exitPrice: '110' as never,
      qty: '0.5' as never,
      pnlQuote: '7' as never,
      returnPct: 7.77,
      feeQuote: '0.2' as never,
      openTsMs: 60_000,
      closeTsMs: 90_000,
      durationMs: 1_800_000,
      exitReason: 'grid-sell',
    },
    {
      symbol: 'BTCUSDT',
      entryPrice: '120' as never,
      exitPrice: '118' as never,
      qty: '0.5' as never,
      pnlQuote: '-3' as never,
      returnPct: -1.67,
      feeQuote: '0.2' as never,
      openTsMs: 100_000,
      closeTsMs: 120_000,
      durationMs: 1_200_000,
      exitReason: 'tt-stop-loss',
    },
  ],
  perSymbol: [{ symbol: 'BTCUSDT', tradeCount: 2, pnlQuote: '123' as never }],
  decisionBreakdown: {
    metrics: [{ name: 'tt_grid_buy_emit', tags: { symbol: 'BTCUSDT' }, count: 2 }],
    logs: [
      {
        level: 'info',
        message: 'tt-technicals-gate-veto',
        reason: 'technicals-no-signal',
        count: 5,
      },
    ],
  },
  dataWarnings: [],
  regimeBreakdown: [],
};

// Clear in beforeEach, NOT afterEach: RTL's auto-unmount fires `remove()` in
// its own afterEach, which would leak into the next test's counts if cleared
// after.
beforeEach(() => vi.clearAllMocks());

describe('BacktestResults', () => {
  it('renders headline metrics, the disclaimer, and a trade row', async () => {
    render(
      <BacktestResults
        result={RESULT}
        reasonAttribution={TT_ATTR}
        loadChartModule={loadChartModule}
      />,
    );
    expect(screen.getByText('12.34%')).toBeInTheDocument(); // total return
    expect(screen.getByText('1.25')).toBeInTheDocument(); // sharpe
    expect(screen.getByText('8.00%')).toBeInTheDocument(); // buy & hold
    expect(screen.getByText('Buy & hold')).toBeInTheDocument();
    expect(screen.getByText('Alpha vs hold')).toBeInTheDocument();
    expect(screen.getByText('4.34%')).toBeInTheDocument(); // alpha vs hold
    expect(screen.getByText('6.34%')).toBeInTheDocument(); // alpha vs DCA
    expect(screen.getByText('Backtests overstate live performance')).toBeInTheDocument();
    expect(screen.getByText('grid-buy')).toBeInTheDocument();
    // The metric counts closed round-trips; the table lists fills. The labels
    // must not both read "Trades" or the two counts look contradictory.
    expect(screen.getByText('Closed trades')).toBeInTheDocument();
    expect(screen.getByText('Fills (1)')).toBeInTheDocument();
    // decision-breakdown panel: the emit metric and the gate-veto reason surface
    expect(screen.getByText(/Why it traded/)).toBeInTheDocument();
    expect(screen.getByText('tt_grid_buy_emit')).toBeInTheDocument();
    expect(screen.getByText('tt-technicals-gate-veto')).toBeInTheDocument();
    expect(screen.getByText('technicals-no-signal')).toBeInTheDocument();
    // both charts (equity + drawdown) draw their series
    await waitFor(() => expect(setData).toHaveBeenCalledTimes(2));
  });

  it('formats decimal-string money values rather than dumping raw precision', () => {
    const noisy: BacktestResult = {
      ...RESULT,
      metrics: {
        ...RESULT.metrics,
        finalBalance: '999.9769807919878' as never,
        totalReturnPct: -0.0001, // a fee-only loss that rounds to "-0.00"
      },
      trades: [
        {
          symbol: 'BTCUSDT',
          side: 'BUY',
          reason: 'grid-buy',
          price: '77321.291325' as never,
          qty: '0.00019' as never,
          feeQuote: '0.01469104535175' as never,
          tsMs: 60_000,
        },
      ],
      // This fixture exercises headline + fill money formatting, not the round-trip
      // drill-down; clear it so its rollup's 0% win-rate row doesn't add a second
      // "0.00%" and make the negative-zero assertion below ambiguous.
      roundTrips: [],
    };
    render(<BacktestResults result={noisy} loadChartModule={loadChartModule} />);
    expect(screen.getByText('999.98')).toBeInTheDocument(); // final balance, 2dp
    expect(screen.getByText('77,321.29')).toBeInTheDocument(); // price, 2dp + separators
    expect(screen.getByText('0.00019')).toBeInTheDocument(); // qty keeps base-asset precision
    expect(screen.queryByText('999.9769807919878')).not.toBeInTheDocument();
    // negative zero collapses to a plain "0.00%" rather than "-0.00%"
    expect(screen.getByText('0.00%')).toBeInTheDocument();
    expect(screen.queryByText('-0.00%')).not.toBeInTheDocument();
  });

  it('shows an em-dash for a null profit factor / best trade', async () => {
    const noClosed: BacktestResult = {
      ...RESULT,
      metrics: { ...RESULT.metrics, profitFactor: null, bestTradePct: null, worstTradePct: null },
    };
    render(<BacktestResults result={noClosed} loadChartModule={loadChartModule} />);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('surfaces a patchy-history banner when the run carries data warnings', () => {
    const warned: BacktestResult = {
      ...RESULT,
      dataWarnings: ['DEADUSDT: only 12% of the expected 1h candles are present (120/1000).'],
    };
    render(<BacktestResults result={warned} loadChartModule={loadChartModule} />);
    expect(screen.getByTestId('backtest-data-warnings')).toBeInTheDocument();
    expect(screen.getByText(/Patchy price history/)).toBeInTheDocument();
    expect(screen.getByText(/DEADUSDT: only 12%/)).toBeInTheDocument();
  });

  it('renders no data-warning banner for a clean run', () => {
    render(<BacktestResults result={RESULT} loadChartModule={loadChartModule} />);
    expect(screen.queryByTestId('backtest-data-warnings')).not.toBeInTheDocument();
  });

  it('shows a prefer-hold banner when the strategy lost to holding (negative alpha)', () => {
    const noEdge: BacktestResult = {
      ...RESULT,
      metrics: { ...RESULT.metrics, alphaVsHoldPct: -1.5 },
    };
    render(<BacktestResults result={noEdge} loadChartModule={loadChartModule} />);
    expect(screen.getByTestId('prefer-hold-banner')).toBeInTheDocument();
    expect(screen.getByText(/Holding the basket beat this strategy/)).toBeInTheDocument();
  });

  it('hides the prefer-hold banner when the strategy matched or beat holding (alpha >= 0)', () => {
    render(<BacktestResults result={RESULT} loadChartModule={loadChartModule} />);
    expect(screen.queryByTestId('prefer-hold-banner')).not.toBeInTheDocument();
  });

  it('shows a zero-trade banner naming the dominant block reason when no orders filled (#534)', () => {
    const zeroTrade: BacktestResult = {
      ...RESULT,
      metrics: { ...RESULT.metrics, totalReturnPct: 0, totalTrades: 0, alphaVsHoldPct: 10.75 },
      trades: [],
      roundTrips: [],
      decisionBreakdown: {
        metrics: [],
        logs: [
          {
            level: 'info',
            message: 'tt-regime-require-uptrend-blocked',
            reason: null,
            count: 18411,
          },
          {
            level: 'info',
            message: 'tt-technicals-gate-veto',
            reason: 'technicals-sell',
            count: 3794,
          },
        ],
      },
    };
    render(<BacktestResults result={zeroTrade} loadChartModule={loadChartModule} />);
    expect(screen.getByTestId('zero-trade-banner')).toBeInTheDocument();
    expect(screen.getByText(/never entered the market/)).toBeInTheDocument();
    // the dominant (highest-count) reason is glossed in plain language
    expect(screen.getByText(/the market was in a downtrend/)).toBeInTheDocument();
    // the misleading "Holding beat this strategy" banner is suppressed on a no-trade run
    expect(screen.queryByTestId('prefer-hold-banner')).not.toBeInTheDocument();
  });

  it('shows a still-holding banner when fills exist but no round-trip closed (#534)', () => {
    // A buy-and-hold-open run: one BUY fill, zero closed round-trips. The banner
    // must say "still holding", not "never entered", and must not read green.
    const openPosition: BacktestResult = {
      ...RESULT,
      metrics: { ...RESULT.metrics, totalReturnPct: 5, totalTrades: 0, alphaVsHoldPct: 2 },
      trades: [
        {
          symbol: 'BTCUSDT',
          side: 'BUY',
          reason: 'grid-buy',
          price: '100' as never,
          qty: '1' as never,
          feeQuote: '0.1' as never,
          tsMs: 60_000,
        },
      ],
      roundTrips: [],
    };
    render(<BacktestResults result={openPosition} loadChartModule={loadChartModule} />);
    expect(screen.getByTestId('zero-trade-banner')).toBeInTheDocument();
    expect(screen.getByText(/still holding an open position/)).toBeInTheDocument();
    expect(screen.queryByText(/never entered the market/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('prefer-hold-banner')).not.toBeInTheDocument();
  });

  it('renders a plain-language decision funnel and choke line for a gated run', () => {
    const gated: BacktestResult = {
      ...RESULT,
      metrics: { ...RESULT.metrics, totalReturnPct: 0, totalTrades: 0, alphaVsHoldPct: 0 },
      trades: [],
      roundTrips: [],
      decisionBreakdown: {
        metrics: [
          { name: 'tt_tick_pure_path', tags: { symbol: 'BTCUSDT' }, count: 9000 },
          {
            name: 'tt_first_buy_skipped',
            tags: { symbol: 'BTCUSDT', reason: 'min-purchase' },
            count: 100,
          },
        ],
        logs: [
          {
            level: 'info',
            message: 'tt-technicals-gate-veto',
            reason: 'technicals-sell',
            count: 8000,
          },
          { level: 'info', message: 'tt-indicator-gate-veto', reason: 'indicator-rsi', count: 900 },
        ],
      },
    };
    render(
      <BacktestResults
        result={gated}
        reasonAttribution={TT_ATTR}
        loadChartModule={loadChartModule}
      />,
    );
    // The legible summary leads, with the binding-constraint choke line.
    expect(screen.getByTestId('bt-why-summary')).toBeInTheDocument();
    const choke = screen.getByTestId('bt-why-choke');
    // 900 of the 1000 entries that passed the rating gate = 90%.
    expect(choke).toHaveTextContent('90%');
    expect(choke).toHaveTextContent('RSI(14) was above your buy ceiling');
    // The raw counters are still present in full, behind a collapsible disclosure.
    expect(screen.getByText('tt-technicals-gate-veto')).toBeInTheDocument();
    expect(screen.getByText('Show raw per-tick counts')).toBeInTheDocument();
  });

  it('leads with a dominant-gate headline naming the config setting that armed it', () => {
    const regimeGated: BacktestResult = {
      ...RESULT,
      metrics: { ...RESULT.metrics, totalReturnPct: 0, totalTrades: 0, alphaVsHoldPct: 0 },
      trades: [],
      roundTrips: [],
      decisionBreakdown: {
        metrics: [
          { name: 'tt_regime_exit_entry_block', tags: { symbol: 'BTCUSDT' }, count: 8481 },
          { name: 'tt_tick_buy_path', tags: { symbol: 'BTCUSDT' }, count: 3 },
        ],
        logs: [],
      },
    };
    const config = {
      regime: { ma: 'sma', period: 200, confirmBars: 3, onBear: { blockEntry: true } },
    };
    // The lever names come from the strategy's attribution map (descriptor), no
    // longer a hardcoded web copy.
    const reasonAttribution = {
      tt_regime_exit_entry_block: {
        setting: 'Regime entry-block',
        paths: ['regime.onBear.blockEntry', 'regime.onBear.exitToCash'],
        note: 'the bear-regime rule, defined by regime.ma / regime.period / regime.confirmBars',
        gloss: 'Regime exit rule blocked new entries',
        kind: 'config' as const,
      },
    };
    render(
      <BacktestResults
        result={regimeGated}
        config={config}
        reasonAttribution={reasonAttribution}
        loadChartModule={loadChartModule}
      />,
    );
    const dominant = screen.getByTestId('bt-why-dominant');
    expect(dominant).toHaveTextContent('Regime exit rule blocked new entries');
    // 8481 of 8484 ≈ 100%.
    expect(dominant).toHaveTextContent('8,481 of 8,484');
    // The exact config field + value + the strategy's note are named.
    const attr = screen.getByTestId('bt-why-dominant-attr');
    expect(attr).toHaveTextContent('regime.onBear.blockEntry');
    expect(attr).toHaveTextContent('bear-regime rule');
  });

  it('renders the recommendations slot when provided', () => {
    render(
      <BacktestResults
        result={RESULT}
        loadChartModule={loadChartModule}
        recommendations={<div data-testid="recs-slot">recs</div>}
      />,
    );
    expect(screen.getByTestId('recs-slot')).toBeInTheDocument();
  });

  it('renders the actions slot under the "What next?" section when provided', () => {
    render(
      <BacktestResults
        result={RESULT}
        loadChartModule={loadChartModule}
        actions={<div data-testid="actions-slot">act</div>}
      />,
    );
    expect(screen.getByTestId('actions-slot')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What next?' })).toBeInTheDocument();
  });

  it('omits the "What next?" section when neither slot is provided', () => {
    render(<BacktestResults result={RESULT} loadChartModule={loadChartModule} />);
    expect(screen.queryByText('What next?')).not.toBeInTheDocument();
  });

  it('shows the zero-trade banner without a block-reason line when there are no logs', () => {
    const zeroNoLogs: BacktestResult = {
      ...RESULT,
      metrics: { ...RESULT.metrics, totalReturnPct: 0, totalTrades: 0 },
      trades: [],
      roundTrips: [],
      decisionBreakdown: { metrics: [], logs: [] },
    };
    render(<BacktestResults result={zeroNoLogs} loadChartModule={loadChartModule} />);
    expect(screen.getByTestId('zero-trade-banner')).toBeInTheDocument();
    expect(screen.getByText(/never entered the market/)).toBeInTheDocument();
    expect(screen.queryByText(/Most entries were blocked/)).not.toBeInTheDocument();
  });

  it('does not tint the 0.00% return green on a zero-trade run (positive alpha is just cash)', () => {
    const zeroTrade: BacktestResult = {
      ...RESULT,
      metrics: {
        ...RESULT.metrics,
        totalReturnPct: 0,
        totalTrades: 0,
        alphaVsHoldPct: 10.75,
        marketChangePct: -10.75,
      },
      trades: [],
      roundTrips: [],
    };
    render(<BacktestResults result={zeroTrade} loadChartModule={loadChartModule} />);
    const totalReturn = screen.getByText('0.00%');
    expect(totalReturn).not.toHaveClass('text-up');
    expect(totalReturn).not.toHaveClass('text-down');
  });

  it('tints each metric by its own sign, and carries the lost-to-hold verdict separately', () => {
    // The headline trap: a positive absolute return that badly lost to holding.
    // The number tints by its own sign (green = made money) so it never disagrees
    // with the same value elsewhere (Past-runs PnL, Fills); the "you lost to
    // holding" story is carried explicitly by the prefer-hold banner and the red
    // Alpha tile, not by overloading the return's color.
    const lostToHold: BacktestResult = {
      ...RESULT,
      metrics: {
        ...RESULT.metrics,
        totalReturnPct: 4.41,
        cagrPct: 25,
        alphaVsHoldPct: -99.66,
        marketChangePct: 104.08,
      },
    };
    render(<BacktestResults result={lostToHold} loadChartModule={loadChartModule} />);
    // +4.41% return and +25% CAGR are profits, so they read green by their own sign.
    expect(screen.getByText('4.41%')).toHaveClass('text-up');
    expect(screen.getByText('25.00%')).toHaveClass('text-up');
    // Alpha is negative — it lost to holding — so the Alpha tile reads red.
    expect(screen.getByText('-99.66%')).toHaveClass('text-down');
    // And the verdict is unmissable as its own banner, not a color cue.
    expect(screen.getByTestId('prefer-hold-banner')).toBeInTheDocument();
    // The benchmark is context, not the operator's win, so it stays neutral.
    const buyHold = screen.getByText('104.08%');
    expect(buyHold).not.toHaveClass('text-up');
    expect(buyHold).not.toHaveClass('text-down');
  });

  it('tints a positive return green and a negative return red, by its own sign', () => {
    // RESULT carries a +12.34% return, so it reads green.
    render(<BacktestResults result={RESULT} loadChartModule={loadChartModule} />);
    expect(screen.getByText('12.34%')).toHaveClass('text-up');
  });

  it('renders no gate scorecard when no enablement policy is supplied', () => {
    render(<BacktestResults result={RESULT} loadChartModule={loadChartModule} />);
    expect(screen.queryByTestId('gate-scorecard')).not.toBeInTheDocument();
  });

  it('renders the gate scorecard when an enablement policy is supplied', () => {
    render(
      <BacktestResults
        result={RESULT}
        loadChartModule={loadChartModule}
        enablementPolicy={DEFAULT_ENABLEMENT_POLICY}
      />,
    );
    expect(screen.getByTestId('gate-scorecard')).toBeInTheDocument();
  });

  it('omits the regime table when the breakdown is empty', () => {
    render(<BacktestResults result={RESULT} loadChartModule={loadChartModule} />);
    expect(screen.queryByTestId('backtest-regime-table')).not.toBeInTheDocument();
  });

  it('renders a per-regime breakdown with labels, alpha, and trade stats', () => {
    const withRegimes: BacktestResult = {
      ...RESULT,
      regimeBreakdown: [
        {
          regime: 'bull',
          returnPct: 12.5,
          holdReturnPct: 15.2,
          alphaVsHoldPct: -2.7,
          trades: 8,
          winRate: 25,
          profitFactor: 0.4,
          expectancy: '-3.1' as never,
        },
        {
          regime: 'bear',
          returnPct: -1.2,
          holdReturnPct: -9.8,
          alphaVsHoldPct: 8.6,
          trades: 0,
          winRate: 0,
          profitFactor: null,
          expectancy: '0' as never,
        },
      ],
    };
    render(<BacktestResults result={withRegimes} loadChartModule={loadChartModule} />);
    expect(screen.getByTestId('backtest-regime-table')).toBeInTheDocument();
    expect(screen.getByText('Performance by market regime')).toBeInTheDocument();
    expect(screen.getByText('Bull · uptrend')).toBeInTheDocument();
    expect(screen.getByText('Bear · downtrend')).toBeInTheDocument();
    // Negative alpha in the bull row is the tell: the edge is just holding.
    expect(screen.getByText('-2.70%')).toBeInTheDocument();
    expect(screen.getByText('0.40')).toBeInTheDocument(); // bull profit factor
    // The no-trade bear row renders an em-dash for both win rate and profit
    // factor (the only two em-dashes on the page for this fixture).
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('renders the out-of-sample holdout panel with the recent-slice metrics', () => {
    const withOos: BacktestResult = {
      ...RESULT,
      outOfSample: {
        fraction: 0.3,
        fromMs: 90_000,
        toMs: 120_000,
        returnPct: 3.3,
        holdReturnPct: 1.1,
        alphaVsHoldPct: 2.2,
        trades: 7,
        winRate: 57,
        profitFactor: 1.37,
        expectancy: '3' as never,
      },
    };
    render(<BacktestResults result={withOos} loadChartModule={loadChartModule} />);
    expect(screen.getByTestId('backtest-oos-table')).toBeInTheDocument();
    expect(screen.getByText(/Out-of-sample check/)).toBeInTheDocument();
    expect(screen.getByText(/recent 30%/)).toBeInTheDocument();
    expect(screen.getByText('3.30%')).toBeInTheDocument(); // holdout return
    expect(screen.getByText('2.20%')).toBeInTheDocument(); // holdout alpha vs hold
    expect(screen.getByText('1.37')).toBeInTheDocument(); // holdout profit factor
  });

  it('shows the too-short note when the run has no holdout', () => {
    const noOos: BacktestResult = { ...RESULT, outOfSample: null };
    render(<BacktestResults result={noOos} loadChartModule={loadChartModule} />);
    expect(screen.queryByTestId('backtest-oos-table')).not.toBeInTheDocument();
    expect(screen.getByText(/too short to carve a holdout/)).toBeInTheDocument();
  });

  it('renders an em-dash for the holdout win rate when no trades opened in the slice', () => {
    // The engine emits a non-null holdout with trades: 0 when returns exist but
    // no position opened in the recent slice (see the golden snapshot). The
    // win-rate cell must show "—", while return/alpha still render.
    const zeroTradeOos: BacktestResult = {
      ...RESULT,
      outOfSample: {
        fraction: 0.3,
        fromMs: 90_000,
        toMs: 120_000,
        returnPct: 1.9,
        holdReturnPct: 0.4,
        alphaVsHoldPct: 1.5,
        trades: 0,
        winRate: 0,
        profitFactor: null,
        expectancy: '0' as never,
      },
    };
    render(<BacktestResults result={zeroTradeOos} loadChartModule={loadChartModule} />);
    const table = screen.getByTestId('backtest-oos-table');
    expect(table).toHaveTextContent('1.90%'); // holdout return still renders
    expect(within(table).getAllByText('—').length).toBeGreaterThanOrEqual(2); // win rate + PF
  });

  it('renders the round-trip drill-down with a per-exit-reason rollup', () => {
    render(<BacktestResults result={RESULT} loadChartModule={loadChartModule} />);
    const section = screen.getByTestId('backtest-round-trips');
    expect(section).toBeInTheDocument();
    // The closing-sell reasons appear in both the rollup and the per-trade table.
    expect(within(section).getAllByText('grid-sell').length).toBeGreaterThanOrEqual(2);
    expect(within(section).getAllByText('tt-stop-loss').length).toBeGreaterThanOrEqual(2);
    // Median of the two holds (30m, 20m) = 25m; longest = 30m. The summary text
    // spans several JSX nodes, so assert on the concatenated textContent.
    const summary = within(section).getByTestId('backtest-round-trips-summary');
    expect(summary).toHaveTextContent('typically held 25m');
    expect(summary).toHaveTextContent('longest 30m');
    const rollup = screen.getByTestId('backtest-exit-reason-rollup');
    // The losing exit (tt-stop-loss) carries a negative total P&L in the rollup.
    expect(within(rollup).getByText('-3.00')).toBeInTheDocument();
  });

  it('aggregates the exit-reason rollup across several trades sharing one reason', () => {
    // Two round-trips both exiting on tt-stop-loss (one win, one loss): the rollup
    // row must sum them (P&L 5 + -2 = 3) and show a 50% win rate over 2 trades.
    const rt = (pnl: string, ret: number): BacktestResult['roundTrips'][number] => ({
      symbol: 'BTCUSDT',
      entryPrice: '100' as never,
      exitPrice: '105' as never,
      qty: '0.5' as never,
      pnlQuote: pnl as never,
      returnPct: ret,
      feeQuote: '0.1' as never,
      openTsMs: 60_000,
      closeTsMs: 90_000,
      durationMs: 600_000,
      exitReason: 'tt-stop-loss',
    });
    const shared: BacktestResult = { ...RESULT, roundTrips: [rt('5', 5), rt('-2', -2)] };
    render(<BacktestResults result={shared} loadChartModule={loadChartModule} />);
    const rollup = screen.getByTestId('backtest-exit-reason-rollup');
    expect(within(rollup).getByText('3.00')).toBeInTheDocument(); // summed P&L
    expect(within(rollup).getByText('50.00%')).toBeInTheDocument(); // 1 of 2 won
    expect(within(rollup).getByText('1.50%')).toBeInTheDocument(); // mean return (5 + -2)/2
  });

  it('omits the round-trip drill-down when no position ever closed', () => {
    const noClosed: BacktestResult = { ...RESULT, roundTrips: [] };
    render(<BacktestResults result={noClosed} loadChartModule={loadChartModule} />);
    expect(screen.queryByTestId('backtest-round-trips')).not.toBeInTheDocument();
  });
});

describe('BacktestResults ComparisonHeader', () => {
  // A comparable anchor (same market params as RESULT) with overridden metrics.
  const anchor = (
    runId: string,
    over: Partial<BacktestResult['metrics']>,
  ): { runId: string; result: BacktestResult } => ({
    runId,
    result: { ...RESULT, metrics: { ...RESULT.metrics, ...over } },
  });

  it('falls back to the Baseline anchor when there is no parent and shows its deltas', () => {
    // Only a baseline is offered: the `?? options[0]` clamp + default-to-Parent
    // must resolve to Baseline rather than render nothing.
    render(
      <BacktestResults
        result={RESULT}
        loadChartModule={loadChartModule}
        baselineAnchor={anchor('base', {
          totalReturnPct: 10,
          alphaVsHoldPct: 1,
          maxDrawdownPct: -10,
        })}
      />,
    );
    expect(screen.getByTestId('backtest-compare-baseline')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('backtest-compare-parent')).toBeNull();

    const deltas = screen.getByTestId('backtest-compare-deltas');
    const cell = (label: string): HTMLElement =>
      within(deltas).getByText(label).parentElement as HTMLElement;
    // viewed − baseline: return 12.34-10, alpha 4.34-1, drawdown -8.4-(-10).
    expect(within(cell('Return Δ')).getByText('+2.34%')).toHaveClass('text-up');
    expect(within(cell('Alpha Δ')).getByText('+3.34%')).toHaveClass('text-up');
    // Less-negative drawdown than the baseline → improvement, green.
    expect(within(cell('Drawdown Δ')).getByText('+1.60%')).toHaveClass('text-up');
  });

  it('switches anchors when Baseline is clicked and recomputes deltas against it', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(
      <BacktestResults
        result={RESULT}
        loadChartModule={loadChartModule}
        parentAnchor={anchor('par', { totalReturnPct: 12 })}
        baselineAnchor={anchor('base', { totalReturnPct: 5 })}
      />,
    );
    // Defaults to Parent: Return Δ = 12.34 - 12.
    expect(screen.getByTestId('backtest-compare-parent')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('backtest-compare-baseline')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    const deltas = screen.getByTestId('backtest-compare-deltas');
    expect(within(deltas).getByText('+0.34%')).toBeInTheDocument();

    // Clicking Baseline flips aria-pressed and recomputes: Return Δ = 12.34 - 5.
    await user.click(screen.getByTestId('backtest-compare-baseline'));
    expect(screen.getByTestId('backtest-compare-baseline')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('backtest-compare-parent')).toHaveAttribute('aria-pressed', 'false');
    expect(
      within(screen.getByTestId('backtest-compare-deltas')).getByText('+7.34%'),
    ).toBeInTheDocument();
  });

  it('renders no comparison strip when neither anchor is provided', () => {
    render(<BacktestResults result={RESULT} loadChartModule={loadChartModule} />);
    expect(screen.queryByTestId('backtest-compare')).toBeNull();
  });
});

describe('EquityAreaChart lifecycle', () => {
  it('removes the chart on unmount', async () => {
    const { unmount } = render(
      <EquityAreaChart
        points={[
          { tsMs: 60_000, value: 1000 },
          { tsMs: 120_000, value: 1100 },
        ]}
        loadModule={loadChartModule}
      />,
    );
    await waitFor(() => expect(createChart).toHaveBeenCalledTimes(1));
    unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('does not create a chart when unmounted before the module resolves', async () => {
    let resolve: (m: AreaChartModule) => void = () => undefined;
    const deferred = new Promise<AreaChartModule>((r) => {
      resolve = r;
    });
    const { unmount } = render(
      <EquityAreaChart points={[{ tsMs: 60_000, value: 1 }]} loadModule={() => deferred} />,
    );
    unmount(); // cancel before the module loads
    resolve(chartStub);
    await deferred;
    expect(createChart).not.toHaveBeenCalled();
  });
});
