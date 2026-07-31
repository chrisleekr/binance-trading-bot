// SymbolOrderHistoryPanel — past-orders table, side colouring, loading /
// empty / error states.

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SymbolOrderHistoryPanel } from '../src/features/symbol/components/symbol-order-history-panel.js';
import { createQueryClient } from '../src/shared/lib/query-client.js';

const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';
const SYMBOL = 'BTCUSDT';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const order = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: '00000000-0000-4000-8000-000000000001',
  symbol: SYMBOL,
  side: 'BUY',
  intent: 'grid-buy',
  binanceOrderId: '1',
  clientOrderId: 'cli-1',
  status: 'FILLED',
  currentGridTradeIndex: 0,
  raw: { origQty: '0.01', price: '68000' },
  createdAt: '2026-05-18T10:00:00.000Z',
  updatedAt: '2026-05-18T10:00:00.000Z',
  closedAt: '2026-05-18T10:05:00.000Z',
  ...over,
});

const setUp = (responder: () => Response): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => responder()),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <SymbolOrderHistoryPanel profileId={PROFILE_ID} symbol={SYMBOL} />
    </QueryClientProvider>,
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SymbolOrderHistoryPanel', () => {
  it.each([
    [
      'grid-buy',
      'grid-buy',
      'tint-accent',
      'border-[color-mix(in_srgb,var(--accent)_45%,transparent)]',
    ],
    [
      'grid-sell',
      'grid-sell',
      'tint-accent',
      'border-[color-mix(in_srgb,var(--accent)_45%,transparent)]',
    ],
    ['manual', 'manual', 'border-border-strong', null],
    ['technicals-force-sell', 'technicals-force-sell', 'tint-warning', null],
    ['grid-stop-loss', 'stop-loss', 'tint-danger', null],
  ] as const)(
    'renders the Source chip for intent=%s with the expected label and variant',
    async (intent, expectedLabel, expectedClass, secondaryClass) => {
      const id = '00000000-0000-4000-8000-00000000000c';
      setUp(() => json({ items: [order({ id, intent })] }));
      const chip = await screen.findByTestId(`order-history-source-${id}`);
      expect(chip).toHaveTextContent(expectedLabel);
      expect(chip).toHaveClass(expectedClass);
      if (secondaryClass !== null) expect(chip).toHaveClass(secondaryClass);
      // Side cell carries the plain side label; the inline `· source` suffix
      // is the narrow-viewport fallback (sm:hidden) — still rendered in the
      // DOM so screen readers on narrow viewports announce the source.
      const side = screen.getByTestId(`order-history-side-${id}`);
      expect(side).toHaveTextContent(`BUY · ${expectedLabel}`);
    },
  );

  it('renders past orders with side, price, amount and status', async () => {
    setUp(() =>
      json({
        items: [
          order({ id: '00000000-0000-4000-8000-00000000000a', side: 'BUY', status: 'FILLED' }),
          order({
            id: '00000000-0000-4000-8000-00000000000b',
            side: 'SELL',
            intent: 'grid-sell',
            status: 'CANCELED',
            raw: { origQty: '0.02', price: '70000' },
          }),
        ],
      }),
    );
    const a = '00000000-0000-4000-8000-00000000000a';
    const b = '00000000-0000-4000-8000-00000000000b';
    const buyRow = await screen.findByTestId(`order-history-row-${a}`);
    expect(buyRow).toHaveTextContent('BUY');
    expect(buyRow).toHaveTextContent('68,000');
    // The side cell of a BUY reads green; its FILLED status reads green.
    expect(screen.getByTestId(`order-history-side-${a}`)).toHaveClass('text-success');
    expect(screen.getByTestId(`order-history-status-${a}`)).toHaveClass('text-success');
    const sellRow = screen.getByTestId(`order-history-row-${b}`);
    expect(sellRow).toHaveTextContent('SELL');
    // The side cell of a SELL reads red; a CANCELED (terminal-unfilled) status reads muted.
    expect(screen.getByTestId(`order-history-side-${b}`)).toHaveClass('text-danger');
    expect(screen.getByTestId(`order-history-status-${b}`)).toHaveClass('text-muted-fg');
  });

  it('shows the empty notice when the symbol has no orders', async () => {
    setUp(() => json({ items: [] }));
    expect(await screen.findByText(/No orders yet for this symbol\./)).toBeInTheDocument();
  });

  it('shows an error notice when the request fails', async () => {
    setUp(() => json({ error: { code: 'INTERNAL' } }, 500));
    expect(await screen.findByText('Order history unavailable.')).toBeInTheDocument();
  });
});
