// SymbolStopTrackingPanel — the destructive "stop tracking" control: opens a
// confirm dialog carrying the "does not sell / does not cancel" copy, and on
// confirm DELETEs the symbol and calls onWiped.

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SymbolStopTrackingPanel } from '../src/features/symbol/components/symbol-stop-tracking-panel.js';
import { createQueryClient } from '../src/shared/lib/query-client.js';

vi.mock('sonner', () => ({
  toast: { success: () => undefined, error: () => undefined },
  Toaster: () => null,
}));

const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';
const SYMBOL = 'BTCUSDT';

const setUp = (
  responder: (url: string, init?: RequestInit) => Response,
  onWiped?: () => void,
): { fetchMock: ReturnType<typeof vi.fn> } => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <SymbolStopTrackingPanel profileId={PROFILE_ID} symbol={SYMBOL} onWiped={onWiped} />
    </QueryClientProvider>,
  );
  return { fetchMock };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SymbolStopTrackingPanel', () => {
  it('opens a confirm dialog stating it does not sell the balance or cancel live orders', async () => {
    setUp(() => new Response(null, { status: 204 }));
    // Dialog is closed until the button is clicked.
    expect(screen.queryByTestId('symbol-stop-tracking-confirm')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('symbol-stop-tracking-open'));

    await waitFor(() => expect(screen.getByText(/Stop tracking BTCUSDT\?/)).toBeInTheDocument());
    expect(screen.getByText(/does not sell your BTCUSDT balance/)).toBeInTheDocument();
    expect(screen.getByText(/does not cancel any live Binance orders/)).toBeInTheDocument();
  });

  it('confirm DELETEs the symbol and calls onWiped', async () => {
    const onWiped = vi.fn();
    const { fetchMock } = setUp((url, init) => {
      if (url.endsWith(`/symbols/${SYMBOL}`) && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return new Response('not found', { status: 404 });
    }, onWiped);

    await userEvent.click(screen.getByTestId('symbol-stop-tracking-open'));
    await waitFor(() =>
      expect(screen.getByTestId('symbol-stop-tracking-confirm')).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByTestId('symbol-stop-tracking-confirm'));

    await waitFor(() => expect(onWiped).toHaveBeenCalledTimes(1));
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith(`/symbols/${SYMBOL}`) &&
          (init as RequestInit)?.method === 'DELETE',
      ),
    ).toBe(true);
  });
});
