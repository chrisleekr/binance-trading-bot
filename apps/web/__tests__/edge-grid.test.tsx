// The edge grid: the period's buckets as a sortable table from `md` up, and as the same compact cards below it.
//
// Both renders are always in the DOM — which one is visible is a CSS decision — so every case here addresses one of them by its own testid prefix. `edge-` for the table, `edge-card-` for the cards.

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { EdgeGrid, type EdgeBucket } from '@/features/profile/components/edge-grid';

type IntentBucket = EdgeBucket & { readonly intent: string };

/** A bucket with everything valued, so a case only has to state what it is about. */
const bucket = (over: Partial<IntentBucket> & { intent: string }): IntentBucket => ({
  quoteAsset: 'USDT',
  tradeCount: 2,
  netTradeCount: 2,
  wins: 1,
  losses: 1,
  profitSum: '10',
  netProfit: '10',
  grossProfit: '12',
  grossLoss: '2',
  totalFees: '0',
  feeBasis: 'exact',
  share: 50,
  multiQuote: false,
  avgHoldMs: 3 * 60 * 60 * 1000,
  ...over,
});

const renderGrid = (rows: readonly IntentBucket[], basis: 'net' | 'gross' = 'net'): void => {
  render(
    <EdgeGrid
      dimension="intent"
      title="P/L by exit reason"
      rows={rows}
      basis={basis}
      labelOf={(b) => b.intent}
      valueOf={(b) => b.intent}
      onSelect={() => undefined}
    />,
  );
};

/** The dimension values of the table's rows, top to bottom. */
const order = (): string[] =>
  within(screen.getByTestId('edge-table-intent'))
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.getAttribute('data-testid') ?? '')
    .map((id) => id.replace('edge-intent-USDT-', ''));

/** The five columns that order the grid. The dimension column and the share column order nothing, so they carry no `aria-sort` and are not part of the announcement contract. */
const SORTABLE = ['trades', 'win', 'net', 'exp', 'hold'] as const;

/**
 * The nearest ancestor carrying every one of `tokens` as a class.
 *
 * Token-matched via `[class~=]` rather than a substring search, because `md:hidden` contains `hidden`: a substring test cannot tell the two renders' scopes apart, which is exactly the pairing under test.
 *
 * @param el - The element whose visibility scope is being asked about.
 * @param tokens - The class tokens that together define one breakpoint scope.
 * @returns That ancestor, or null when nothing above `el` carries them all.
 */
function scopedBy(el: Element, tokens: readonly string[]): Element | null {
  return el.closest(tokens.map((t) => `[class~="${t}"]`).join(''));
}

