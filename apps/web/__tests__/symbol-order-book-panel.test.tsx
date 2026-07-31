// SymbolOrderBookPanel — ask/bid ladder, spread row, loading and error states.

import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SymbolOrderBookPanel } from '../src/features/symbol/components/symbol-order-book-panel.js';
import { createQueryClient } from '../src/shared/lib/query-client.js';

const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';
const SYMBOL = 'BTCUSDT';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const setUp = (responder: () => Response): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => responder()),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <SymbolOrderBookPanel profileId={PROFILE_ID} symbol={SYMBOL} />
    </QueryClientProvider>,
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SymbolOrderBookPanel', () => {
  it('renders the ask/bid ladder and the spread between best bid and ask', async () => {
    setUp(() =>
      json({
        // bids descend best-first; asks ascend best-first.
        bids: [
          { price: '78000.00', qty: '1.5' },
          { price: '77999.00', qty: '2' },
        ],
        asks: [
          { price: '78002.00', qty: '0.8' },
          { price: '78005.00', qty: '3' },
        ],
      }),
    );
    const ladder = await screen.findByTestId('order-book-ladder');
    expect(ladder).toBeInTheDocument();
    // best ask 78002 − best bid 78000 = 2.
    expect(screen.getByTestId('order-book-spread')).toHaveTextContent('Spread 2');
    // Asks render in down red, bids in up green; the price column uses
    // `formatPrice`, which renders a value at or above 1 with two fraction
    // digits — `78002` becomes `78,002.00`.
    expect(screen.getByText('78,002.00')).toHaveClass('text-down');
    expect(screen.getByText('78,000.00')).toHaveClass('text-up');
  });

  it('labels each side with text, not colour alone, and glosses the spread', async () => {
    setUp(() =>
      json({
        bids: [{ price: '78000.00', qty: '1.5' }],
        asks: [{ price: '78002.00', qty: '0.8' }],
      }),
    );
    await screen.findByTestId('order-book-ladder');
    // Side is readable without relying on red/green (WCAG 1.4.1).
    expect(screen.getByTestId('order-book-asks-label')).toHaveTextContent(/Asks/);
    expect(screen.getByTestId('order-book-bids-label')).toHaveTextContent(/Bids/);
    // "Spread" carries an inline gloss for the non-finance operator.
    expect(screen.getByTitle(/gap between the lowest sell/i)).toBeInTheDocument();
  });

  it('renders a Total column carrying the cumulative volume per side', async () => {
    setUp(() =>
      json({
        bids: [
          { price: '78000.00', qty: '1.5' },
          { price: '77999.00', qty: '2' },
        ],
        asks: [
          { price: '78002.00', qty: '0.8' },
          { price: '78005.00', qty: '3' },
        ],
      }),
    );
    await screen.findByTestId('order-book-ladder');
    expect(screen.getByText('Total')).toBeInTheDocument();
    // Cumulative runs from the best price outward. Rows render asks-reversed
    // first (3.8, 0.8) then bids (1.5, 3.5), so the Total column in DOM order
    // is a full ordered vector — pins the per-side accumulation.
    const totals = screen.getAllByTestId('depth-total').map((cell) => cell.textContent);
    expect(totals).toEqual(['3.8', '0.8', '1.5', '3.5']);
  });

  it('scales each cumulative-depth bar to the deeper side total', async () => {
    setUp(() =>
      json({
        bids: [
          { price: '78000.00', qty: '1.5' },
          { price: '77999.00', qty: '2' },
        ],
        asks: [
          { price: '78002.00', qty: '0.8' },
          { price: '78005.00', qty: '3' },
        ],
      }),
    );
    await screen.findByTestId('order-book-ladder');
    // Cumulative: asks 0.8 then 3.8; bids 1.5 then 3.5. Max = 3.8. Bars render
    // asks-reversed-first (3.8, 0.8) then bids (1.5, 3.5), so DOM order is
    // 100, 21.05, 39.47, 92.11 — a full ordered vector pins per-side scaling.
    const widths = screen.getAllByTestId('depth-bar').map((bar) => bar.style.width);
    expect(widths).toEqual(['100.00%', '21.05%', '39.47%', '92.11%']);
  });

  it('shows a no-depth notice when both sides are empty', async () => {
    setUp(() => json({ bids: [], asks: [] }));
    expect(await screen.findByText('No depth.')).toBeInTheDocument();
  });

  it('shows a loading notice while the request is in flight', () => {
    // A fetch that never settles keeps the query in its loading state.
    setUp(() => new Promise<Response>(() => undefined) as unknown as Response);
    expect(screen.getByText('Loading order book…')).toBeInTheDocument();
  });

  it('degrades to a notice when the request fails', async () => {
    setUp(() => json({ error: { code: 'UPSTREAM_FAILED' } }, 502));
    expect(await screen.findByText('Order book unavailable.')).toBeInTheDocument();
  });

  it('collapses the ladder into coarser buckets when a wider group step is picked', async () => {
    setUp(() =>
      json({
        // Eight asks and eight bids one cent apart — a tick of 0.01.
        asks: Array.from({ length: 8 }, (_, i) => ({
          price: (78000.01 + i * 0.01).toFixed(2),
          qty: '1',
        })),
        bids: Array.from({ length: 8 }, (_, i) => ({
          price: (77999.99 - i * 0.01).toFixed(2),
          qty: '1',
        })),
      }),
    );
    await screen.findByTestId('order-book-ladder');
    // Ungrouped (0.01 tick): every level is its own row — 8 asks + 8 bids.
    expect(screen.getAllByTestId('depth-total')).toHaveLength(16);

    // Group by 1: all eight asks round up to one bucket, all eight bids down
    // to one — the ladder collapses to a single row per side.
    fireEvent.change(screen.getByTestId('order-book-group'), { target: { value: '1' } });
    expect(screen.getAllByTestId('depth-total')).toHaveLength(2);
  });
});
