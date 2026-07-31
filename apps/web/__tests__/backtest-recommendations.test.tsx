import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BacktestResult } from '@app/contracts';

import { BacktestRecommendations } from '@/features/backtest/components/backtest-recommendations';

type Breakdown = BacktestResult['decisionBreakdown'];

// Two armed indicator gates both biting, so two suggestions appear.
const TWO_GATE_BREAKDOWN: Breakdown = {
  metrics: [{ name: 'tt_tick_pure_path', tags: { symbol: 'SOLUSDT' }, count: 100 }],
  logs: [
    { level: 'info', message: 'tt-indicator-gate-veto', reason: 'indicator-rsi', count: 80 },
    { level: 'info', message: 'tt-indicator-gate-veto', reason: 'indicator-sma', count: 20 },
  ],
};

const ARMED_CONFIG: Record<string, unknown> = {
  buy: { indicatorGate: { rsiMaxBuy: '30', smaBias: 'price-below-sma', emaBias: 'off' } },
};

describe('BacktestRecommendations', () => {
  it('stages a suggestion on click and loads it only when the button is pressed', () => {
    const onApply = vi.fn();
    render(
      <BacktestRecommendations
        breakdown={TWO_GATE_BREAKDOWN}
        config={ARMED_CONFIG}
        onApply={onApply}
      />,
    );
    const load = screen.getByTestId('backtest-rec-load-selected');
    // Nothing selected → the load button is disabled and clicking a card does not apply.
    expect(load).toBeDisabled();
    const rsiToggle = screen.getByTestId('backtest-rec-toggle-indicator-rsi');
    fireEvent.click(rsiToggle);
    expect(rsiToggle).toHaveAttribute('aria-pressed', 'true');
    expect(onApply).not.toHaveBeenCalled(); // selecting does not run / load
    expect(load).toBeEnabled();
    fireEvent.click(load);
    expect(onApply).toHaveBeenCalledTimes(1);
    const next = onApply.mock.calls[0]?.[0] as {
      buy: { indicatorGate: { rsiMaxBuy: string; smaBias: string } };
    };
    expect(next.buy.indicatorGate.rsiMaxBuy).toBe(''); // RSI removed
    expect(next.buy.indicatorGate.smaBias).toBe('price-below-sma'); // SMA not selected, untouched
  });

  it('composes multiple selected suggestions into one config', () => {
    const onApply = vi.fn();
    render(
      <BacktestRecommendations
        breakdown={TWO_GATE_BREAKDOWN}
        config={ARMED_CONFIG}
        onApply={onApply}
      />,
    );
    fireEvent.click(screen.getByTestId('backtest-rec-toggle-indicator-rsi'));
    fireEvent.click(screen.getByTestId('backtest-rec-toggle-indicator-sma'));
    expect(screen.getByTestId('backtest-rec-load-selected')).toHaveTextContent('Load 2 changes');
    fireEvent.click(screen.getByTestId('backtest-rec-load-selected'));
    const next = onApply.mock.calls[0]?.[0] as {
      buy: { indicatorGate: { rsiMaxBuy: string; smaBias: string } };
    };
    expect(next.buy.indicatorGate.rsiMaxBuy).toBe(''); // both removed
    expect(next.buy.indicatorGate.smaBias).toBe('off');
  });

  it('deselects on a second click', () => {
    render(
      <BacktestRecommendations
        breakdown={TWO_GATE_BREAKDOWN}
        config={ARMED_CONFIG}
        onApply={vi.fn()}
      />,
    );
    const toggle = screen.getByTestId('backtest-rec-toggle-indicator-rsi');
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('backtest-rec-load-selected')).toBeDisabled();
  });

  it('clears the staged selection when remounted for a new run (keyed by run)', () => {
    // The route keys this component on the run id, so switching runs remounts it.
    // A new key must start with a clean selection — a pick on run A must not bleed
    // into run B.
    const { rerender } = render(
      <BacktestRecommendations
        key="runA"
        breakdown={TWO_GATE_BREAKDOWN}
        config={ARMED_CONFIG}
        onApply={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('backtest-rec-toggle-indicator-rsi'));
    expect(screen.getByTestId('backtest-rec-toggle-indicator-rsi')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    rerender(
      <BacktestRecommendations
        key="runB"
        breakdown={TWO_GATE_BREAKDOWN}
        config={ARMED_CONFIG}
        onApply={vi.fn()}
      />,
    );
    expect(screen.getByTestId('backtest-rec-toggle-indicator-rsi')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByTestId('backtest-rec-load-selected')).toBeDisabled();
  });

  it('renders nothing when no armed gate is biting', () => {
    const { container } = render(
      <BacktestRecommendations
        breakdown={{ metrics: [], logs: [] }}
        config={ARMED_CONFIG}
        onApply={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('backtest-recommendations')).not.toBeInTheDocument();
  });
});
