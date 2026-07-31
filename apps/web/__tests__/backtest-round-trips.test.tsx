import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { BacktestRoundTrip } from '@app/contracts';

import { BacktestRoundTrips } from '@/features/backtest/components/backtest-round-trips';

/** `n` round-trips, alternating winner/loser so the outcome filter has both. */
function makeRoundTrips(n: number): BacktestRoundTrip[] {
  return Array.from({ length: n }, (_, i) => {
    const win = i % 2 === 0;
    return {
      symbol: 'BTCUSDT',
      entryPrice: '100' as never,
      exitPrice: (win ? '110' : '95') as never,
      qty: '0.5' as never,
      pnlQuote: (win ? '5' : '-5') as never,
      returnPct: win ? 5 : -5,
      feeQuote: '0.1' as never,
      openTsMs: i * 1000,
      closeTsMs: i * 1000 + 500,
      durationMs: 600_000,
      exitReason: 'grid-sell',
    };
  });
}

/** Data rows in the per-trade table (excludes the thead row). */
function tradeRowCount(): number {
  const table = screen.getByTestId('backtest-round-trips-table');
  return within(table).getAllByRole('row').length - 1;
}

describe('BacktestRoundTrips pagination + filter', () => {
  it('paginates at the default 10 rows and steps with Prev/Next', async () => {
    const user = userEvent.setup();
    render(<BacktestRoundTrips roundTrips={makeRoundTrips(15)} timeZone="UTC" />);

    expect(tradeRowCount()).toBe(10);
    expect(screen.getByTestId('bt-trades-range')).toHaveTextContent('Showing 1–10 of 15');
    expect(screen.getByTestId('bt-trades-prev')).toBeDisabled();

    await user.click(screen.getByTestId('bt-trades-next'));
    expect(tradeRowCount()).toBe(5);
    expect(screen.getByTestId('bt-trades-range')).toHaveTextContent('Showing 11–15 of 15');
    expect(screen.getByTestId('bt-trades-next')).toBeDisabled();
  });

  it('changing rows-per-page repaginates and resets to page 1', async () => {
    const user = userEvent.setup();
    render(<BacktestRoundTrips roundTrips={makeRoundTrips(60)} timeZone="UTC" />);

    await user.click(screen.getByTestId('bt-trades-next')); // page 2
    await user.selectOptions(screen.getByTestId('bt-trades-page-size'), '25');

    expect(tradeRowCount()).toBe(25);
    expect(screen.getByTestId('bt-trades-range')).toHaveTextContent('Showing 1–25 of 60');
  });

  it('filters the table to winners or losers, resetting the page, while the summary stays full', async () => {
    const user = userEvent.setup();
    render(<BacktestRoundTrips roundTrips={makeRoundTrips(60)} timeZone="UTC" />);

    // 60 alternating trips → 30 wins, 30 losses. Summary win rate stays over all 60.
    expect(screen.getByTestId('backtest-round-trips-summary')).toHaveTextContent('50.00% won');

    await user.click(screen.getByTestId('bt-trades-next')); // move off page 1
    await user.click(screen.getByTestId('bt-trades-filter-losses'));

    expect(screen.getByTestId('bt-trades-range')).toHaveTextContent('Showing 1–10 of 30');
    expect(tradeRowCount()).toBe(10);
    // Win rate summary unaffected by the table filter.
    expect(screen.getByTestId('backtest-round-trips-summary')).toHaveTextContent('50.00% won');
  });
});