describe('<EdgeGrid>', () => {
  it('opens in the order it was given, with no column claiming to sort it', () => {
    renderGrid([bucket({ intent: 'a', netProfit: '1' }), bucket({ intent: 'b', netProfit: '9' })]);
    expect(order()).toEqual(['a', 'b']);
    // Exact, not `not.toBe('descending')`: 'ascending', 'other' and a missing attribute all satisfy that, so a header stuck on the wrong announcement would pass it. Read off the sortable headers only — the two that order nothing carry no `aria-sort` by design.
    for (const key of SORTABLE) {
      expect(screen.getByTestId(`edge-sort-intent-${key}`).closest('th')).toHaveAttribute(
        'aria-sort',
        'none',
      );
    }
  });

  it('sorts descending on the first click and flips on the second, announcing both', async () => {
    renderGrid([bucket({ intent: 'a', netProfit: '1' }), bucket({ intent: 'b', netProfit: '9' })]);

    await userEvent.click(screen.getByTestId('edge-sort-intent-net'));
    expect(order()).toEqual(['b', 'a']);
    // The announced direction is the only thing a screen reader has: an arrow glyph is decorative.
    expect(screen.getByTestId('edge-sort-intent-net').closest('th')).toHaveAttribute(
      'aria-sort',
      'descending',
    );

    await userEvent.click(screen.getByTestId('edge-sort-intent-net'));
    expect(order()).toEqual(['a', 'b']);
    expect(screen.getByTestId('edge-sort-intent-net').closest('th')).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
  });

  it('sorts a bucket that could time nothing to the end under BOTH directions', async () => {
    renderGrid([
      bucket({ intent: 'untimed', avgHoldMs: null }),
      bucket({ intent: 'short', avgHoldMs: 60_000 }),
      bucket({ intent: 'long', avgHoldMs: 90 * 60 * 1000 }),
    ]);

    await userEvent.click(screen.getByTestId('edge-sort-intent-hold'));
    expect(order()).toEqual(['long', 'short', 'untimed']);
    await userEvent.click(screen.getByTestId('edge-sort-intent-hold'));
    // Ascending puts the shortest first — and still leaves the unmeasured one last, because it is not a hold of zero.
    expect(order()).toEqual(['short', 'long', 'untimed']);
  });

  it('withholds every fee-derived figure for a bucket that valued no cycle, but keeps its count', () => {
    renderGrid([bucket({ intent: 'unvalued', netTradeCount: 0, feeBasis: 'unknown' })]);
    const row = screen.getByTestId('edge-intent-USDT-unvalued');
    expect(row).toHaveTextContent('2');
    // Three withheld cells: win rate, net and expectancy. Each is a marker with an accessible description, not a fabricated zero.
    expect(within(row).getAllByRole('img')).toHaveLength(3);
  });

  it('sorts an unvalued bucket last on a fee-derived column, whichever way it is pointed', async () => {
    renderGrid([
      bucket({ intent: 'unvalued', netTradeCount: 0, feeBasis: 'unknown', netProfit: '0' }),
      bucket({ intent: 'valued', netProfit: '5' }),
    ]);
    await userEvent.click(screen.getByTestId('edge-sort-intent-net'));
    expect(order()).toEqual(['valued', 'unvalued']);
    await userEvent.click(screen.getByTestId('edge-sort-intent-net'));
    expect(order()).toEqual(['valued', 'unvalued']);
  });

  it('orders the P/L column by the Recorded amount the Recorded basis renders', async () => {
    // The cell shows `profitSum` under Recorded and `netProfit` under Net, and the two rank the rows opposite ways here. A sort key pinned to `netProfit` would put `b` on top while the column displays 1 above 9 — a table that orders by a number it does not show.
    renderGrid(
      [
        bucket({ intent: 'a', profitSum: '9', netProfit: '1' }),
        bucket({ intent: 'b', profitSum: '1', netProfit: '9' }),
      ],
      'gross',
    );
    await userEvent.click(screen.getByTestId('edge-sort-intent-net'));
    expect(order()).toEqual(['a', 'b']);
    await userEvent.click(screen.getByTestId('edge-sort-intent-net'));
    expect(order()).toEqual(['b', 'a']);
  });

  it('still orders the P/L column by the Net amount under the Net basis', async () => {
    // Anchors the case above: without it, reading `profitSum` unconditionally would pass just as well.
    renderGrid([
      bucket({ intent: 'a', profitSum: '9', netProfit: '1' }),
      bucket({ intent: 'b', profitSum: '1', netProfit: '9' }),
    ]);
    await userEvent.click(screen.getByTestId('edge-sort-intent-net'));
    expect(order()).toEqual(['b', 'a']);
  });

  it('ranks an unvalued bucket under the Recorded basis, which needs no fee evidence', async () => {
    // The Recorded amount is summed over every row, so a bucket that valued nothing still has a real Recorded figure and a real rank. Withholding it here would sort a displayed 20 below a displayed 5.
    renderGrid(
      [
        bucket({ intent: 'valued', profitSum: '5', netProfit: '5' }),
        bucket({
          intent: 'unvalued',
          netTradeCount: 0,
          feeBasis: 'unknown',
          profitSum: '20',
          netProfit: '0',
        }),
      ],
      'gross',
    );
    await userEvent.click(screen.getByTestId('edge-sort-intent-net'));
    expect(order()).toEqual(['unvalued', 'valued']);
  });

  it('hands the ledger the bucket’s own value from either render', async () => {
    const onSelect = vi.fn();
    render(
      <EdgeGrid
        dimension="intent"
        title="P/L by exit reason"
        rows={[bucket({ intent: 'grid-sell' })]}
        basis="net"
        labelOf={(b) => b.intent}
        valueOf={(b) => b.intent}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByTestId('edge-open-intent-USDT-grid-sell'));
    await userEvent.click(screen.getByTestId('edge-card-intent-USDT-grid-sell'));
    expect(onSelect.mock.calls).toEqual([['grid-sell'], ['grid-sell']]);
  });

  it('states the covered cycles beside a partly-valued amount, on the row that carries no stats line', async () => {
    // The card path gets this from `RollupStatsLine`; the table row does not render that line at all, so the disclosure is a separate piece of production code with a separate way of going missing. Without it a 3-of-10-cycle net sits beside a `10` trade count with nothing saying they are different denominators.
    renderGrid([
      bucket({ intent: 'partial', tradeCount: 10, netTradeCount: 3 }),
      bucket({ intent: 'whole', tradeCount: 4, netTradeCount: 4 }),
    ]);
    expect(screen.getByTestId('edge-partial-intent-USDT-partial')).toHaveTextContent(
      '3 of 10 cycles',
    );
    // A bucket that valued everything states nothing extra: an unconditional line would be noise on every row, and would stop distinguishing the two.
    expect(screen.queryByTestId('edge-partial-intent-USDT-whole')).toBeNull();
  });

  it('mounts the cards and the table as a breakpoint PAIR, never both visible at one width', () => {
    // The choice between them is CSS, so both are always in the DOM and only the class pairing keeps one of them off screen. Delete `md:hidden` and a phone renders every bucket twice; delete `hidden` and a desktop does.
    renderGrid([bucket({ intent: 'grid-sell' })]);
    // Matched on the class TOKEN rather than a substring, because `md:hidden` contains `hidden` and a substring test would call the cards' own scope a desktop-only one.
    expect(
      scopedBy(screen.getByTestId('edge-card-intent-USDT-grid-sell'), ['md:hidden']),
    ).not.toBeNull();
    expect(
      scopedBy(screen.getByTestId('edge-card-intent-USDT-grid-sell'), ['hidden', 'md:block']),
    ).toBeNull();
    expect(
      scopedBy(screen.getByTestId('edge-table-intent'), ['hidden', 'md:block']),
    ).not.toBeNull();
    expect(scopedBy(screen.getByTestId('edge-table-intent'), ['md:hidden'])).toBeNull();
  });

  it('renders nothing at all for a period with no buckets, rather than an empty frame', () => {
    renderGrid([]);
    expect(screen.queryByTestId('edge-table-intent')).toBeNull();
    expect(screen.queryByTestId('archive-by-intent')).toBeNull();
  });
});
