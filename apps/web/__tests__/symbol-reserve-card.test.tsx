import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';

import { SymbolReserveCard } from '@/features/symbol/components/symbol-reserve-card';
import { createQueryClient } from '@/shared/lib/query-client';

// ActionBanner reports success/failure through a Sonner toast (no inline DOM), so
// assert the toast rather than rendered text.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';
const SYMBOL = 'ADAUSDT';

const jsonOf = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const renderCard = (reserve: string | null, fetchImpl: typeof fetch): void => {
  vi.stubGlobal('fetch', fetchImpl);
  render(
    <QueryClientProvider client={createQueryClient()}>
      <SymbolReserveCard profileId={PROFILE_ID} symbol={SYMBOL} reserve={reserve} />
    </QueryClientProvider>,
  );
};

describe('SymbolReserveCard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it('PUTs the typed reserve to the reserve endpoint and confirms it', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonOf({ symbol: SYMBOL, overrideConfig: null, source: 'manual', reserveBaseQuantity: '50' }),
    );
    renderCard(null, fetchSpy as unknown as typeof fetch);

    fireEvent.change(screen.getByTestId('symbol-reserve-input'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('symbol-reserve-save'));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain(`/profiles/${PROFILE_ID}/symbols/${SYMBOL}/reserve`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ reserveBaseQuantity: '50' });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Always holding 50')),
    );
  });

  it('clears the reserve when the box is emptied and saved', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonOf({ symbol: SYMBOL, overrideConfig: null, source: 'manual', reserveBaseQuantity: null }),
    );
    renderCard('50', fetchSpy as unknown as typeof fetch);

    fireEvent.change(screen.getByTestId('symbol-reserve-input'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('symbol-reserve-save'));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ reserveBaseQuantity: null });
  });

  it('keeps Save disabled until the value changes', () => {
    renderCard('50', vi.fn(async () => jsonOf({})) as unknown as typeof fetch);
    expect(screen.getByTestId('symbol-reserve-save')).toBeDisabled();
  });
});
