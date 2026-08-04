// SymbolRecentTradesPanel — newest-first rows, taker-side colouring, empty
// and error fallbacks.

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SymbolRecentTradesPanel } from '../src/features/symbol/components/symbol-recent-trades-panel.js';
import { createQueryClient } from '../src/shared/lib/query-client.js';

const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';
const SYMBOL = 'BTCUSDT';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const trade = (
  id: number,
  price: string,
  qty: string,
  isBuyerMaker: boolean,
): Record<string, unknown> => ({
  id,
  price,
  qty,
  quoteQty: '0',
  time: '2026-05-18T03:00:00.000Z',
  isBuyerMaker,
});

const setUp = (responder: () => Response): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => responder()),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <SymbolRecentTradesPanel profileId={PROFILE_ID} symbol={SYMBOL} />
    </QueryClientProvider>,
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SymbolRecentTradesPanel', () => {
  it('renders trades newest-first and colours rows by taker side', async () => {
    // API returns oldest-first; the panel reverses to show the newest on top.
    setUp(() => json([trade(1, '78000.00', '0.5', false), trade(2, '78010.00', '0.25', true)]));
    const rows = await screen.findAllByTestId(/^trade-row-/);
    expect(rows).toHaveLength(2);
    // Newest (id 2) renders first.
    expect(rows[0]).toHaveAttribute('data-testid', 'trade-row-2');
    // id 2 is a buyer-maker (sell-side taker) → danger + ▼; id 1 → success + ▲.
    // The price column uses `formatPrice` — values at or above 1 render with
    // two fraction digits, so `78010` becomes `78,010.00`. A directional glyph
    // prefixes the price so side does not depend on colour alone.
    expect(within(rows[0] as HTMLElement).getByText(/▼\s*78,010\.00/)).toHaveClass('text-danger');
    expect(within(rows[1] as HTMLElement).getByText(/▲\s*78,000\.00/)).toHaveClass('text-success');
  });

  it('reserves the tape box while the request is in flight', () => {
    // A fetch that never settles keeps the query in its loading state.
    setUp(() => new Promise<Response>(() => undefined) as unknown as Response);
    const panel = screen.getByTestId('symbol-recent-trades-panel');
    // A one-line notice occupied no height; on a phone that left nothing under
    // the thumb for the whole poll. The placeholder carries the tape's box.
    expect(panel.querySelectorAll('[data-skeleton-bar]').length).toBeGreaterThan(0);
    expect(within(panel).getAllByRole('status')).toHaveLength(1);
    expect(screen.queryByText('No recent trades.')).not.toBeInTheDocument();
  });

  it('shows an empty notice when the trade list is empty', async () => {
    setUp(() => json([]));
    expect(await screen.findByText('No recent trades.')).toBeInTheDocument();
  });

  it('degrades to a notice when the request fails', async () => {
    setUp(() => json({ error: { code: 'UPSTREAM_FAILED' } }, 502));
    expect(await screen.findByText('Recent trades unavailable.')).toBeInTheDocument();
  });
});
