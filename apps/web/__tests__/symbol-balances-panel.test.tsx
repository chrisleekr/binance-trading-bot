// SymbolBalancesPanel — base/quote rows, zero fallback, error fallback.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SymbolBalancesPanel } from '../src/features/symbol/components/symbol-balances-panel.js';
import { createQueryClient } from '../src/shared/lib/query-client.js';

const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';
const SYMBOL = 'BTCUSDT';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const exchangeInfo = {
  symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING' }],
  fetchedAt: '2026-05-17T00:00:00.000Z',
  technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy' },
};

const dashboard = (balances: { asset: string; free: string; locked: string }[]): unknown => ({
  profileId: PROFILE_ID,
  enabled: true,
  binanceMode: 'test',
  balances,
  totalProfit: '0',
  enabledNotifierCount: 0,
  symbols: [],
  cachedAt: '2026-05-17T00:00:00.000Z',
});

const setUp = (responder: (url: string) => Response): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return responder(url);
    }),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <SymbolBalancesPanel profileId={PROFILE_ID} symbol={SYMBOL} />
    </QueryClientProvider>,
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SymbolBalancesPanel', () => {
  it('renders the base and quote balances the account holds', async () => {
    setUp((url) =>
      url.includes('/exchange-info')
        ? json(exchangeInfo)
        : json(
            dashboard([
              { asset: 'BTC', free: '0.5', locked: '0.1' },
              { asset: 'USDT', free: '1200.25', locked: '0' },
            ]),
          ),
    );
    // Base (BTC) is a quantity: sub-1 values pad to min 4dp for column alignment.
    await waitFor(() => expect(screen.getByTestId('balance-free-BTC')).toHaveTextContent('0.5000'));
    expect(screen.getByTestId('balance-row-BTC')).toHaveTextContent('0.1000 locked');
    // Quote (USDT) is money: rendered at 2dp, not the base's 8dp.
    expect(screen.getByTestId('balance-free-USDT')).toHaveTextContent('1,200.25');
  });

  it('renders the quote (money) balance at 2dp, not the raw 8-digit string', async () => {
    setUp((url) =>
      url.includes('/exchange-info')
        ? json(exchangeInfo)
        : json(
            dashboard([
              { asset: 'BTC', free: '0.00750000', locked: '0' },
              { asset: 'USDT', free: '29.15892558', locked: '0' },
            ]),
          ),
    );
    // The wallet must read 29.16 here, matching the manual-trade "Avbl" — not
    // the 8-digit 29.15892558 a base-asset quantity would show.
    await waitFor(() => expect(screen.getByTestId('balance-free-USDT')).toHaveTextContent('29.16'));
    expect(screen.getByTestId('balance-free-USDT')).not.toHaveTextContent('29.15892558');
    // Base keeps its full quantity precision.
    expect(screen.getByTestId('balance-free-BTC')).toHaveTextContent('0.0075');
  });

  it('shows a zero row for a pair asset the account does not hold', async () => {
    setUp((url) =>
      url.includes('/exchange-info')
        ? json(exchangeInfo)
        : json(dashboard([{ asset: 'BTC', free: '0.5', locked: '0' }])),
    );
    await waitFor(() => expect(screen.getByTestId('balance-row-USDT')).toBeInTheDocument());
    // The quote money formatter renders zero at 2dp to align with the base row.
    expect(screen.getByTestId('balance-free-USDT')).toHaveTextContent('0.00');
  });

  it('falls back to a notice when the dashboard fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        return url.includes('/exchange-info')
          ? json(exchangeInfo)
          : json({ error: { code: 'INTERNAL', message: 'boom' } }, 500);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <SymbolBalancesPanel profileId={PROFILE_ID} symbol={SYMBOL} />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('symbol-balances-panel')).toHaveTextContent('Balances unavailable'),
    );
  });
});
