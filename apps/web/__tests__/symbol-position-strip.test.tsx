// SymbolPositionStrip — the operator's own stake on the open symbol: held
// position (qty @ entry), resting-order count, and unrealised P/L. The strip
// only reads `avgEntryPrice` + `openOrders` off the symbol state, so the
// fixtures cast a minimal shape.

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SymbolPositionStrip } from '@/features/symbol/components/symbol-position-strip';
import type { SymbolStateResponse } from '@app/contracts';

const state = (
  pos: { avgEntryPrice: string; quantity: string } | null,
  openOrders: unknown[] = [],
): SymbolStateResponse =>
  ({
    avgEntryPrice: pos ? { ...pos, updatedAt: '2026-01-01T00:00:00.000Z' } : null,
    openOrders,
  }) as unknown as SymbolStateResponse;

describe('<SymbolPositionStrip>', () => {
  it('shows the held quantity @ entry, order count, and a positive unrealised P/L', () => {
    render(
      <SymbolPositionStrip
        state={state({ avgEntryPrice: '0.0860', quantity: '169.8' }, [{}, {}])}
        currentPrice="0.0893"
        symbol="XPLUSDT"
      />,
    );
    // (0.0893 - 0.0860) * 169.8 ≈ +0.56 USDT
    expect(screen.getByTestId('symbol-position')).toHaveTextContent('169.8');
    expect(screen.getByTestId('symbol-position')).toHaveTextContent('0.086');
    expect(screen.getByTestId('symbol-open-orders')).toHaveTextContent('2');
    const strip = screen.getByTestId('symbol-position-strip');
    expect(within(strip).getByText(/\+0/)).toBeInTheDocument(); // positive P/L
    expect(within(strip).getByText('USDT')).toBeInTheDocument(); // unit on a held P/L
  });

  it('reads "Flat" with an em-dash P/L and zero orders when there is no position', () => {
    render(<SymbolPositionStrip state={state(null, [])} currentPrice="0.0893" symbol="XPLUSDT" />);
    expect(screen.getByTestId('symbol-position')).toHaveTextContent('Flat');
    expect(screen.getByTestId('symbol-open-orders')).toHaveTextContent('0');
    // Flat P/L has no quote unit.
    expect(within(screen.getByTestId('symbol-position-strip')).queryByText('USDT')).toBeNull();
  });
});
