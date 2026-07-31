// GateScorecard — the live-gate quality check on a finished backtest.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { GateScorecard } from '@/features/backtest/components/gate-scorecard';

import {
  DEFAULT_ENABLEMENT_POLICY,
  type BacktestMetrics,
  type EnablementPolicy,
  type OutOfSampleSegment,
} from '@app/contracts';

// Only the three gate-relevant metrics matter; the rest of BacktestMetrics is
// filled with neutral values so the type is satisfied.
const metrics = (over: Partial<BacktestMetrics>): BacktestMetrics =>
  ({
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
    totalTrades: 50,
    winRate: 60,
    wins: 30,
    losses: 20,
    profitFactor: 2,
    expectancy: '10',
    bestTradePct: 5,
    worstTradePct: -3,
    avgTradePnl: '10',
    avgTradeDurationMs: 3_600_000,
    ...over,
  }) as BacktestMetrics;

// Default policy: PF>=1.1, trades>=100, alpha>=0, requireOutOfSample on (OOS trades>=20).
const policy: EnablementPolicy = DEFAULT_ENABLEMENT_POLICY;

// A holdout slice that clears the gate's bars.
const oos = (over: Partial<OutOfSampleSegment> = {}): OutOfSampleSegment => ({
  fraction: 0.3,
  fromMs: 1,
  toMs: 2,
  returnPct: 3,
  holdReturnPct: 1,
  alphaVsHoldPct: 2,
  trades: 40,
  winRate: 60,
  profitFactor: 1.5,
  expectancy: '5',
  ...over,
});

describe('<GateScorecard>', () => {
  it('clears the bar when the full run AND the holdout beat every threshold', () => {
    render(
      <GateScorecard
        metrics={metrics({ totalTrades: 120 })}
        outOfSample={oos()}
        dataWarnings={[]}
        policy={policy}
      />,
    );
    expect(screen.getByTestId('gate-scorecard-verdict')).toHaveTextContent(/clears the bar/i);
    // Each criterion renders its actual + need.
    expect(screen.getByTestId('gate-check-profit-factor')).toHaveTextContent(/2\.00.*need >= 1\.1/);
    // The holdout criteria render too.
    expect(screen.getByTestId('gate-check-out-of-sample-profit-factor')).toBeInTheDocument();
    // The gate-off note must not leak into the normal (enabled) case.
    expect(screen.getByTestId('gate-scorecard')).not.toHaveTextContent(/turned off/i);
  });

  it('counts the criteria below threshold and warns', () => {
    render(
      <GateScorecard
        metrics={metrics({ profitFactor: 1.0, totalTrades: 12, alphaVsHoldPct: 5 })}
        outOfSample={oos()}
        dataWarnings={[]}
        policy={policy}
      />,
    );
    // profit factor + closed trades fail; alpha + all three holdout checks pass → 2 below.
    expect(screen.getByTestId('gate-scorecard-verdict')).toHaveTextContent(/2 below threshold/i);
  });

  it('flags a missing out-of-sample holdout as failing', () => {
    render(
      <GateScorecard
        metrics={metrics({ totalTrades: 120 })}
        outOfSample={null}
        dataWarnings={[]}
        policy={policy}
      />,
    );
    expect(screen.getByTestId('gate-check-out-of-sample-validation')).toHaveTextContent(/missing/i);
    expect(screen.getByTestId('gate-scorecard-verdict')).toHaveTextContent(/1 below threshold/i);
  });

  it('notes when the gate is turned off for the profile', () => {
    render(
      <GateScorecard
        metrics={metrics({})}
        outOfSample={oos()}
        dataWarnings={[]}
        policy={{ ...policy, enabled: false }}
      />,
    );
    expect(screen.getByTestId('gate-scorecard')).toHaveTextContent(/gate is currently turned off/i);
  });

  it('fails the data-coverage criterion when the run carried coverage warnings', () => {
    render(
      <GateScorecard
        metrics={metrics({ totalTrades: 120 })}
        outOfSample={oos()}
        dataWarnings={['SOLUSDT: only 60% of the expected 1h candles are present']}
        policy={policy}
      />,
    );
    expect(screen.getByTestId('gate-check-data-coverage')).toHaveTextContent(/gaps/i);
    expect(screen.getByTestId('gate-scorecard-verdict')).toHaveTextContent(/1 below threshold/i);
  });
});
