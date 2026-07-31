// SymbolStatsStrip — happy path, up/down change colouring, error fallback.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SymbolStatsStrip } from '../src/features/symbol/components/symbol-stats-strip.js';
import { createQueryClient } from '../src/shared/lib/query-client.js';

const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';
const SYMBOL = 'BTCUSDT';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const ticker = (overrides: Record<string, string> = {}): Record<string, string> => ({
  symbol: 'BTCUSDT',
  lastPrice: '78171.03',
  priceChange: '-420.50',
  priceChangePercent: '-0.54',
  highPrice: '79000.00',
  lowPrice: '77500.00',
  openPrice: '78591.53',
  volume: '1234.56',
  quoteVolume: '96543210.00',
  ...overrides,
});

const setUp = (responder: () => Response): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => responder()),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <SymbolStatsStrip profileId={PROFILE_ID} symbol={SYMBOL} />
    </QueryClientProvider>,
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SymbolStatsStrip', () => {
  it('renders last price and a signed, down-coloured 24h change', async () => {
    setUp(() => json(ticker()));
    await waitFor(() =>
      expect(screen.getByTestId('symbol-last-price')).toHaveTextContent('78,171.03'),
    );
    const change = screen.getByTestId('symbol-24h-change');
    // 2dp via the shared formatPrice (was -420.5 under the old 8dp clone).
    expect(change).toHaveTextContent('-420.50 (-0.54%)');
    expect(change).toHaveClass('text-down');
  });

  it('renders the header price at 2dp via the shared formatPrice, not the old 8dp local clone (issue #410)', async () => {
    // A price with more than two fraction digits is where the mislabeled local
    // formatPrice (maximumFractionDigits: 8) diverged from the shared helper
    // (2dp for values >= 1). Assert exact text so the extra digits would fail.
    setUp(() => json(ticker({ lastPrice: '78171.034567' })));
    await waitFor(() => {
      expect(screen.getByTestId('symbol-last-price').textContent).toBe('78,171.03');
    });
  });

  it('keeps a sub-1 price at full precision so a low-priced symbol does not round to 0.00', async () => {
    // formatPrice's sub-1 branch keeps up to 8dp; the header relies on it for
    // low-priced symbols (e.g. SHIB). A flat toFixed(2) would round this away.
    setUp(() => json(ticker({ lastPrice: '0.00002345' })));
    await waitFor(() => {
      expect(screen.getByTestId('symbol-last-price').textContent).toBe('0.00002345');
    });
  });

  it('colours a positive change up and prefixes a plus sign', async () => {
    setUp(() => json(ticker({ priceChange: '420.50', priceChangePercent: '0.54' })));
    await waitFor(() => {
      const change = screen.getByTestId('symbol-24h-change');
      expect(change).toHaveTextContent('+420.50 (+0.54%)');
      expect(change).toHaveClass('text-up');
    });
  });

  it('falls back to an inline notice when the ticker fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { code: 'UPSTREAM_FAILED', message: 'boom' } }, 502)),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <SymbolStatsStrip profileId={PROFILE_ID} symbol={SYMBOL} />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('symbol-stats-strip')).toHaveTextContent('24h stats unavailable'),
    );
  });
});
