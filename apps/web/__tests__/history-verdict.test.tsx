// HistoryVerdict — the period's headline figures and the evidence they rest on.
//
// Every case drives ONE bucket set through the component, so anything that differs between them is the fee evidence and not the arithmetic.

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HistoryVerdict, type VerdictBucket } from '@/features/profile/components/history-verdict';

/** A by-source bucket carrying only what the verdict folds. `netTradeCount` follows the producer's invariant: `unknown` is reported exactly when nothing could be valued. */
function bucket(over: Partial<VerdictBucket> = {}): VerdictBucket {
  const merged: VerdictBucket = {
    quoteAsset: 'USDT',
    tradeCount: 5,
    netTradeCount: 5,
    wins: 4,
    losses: 1,
    profitSum: '30',
    netProfit: '28',
    grossProfit: '12',
    grossLoss: '2',
    totalFees: '2',
    feeBasis: 'exact',
    ...over,
  };
  return merged;
}

const renderVerdict = (buckets: readonly VerdictBucket[], basis: 'net' | 'gross' = 'net'): void => {
  render(<HistoryVerdict buckets={buckets} basis={basis} />);
};

describe('<HistoryVerdict>', () => {
  it('renders nothing when the period holds no cycles', () => {
    const { container } = render(<HistoryVerdict buckets={[]} basis="net" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the six figures a verdict is made of', () => {
    renderVerdict([bucket()]);
    // 28 net over 5 cycles, 4 of them ahead; winners 12 against losers 2 → PF 6, expectancy +2.00, fees 2 of the 14 the cycles produced.
    expect(screen.getByTestId('verdict-pnl-USDT')).toHaveTextContent('+28.00');
    expect(screen.getByTestId('verdict-trades-USDT')).toHaveTextContent('5');
    expect(screen.getByTestId('verdict-winrate-USDT')).toHaveTextContent('80.00%');
    expect(screen.getByTestId('verdict-expectancy-USDT')).toHaveTextContent('+2.00');
    expect(screen.getByTestId('verdict-pf-USDT')).toHaveTextContent('6');
    expect(screen.getByTestId('verdict-fees-USDT')).toHaveTextContent('14.29%');
  });

  it('states the covered count when the period left cycles out of its Net figure', () => {
    // The whole point of the second denominator: the figure stands, and says what it covers, where the old rule blanked it.
    renderVerdict([bucket({ tradeCount: 7, netTradeCount: 5 })]);
    expect(screen.getByTestId('verdict-pnl-USDT')).toHaveTextContent('+28.00');
    // Stated once under the block rather than inside the amount tile, because it qualifies the four fee-derived tiles as much as the amount.
    const coverage = screen.getByTestId('verdict-coverage-USDT');
    expect(coverage).toHaveTextContent('5 of 7 cycles');
    expect(coverage).toHaveTextContent('The amount above');
    // The trade count is the whole period, and stays that way: excluding a cycle from the Net figure does not remove it from the archive.
    expect(screen.getByTestId('verdict-trades-USDT')).toHaveTextContent('7');
  });

  it('says nothing about coverage when every cycle was valued', () => {
    // Or the disclosure becomes noise the reader learns to skip past.
    renderVerdict([bucket()]);
    expect(screen.queryByTestId('verdict-coverage-USDT')).toBeNull();
  });

  it('withholds every fee-derived figure when nothing in the period could be valued', () => {
    renderVerdict([bucket({ netTradeCount: 0, netProfit: '0', feeBasis: 'unknown' })]);
    for (const id of [
      'verdict-pnl',
      'verdict-winrate',
      'verdict-expectancy',
      'verdict-pf',
      'verdict-fees',
    ]) {
      expect(
        within(screen.getByTestId(`${id}-USDT`)).getByRole('img', { name: 'Net P/L unavailable' }),
      ).toHaveTextContent('net n/a');
    }
    // The count is a count, and survives having no fee evidence at all.
    expect(screen.getByTestId('verdict-trades-USDT')).toHaveTextContent('5');
  });

  it('keeps the four net-classified figures withheld under the Recorded basis too', () => {
    // The basis selects which AMOUNT is shown; it cannot rescue a win rate or a profit factor, which are read off the fee-adjusted money whichever amount sits above them.
    renderVerdict([bucket({ netTradeCount: 0, netProfit: '0', feeBasis: 'unknown' })], 'gross');
    expect(screen.getByTestId('verdict-pnl-USDT')).toHaveTextContent('+30.00');
    expect(screen.getByTestId('verdict-winrate-USDT')).toHaveTextContent('net n/a');
    expect(screen.getByTestId('verdict-pf-USDT')).toHaveTextContent('net n/a');
  });

  it('marks an estimated period in words rather than by tint', () => {
    renderVerdict([bucket({ feeBasis: 'estimated' })]);
    expect(screen.getByTestId('verdict-pnl-USDT')).toHaveTextContent('estimated');
  });

  it('states BOTH the coverage and the estimate, which is the common case', () => {
    // A ternary chain made them mutually exclusive, so a window that left cycles out AND priced the rest off the rate card disclosed only the first — and a window whose fees were partly reconstructed is exactly the kind that also has cycles it could not value at all. They now sit in two places, which is what makes both survivable.
    renderVerdict([bucket({ tradeCount: 7, netTradeCount: 5, feeBasis: 'estimated' })]);
    expect(screen.getByTestId('verdict-pnl-USDT')).toHaveTextContent('estimated');
    expect(screen.getByTestId('verdict-coverage-USDT')).toHaveTextContent('5 of 7 cycles');
  });

  it('drops the estimate note under Recorded, which subtracts no fee at all', () => {
    // The Recorded amount is the same number at every tier and is summed over every cycle, so no fee tier qualifies it.
    renderVerdict([bucket({ tradeCount: 7, netTradeCount: 5, feeBasis: 'estimated' })], 'gross');
    const pnl = screen.getByTestId('verdict-pnl-USDT');
    expect(pnl).toHaveTextContent('+30.00');
    expect(pnl.textContent ?? '').not.toContain('estimated');
  });

  it('keeps the coverage disclosure under Recorded, where it describes the four tiles below', () => {
    // The defect this closes: switching basis took the only coverage statement on the block away with the amount, and left win rate, expectancy, profit factor and fee drag — all read off the fee-adjusted money at every basis — sitting beside an unqualified Trades count that contradicts them. The wording narrows to the tiles it still covers rather than disappearing.
    renderVerdict([bucket({ tradeCount: 7, netTradeCount: 5, feeBasis: 'estimated' })], 'gross');
    const coverage = screen.getByTestId('verdict-coverage-USDT');
    expect(coverage).toHaveTextContent('5 of 7 cycles');
    expect(coverage).toHaveTextContent('Win rate, expectancy, profit factor and fee drag');
    // And it does NOT claim the Recorded amount above it, which spans all seven.
    expect(coverage.textContent ?? '').not.toContain('The amount above');
  });

  it('keeps each quote coin on its own verdict rather than adding two currencies', () => {
    // A profile whose quote changed carries cycles in two currencies, and one merged block would add a BTC figure to a USDT one under whichever name came first.
    renderVerdict([
      bucket({ quoteAsset: 'USDT', profitSum: '30', netProfit: '28' }),
      bucket({ quoteAsset: 'BTC', profitSum: '0.5', netProfit: '0.4' }),
    ]);
    expect(screen.getByTestId('verdict-pnl-USDT')).toHaveTextContent('+28.00');
    expect(screen.getByTestId('verdict-pnl-BTC')).toHaveTextContent('+0.4');
  });

  it('presents the figures as a non-interactive summary', () => {
    renderVerdict([bucket()]);
    const verdict = screen.getByRole('region', { name: 'Verdict for USDT' });
    expect(within(verdict).queryByRole('button')).toBeNull();
    expect(within(verdict).getAllByRole('term')).toHaveLength(6);
    expect(screen.getByTestId('verdict-trades-USDT')).toHaveTextContent(
      'Closed buy-then-sell cycles in this period',
    );
  });
});
