// A refused cost-basis seed is invisible today. The operator submits an average entry price, the api accepts it and writes the ledger row, and the worker then refuses to hand the strategy a position because nothing sellable backs the symbol — a refusal that lives only in a worker log line. The row it declined is still projected, so this strip renders it as a real holding AND signs an unrealised P/L against it: a number computed from a position the bot does not have and will never sell.
//
// So the refusal has to reach the same cell as the number it contradicts, and the P/L has to go to the em dash. A warning banner elsewhere on the page would leave the fabricated figure standing where the operator actually looks.

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SymbolPositionStrip } from '@/features/symbol/components/symbol-position-strip';
import type { SymbolStateResponse } from '@app/contracts';

const state = (refusal: { code: string; since: string } | null): SymbolStateResponse =>
  ({
    avgEntryPrice: {
      avgEntryPrice: '0.0860',
      quantity: '169.8',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    openOrders: [],
    positionSeedRefusal: refusal,
  }) as unknown as SymbolStateResponse;

const REFUSAL = { code: 'no-sellable-position', since: '2026-08-26T00:00:00.000Z' };

// The P/L cell is the value span under its own label; located through the label so the assertion does not depend on a testid the component is free to move.
const pnlCell = (): HTMLElement => screen.getByText('Unrealised P/L').parentElement as HTMLElement;

describe('<SymbolPositionStrip> with a refused position seed', () => {
  it('names the refusal in the Position cell the ledger row is rendered in', () => {
    render(<SymbolPositionStrip state={state(REFUSAL)} currentPrice="0.0893" symbol="XPLUSDT" />);
    const refusal = screen.getByTestId('symbol-position-refusal');
    // Words, not only a glyph: "⚠" beside a quantity reads as a warning about the number, not as "the bot holds nothing here".
    expect(refusal).toHaveTextContent(/not held/i);
    // The operator's own figure is untouched — the refusal explains the row, it does not erase it. Deleting a record the api accepted seconds earlier would leave the two surfaces contradicting each other.
    expect(screen.getByTestId('symbol-position')).toHaveTextContent('169.8');
  });

  it('drops the unrealised P/L to an em dash rather than signing a fabricated one', () => {
    render(<SymbolPositionStrip state={state(REFUSAL)} currentPrice="0.0893" symbol="XPLUSDT" />);
    // (0.0893 - 0.0860) * 169.8 ≈ +0.56 — a gain on a position the strategy refused to open.
    expect(pnlCell()).toHaveTextContent('—');
    expect(pnlCell().textContent).not.toMatch(/\d/);
    // No quote unit either: a unit is what makes a number read as money the operator has.
    expect(within(screen.getByTestId('symbol-position-strip')).queryByText('USDT')).toBeNull();
  });

  it('binds the refusal to the quantity a screen reader hears, not to the layout', () => {
    render(<SymbolPositionStrip state={state(REFUSAL)} currentPrice="0.0893" symbol="XPLUSDT" />);
    const describedBy = screen.getByTestId('symbol-position').getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(screen.getByTestId('symbol-position-refusal').id).toBe(describedBy);
  });

  it('binds the refusal to a Flat position too, which is the shape the orphan paths leave behind', () => {
    // Flat-with-a-refusal is not a contradiction: the cost basis is on file and the state body is empty, so the cell that needs the explanation most is the one with nothing in it. A binding written on the held branch alone reads as covered and is absent exactly here.
    render(
      <SymbolPositionStrip
        state={{ openOrders: [], positionSeedRefusal: REFUSAL } as unknown as SymbolStateResponse}
        currentPrice="0.0893"
        symbol="XPLUSDT"
      />,
    );
    const position = screen.getByTestId('symbol-position');
    expect(position).toHaveTextContent('Flat');
    expect(screen.getByTestId('symbol-position-refusal').id).toBe(
      position.getAttribute('aria-describedby'),
    );
    expect(position.getAttribute('aria-describedby')).not.toBeNull();
  });

  it('shows the signed P/L and no refusal when the seed was applied', () => {
    // The other half of the guard: a strip that rendered the refusal unconditionally would satisfy every assertion above.
    render(<SymbolPositionStrip state={state(null)} currentPrice="0.0893" symbol="XPLUSDT" />);
    expect(screen.queryByTestId('symbol-position-refusal')).toBeNull();
    expect(pnlCell()).toHaveTextContent(/\+0/);
    expect(
      within(screen.getByTestId('symbol-position-strip')).getByText('USDT'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('symbol-position')).not.toHaveAttribute('aria-describedby');
  });
});
