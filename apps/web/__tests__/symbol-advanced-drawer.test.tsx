// SymbolAdvancedDrawer — collapsed default, action confirmations, wipe
// cascade text, and onWiped callback.

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SymbolAdvancedDrawer } from '../src/features/symbol/components/symbol-advanced-drawer.js';
import { createQueryClient } from '../src/shared/lib/query-client.js';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
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
      <SymbolAdvancedDrawer
        profileId={PROFILE_ID}
        symbol={SYMBOL}
        showGridActions
        onWiped={onWiped}
      />
    </QueryClientProvider>,
  );
  return { fetchMock };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SymbolAdvancedDrawer', () => {
  it('defaults to collapsed; expand reveals the six actions', async () => {
    setUp(() => new Response(null, { status: 204 }));
    expect(screen.queryByTestId('advanced-actions')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('advanced-toggle'));
    expect(screen.getByTestId('advanced-actions')).toBeInTheDocument();
    expect(screen.getByTestId('action-archive-grid')).toBeInTheDocument();
    expect(screen.getByTestId('action-reset-grid')).toBeInTheDocument();
    expect(screen.getByTestId('action-reset-config')).toBeInTheDocument();
    expect(screen.getByTestId('action-set-lbp')).toBeInTheDocument();
    expect(screen.getByTestId('action-delete-lbp')).toBeInTheDocument();
    expect(screen.getByTestId('action-wipe')).toBeInTheDocument();
  });

  it('hides the four grid actions when showGridActions is false (non-grid strategy)', async () => {
    const queryClient = createQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <SymbolAdvancedDrawer profileId={PROFILE_ID} symbol={SYMBOL} showGridActions={false} />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByTestId('advanced-toggle'));
    // The strategy-agnostic actions stay.
    expect(screen.getByTestId('action-reset-config')).toBeInTheDocument();
    expect(screen.getByTestId('action-wipe')).toBeInTheDocument();
    // The trailing-trade grid actions are gone.
    expect(screen.queryByTestId('action-archive-grid')).not.toBeInTheDocument();
    expect(screen.queryByTestId('action-reset-grid')).not.toBeInTheDocument();
    expect(screen.queryByTestId('action-set-lbp')).not.toBeInTheDocument();
    expect(screen.queryByTestId('action-delete-lbp')).not.toBeInTheDocument();
  });

  it('archive grid: confirm POSTs /archive-grid-trade', async () => {
    const { fetchMock } = setUp((url) => {
      if (url.includes('/archive-grid-trade')) return new Response(null, { status: 202 });
      return new Response('not found', { status: 404 });
    });
    await userEvent.click(screen.getByTestId('advanced-toggle'));
    await userEvent.click(screen.getByTestId('action-archive-grid'));
    await waitFor(() => expect(screen.getByText(/Archive grid trade/)).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('advanced-confirm'));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Archive scheduled/)),
    );
    const archiveCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/archive-grid-trade'),
    );
    expect(archiveCall).toBeTruthy();
    expect((archiveCall?.[1] as RequestInit | undefined)?.method).toBe('POST');
  });

  it('wipe modal lists the cascade and calls onWiped on success', async () => {
    const onWiped = vi.fn();
    const { fetchMock } = setUp((url, init) => {
      if (url.endsWith(`/symbols/${SYMBOL}`) && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return new Response('not found', { status: 404 });
    }, onWiped);
    await userEvent.click(screen.getByTestId('advanced-toggle'));
    await userEvent.click(screen.getByTestId('action-wipe'));
    await waitFor(() =>
      expect(screen.getByText(/Removes BTCUSDT from the profile entirely/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/per-symbol configuration/)).toBeInTheDocument();
    expect(screen.getByText(/recorded average entry price/)).toBeInTheDocument();
    expect(screen.getByText(/override actions/)).toBeInTheDocument();
    expect(screen.getByText(/Live Binance orders are NOT cancelled/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('advanced-confirm'));
    await waitFor(() => expect(onWiped).toHaveBeenCalledTimes(1));
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith(`/symbols/${SYMBOL}`) &&
          (init as RequestInit)?.method === 'DELETE',
      ),
    ).toBe(true);
  });

  it('set-lbp confirm is disabled while the input is empty or whitespace-only', async () => {
    setUp(() => new Response(null, { status: 204 }));
    await userEvent.click(screen.getByTestId('advanced-toggle'));
    await userEvent.click(screen.getByTestId('action-set-lbp'));
    await waitFor(() => expect(screen.getByTestId('advanced-lbp-input')).toBeInTheDocument());
    expect(screen.getByTestId('advanced-confirm')).toBeDisabled();
    await userEvent.type(screen.getByTestId('advanced-lbp-input'), '   ');
    expect(screen.getByTestId('advanced-confirm')).toBeDisabled();
    await userEvent.clear(screen.getByTestId('advanced-lbp-input'));
    await userEvent.type(screen.getByTestId('advanced-lbp-input'), '12345.67');
    expect(screen.getByTestId('advanced-confirm')).not.toBeDisabled();
  });
});
