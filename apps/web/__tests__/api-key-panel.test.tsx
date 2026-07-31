// ApiKeyPanel — the route-decoupled Binance API-key editor rendered directly
// (no router) with a mocked fetch. The API key is account-scoped now, so the
// panel takes no props and reads the active account from the module store.

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { ApiKeyPanel } from '@/features/profile/components/api-key-panel';
import { setActiveAccountId } from '@/shared/lib/account-scope';

// ActionBanner routes feedback through Sonner; capture the toast calls.
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
  Toaster: () => null,
}));

const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

type Json = unknown;

const json = (body: Json, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const sampleKey = {
  label: 'read-trade',
  last4: 'cD12',
  createdAt: '2026-05-10T03:00:00.000Z',
  verificationStatus: 'ok',
  verifiedAt: '2026-05-10T03:01:00.000Z',
  verificationError: null,
};

const setUp = (responder: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ApiKeyPanel />
    </QueryClientProvider>,
  );
  return { fetchMock, ...utils };
};

beforeEach(() => {
  // The panel's query is enabled only once an account is active; the account
  // scope route sets it in the running app.
  setActiveAccountId(ACCOUNT_ID);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ApiKeyPanel', () => {
  it('renders the bound key with masked secret and verification outcome', async () => {
    setUp((url) => {
      if (url.endsWith('/api-key')) return json(sampleKey);
      throw new Error(`unexpected ${url}`);
    });

    expect(await screen.findByText('read-trade', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/cD12$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument();
    expect(screen.getByTestId('api-key-verification')).toHaveTextContent('Verified');
  });

  it('surfaces a failed key verification with its reason', async () => {
    setUp((url) => {
      if (url.endsWith('/api-key'))
        return json({
          ...sampleKey,
          verificationStatus: 'failed',
          verifiedAt: '2026-05-10T03:01:00.000Z',
          verificationError: 'Invalid API-key, IP, or permissions for action',
        });
      throw new Error(`unexpected ${url}`);
    });

    await screen.findByText('read-trade', {}, { timeout: 5000 });
    expect(screen.getByTestId('api-key-verification')).toHaveTextContent(/Failed: Invalid API-key/);
  });

  it('shows the empty-state CTA when no key is bound (404)', async () => {
    setUp((url) => {
      if (url.endsWith('/api-key'))
        return json({ error: { code: 'NOT_FOUND', message: 'api-key' } }, 404);
      throw new Error(`unexpected ${url}`);
    });

    await waitFor(() => expect(screen.getByText(/No key bound/i)).toBeInTheDocument(), {
      timeout: 5000,
    });
    expect(screen.getByRole('button', { name: 'Add API key' })).toBeInTheDocument();
  });

  it('shows the secure-the-key guidance (permissions + IP allowlist) when the form opens', async () => {
    setUp((url) => {
      if (url.endsWith('/api-key')) return json(sampleKey);
      throw new Error(`unexpected ${url}`);
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Replace' }));
    expect(screen.getByTestId('api-key-guidance')).toBeInTheDocument();
    expect(screen.getByText(/Enable Withdrawals.*OFF/i)).toBeInTheDocument();
    expect(screen.getByText(/IP allowlist|server.s IP/i)).toBeInTheDocument();
  });

  it('Replace toggles the form, posts on submit, and refetches', async () => {
    let getCount = 0;
    const { fetchMock } = setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api-key') && method === 'GET') {
        getCount++;
        return json(getCount === 1 ? sampleKey : { ...sampleKey, last4: 'wxyz' });
      }
      if (url.endsWith('/api-key') && method === 'PUT') {
        return json({ ...sampleKey, last4: 'wxyz' });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Replace' }));
    await userEvent.type(screen.getByLabelText('API key'), 'NEW_KEY_VALUE');
    await userEvent.type(screen.getByLabelText('API secret'), 'NEW_SECRET_xyz_wxyz');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText(/wxyz$/)).toBeInTheDocument(), { timeout: 5000 });
    const putCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit)?.method === 'PUT',
    );
    if (!putCall) throw new Error('expected a PUT call');
    const putBody = JSON.parse((putCall[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(putBody).toMatchObject({ key: 'NEW_KEY_VALUE', secret: 'NEW_SECRET_xyz_wxyz' });
  });

  it('renders an error banner on PUT failure', async () => {
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api-key') && method === 'GET') return json(sampleKey);
      if (url.endsWith('/api-key') && method === 'PUT')
        return json({ error: { code: 'VALIDATION_FAILED', message: 'secret too short' } }, 422);
      throw new Error(`unexpected ${method} ${url}`);
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Replace' }));
    await userEvent.type(screen.getByLabelText('API key'), 'k');
    await userEvent.type(screen.getByLabelText('API secret'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(
      () => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/secret too short/i)),
      { timeout: 5000 },
    );
  });
});
