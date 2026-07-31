import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { BacktestTrade } from '@app/contracts';

import { BacktestFills } from '@/features/backtest/components/backtest-fills';

/** `n` fills, alternating BUY/SELL so the side filter has both. */
function makeFills(n: number): BacktestTrade[] {
  return Array.from({ length: n }, (_, i) => ({
    symbol: 'BTCUSDT',
    side: i % 2 === 0 ? 'BUY' : 'SELL',
    reason: 'grid',
    price: '100' as never,
    qty: '0.5' as never,
    feeQuote: '0.1' as never,
    tsMs: i * 1000,
  }));
}

/** Data rows in the fills table (excludes the thead row). */
function fillRowCount(): number {
  const table = screen.getByTestId('backtest-fills-table');
  return within(table).getAllByRole('row').length - 1;
}

describe('BacktestFills pagination + filter', () => {
  it('paginates at the default 10 rows and steps with Prev/Next', async () => {
    const user = userEvent.setup();
    render(<BacktestFills trades={makeFills(15)} timeZone="UTC" />);

    expect(fillRowCount()).toBe(10);
    expect(screen.getByTestId('bt-fills-range')).toHaveTextContent('Showing 1–10 of 15');
    expect(screen.getByTestId('bt-fills-prev')).toBeDisabled();

    await user.click(screen.getByTestId('bt-fills-next'));
    expect(fillRowCount()).toBe(5);
    expect(screen.getByTestId('bt-fills-range')).toHaveTextContent('Showing 11–15 of 15');
    expect(screen.getByTestId('bt-fills-next')).toBeDisabled();
  });

  it('changing rows-per-page repaginates and resets to page 1', async () => {
    const user = userEvent.setup();
    render(<BacktestFills trades={makeFills(60)} timeZone="UTC" />);

    await user.click(screen.getByTestId('bt-fills-next')); // page 2
    await user.selectOptions(screen.getByTestId('bt-fills-page-size'), '25');

    expect(fillRowCount()).toBe(25);
    expect(screen.getByTestId('bt-fills-range')).toHaveTextContent('Showing 1–25 of 60');
  });

  it('filters the table by side, resetting the page', async () => {
    const user = userEvent.setup();
    render(<BacktestFills trades={makeFills(60)} timeZone="UTC" />);

    // 60 alternating fills → 30 buys, 30 sells.
    await user.click(screen.getByTestId('bt-fills-next')); // move off page 1
    await user.click(screen.getByTestId('bt-fills-filter-sells'));

    expect(screen.getByTestId('bt-fills-range')).toHaveTextContent('Showing 1–10 of 30');
    expect(fillRowCount()).toBe(10);
  });

  it('shows the empty state when there are no fills', () => {
    render(<BacktestFills trades={[]} timeZone="UTC" />);
    expect(screen.getByText('No fills.')).toBeInTheDocument();
  });
});
