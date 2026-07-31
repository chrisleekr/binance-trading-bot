// BulkOrderDrawer — places the same manual order on every symbol a profile
// trades. Quote options are derived from the profile dashboard's symbols.
// "Review order" stages the order; only the review step's "Place orders" button
// POSTs /profiles/:id/manual-order-all, and the response drives the "Placed N
// order(s) at <time>" report. fetch is mocked for both endpoints.

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { BulkOrderDrawer } from '@/features/profile/components/bulk-order-drawer';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
  Toaster: () => null,
}));

const PROFILE_ID = '00000000-0000-4000-8000-000000000001';

type Json = unknown;

const json = (body: Json, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const dashboardBody = {
  profileId: PROFILE_ID,
  enabled: true,
  binanceMode: 'test' as const,
  balances: [{ asset: 'USDT', free: '1000', locked: '0' }],
  totalProfit: '0',
  enabledNotifierCount: 1,
  symbols: [
    {
      symbol: 'BTCUSDT',
      enabled: true,
      avgEntryPrice: '70000',
      currentPrice: '71000',
      quantity: '0.1',
      openOrderCount: 0,
      openOrders: [],
    },
    {
      symbol: 'ETHUSDT',
      enabled: true,
      avgEntryPrice: null,
      currentPrice: null,
      quantity: null,
      openOrderCount: 0,
      openOrders: [],
    },
  ],
  cachedAt: '2026-05-10T05:00:00.000Z',
};

interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
}

const setUp = () => {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, body });
    if (url.endsWith(`/profiles/${PROFILE_ID}/dashboard`) && method === 'GET')
      return json(dashboardBody);
    if (url.endsWith(`/profiles/${PROFILE_ID}/manual-order-all`) && method === 'POST')
      return json({
        scheduled: 2,
        firstFireAt: '2026-05-10T05:00:01.000Z',
        lastFireAt: '2026-05-10T05:00:11.000Z',
      });
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);

  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <BulkOrderDrawer profileId={PROFILE_ID} />
    </QueryClientProvider>,
  );
  return { calls };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const hasOrderPost = (calls: FetchCall[]): boolean =>
  calls.some((c) => c.url.endsWith(`/profiles/${PROFILE_ID}/manual-order-all`));

describe('BulkOrderDrawer', () => {
  it('stages the order for review and only POSTs after explicit confirm', async () => {
    const user = userEvent.setup();
    const { calls } = setUp();

    // The quote select hydrates from the dashboard symbols (USDT).
    await waitFor(() => expect(screen.getByLabelText('Quote')).toHaveValue('USDT'));

    await user.type(screen.getByLabelText('Amount'), '50');
    await user.click(screen.getByRole('button', { name: /review order/i }));

    // Review step is shown and restates the order — but nothing has fired yet.
    expect(screen.getByTestId('bulk-order-review-summary')).toHaveTextContent(
      /Buy 50 USDT worth on every USDT symbol/i,
    );
    expect(hasOrderPost(calls)).toBe(false);

    await user.click(screen.getByTestId('bulk-order-confirm'));

    await waitFor(() => {
      // Count and a placed-at time both render in the success toast.
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Placed 2 order\(s\) at /i));
    });

    const post = calls.find((c) => c.url.endsWith(`/profiles/${PROFILE_ID}/manual-order-all`));
    expect(post).toBeDefined();
    expect(post?.method).toBe('POST');
    expect(post?.body).toMatchObject({ quote: 'USDT', side: 'buy', quoteAmount: '50' });
  });

  it('Back from the review step returns to the form without POSTing', async () => {
    const user = userEvent.setup();
    const { calls } = setUp();

    await waitFor(() => expect(screen.getByLabelText('Quote')).toHaveValue('USDT'));
    await user.type(screen.getByLabelText('Amount'), '50');
    await user.click(screen.getByRole('button', { name: /review order/i }));

    await user.click(screen.getByTestId('bulk-order-back'));

    expect(screen.getByTestId('bulk-order-drawer')).toBeInTheDocument();
    expect(hasOrderPost(calls)).toBe(false);
  });

  it('does not stage a review with an empty amount', async () => {
    const user = userEvent.setup();
    const { calls } = setUp();

    await waitFor(() => expect(screen.getByLabelText('Quote')).toHaveValue('USDT'));
    // The review button is disabled until an amount is entered.
    expect(screen.getByRole('button', { name: /review order/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /review order/i }));
    expect(screen.queryByTestId('bulk-order-review')).toBeNull();
    expect(hasOrderPost(calls)).toBe(false);
  });
});
