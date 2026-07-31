// SymbolPausePanel — trigger opens a modal; reason gate, duration select, engage-disable mutation.

import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SymbolPausePanel } from '../src/features/symbol/components/symbol-pause-panel.js';
import { createQueryClient } from '../src/shared/lib/query-client.js';

const success = vi.fn();
const error = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: (m: string) => success(m), error: (m: string) => error(m) },
}));

const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';
const SYMBOL = 'BTCUSDT';

const setUp = async (
  responder: () => Response = () => new Response(null, { status: 204 }),
): Promise<{ fetchMock: ReturnType<typeof vi.fn> }> => {
  const fetchMock = vi.fn(async () => responder());
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={createQueryClient()}>
      <SymbolPausePanel profileId={PROFILE_ID} symbol={SYMBOL} />
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByTestId('symbol-pause-open'));
  return { fetchMock };
};

afterEach(() => {
  vi.unstubAllGlobals();
  success.mockClear();
  error.mockClear();
});

describe('SymbolPausePanel', () => {
  it('disables the Pause button until a reason is entered', async () => {
    await setUp();
    expect(screen.getByTestId('pause-submit')).toBeDisabled();
    await userEvent.type(screen.getByTestId('pause-reason'), 'manual review');
    expect(screen.getByTestId('pause-submit')).not.toBeDisabled();
  });

  it('keeps the Pause button disabled for a whitespace-only reason', async () => {
    await setUp();
    await userEvent.type(screen.getByTestId('pause-reason'), '   ');
    expect(screen.getByTestId('pause-submit')).toBeDisabled();
  });

  it('POSTs the disable request with the trimmed reason and selected TTL', async () => {
    const { fetchMock } = await setUp();
    await userEvent.type(screen.getByTestId('pause-reason'), '  spread too wide  ');
    await userEvent.selectOptions(screen.getByTestId('pause-duration'), String(24 * 3600));
    await act(async () => {
      await userEvent.click(screen.getByTestId('pause-submit'));
    });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input]) => String(input).includes('/disable'));
      expect(call).toBeTruthy();
      const init = call?.[1] as RequestInit;
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({
        reason: 'spread too wide',
        ttlSeconds: 86400,
      });
    });
  });

  it('closes the modal without submitting when Cancel is clicked', async () => {
    const { fetchMock } = await setUp();
    expect(screen.getByTestId('pause-reason')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('pause-reason')).toBeNull());
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/disable'))).toBe(false);
  });

  it('fires a success toast after a successful pause', async () => {
    await setUp();
    await userEvent.type(screen.getByTestId('pause-reason'), 'manual review');
    await act(async () => {
      await userEvent.click(screen.getByTestId('pause-submit'));
    });
    await waitFor(() => expect(success).toHaveBeenCalledWith('Symbol trading paused.'));
  });

  it('fires a failure toast when the disable request is rejected', async () => {
    await setUp(
      () =>
        new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'profile' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await userEvent.type(screen.getByTestId('pause-reason'), 'manual review');
    await act(async () => {
      await userEvent.click(screen.getByTestId('pause-submit'));
    });
    await waitFor(() => expect(error).toHaveBeenCalled());
  });
});
