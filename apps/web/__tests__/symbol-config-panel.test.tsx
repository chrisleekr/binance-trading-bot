// SymbolConfigPanel — the symbol-config editor rendered on the full-width
// /symbols/$symbol/config page. Covers hydrate from the effective config,
// partial-diff save, server-validation surfacing, and reset-to-profile.

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { SymbolConfigPanel } from '@/features/symbol/components/symbol-config-panel';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
  Toaster: () => null,
}));

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const overrideConfigSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    buy: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxPurchaseAmount: { type: 'string' },
        enabled: { type: 'boolean' },
      },
    },
  },
};

const sampleProfile = {
  id: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000010',
  name: 'BTC bot',
  strategyName: 'trailing-trade',
  strategyVersion: '2.0.0',
  config: {
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: { maxPurchaseAmount: '50', enabled: true },
  },
  enabled: true,
  binanceMode: 'test' as const,
  quoteAsset: 'USDT',
  createdAt: '2026-05-10T05:00:00.000Z',
  updatedAt: '2026-05-10T05:00:00.000Z',
};

const sampleStrategies = [
  {
    name: 'trailing-trade',
    version: '2.0.0',
    displayName: 'Trailing Trade',
    description: 'Trailing grid strategy',
    configSchema: overrideConfigSchema,
    overrideConfigSchema,
    defaultConfig: { symbol: 'BTCUSDT' },
    operatorActions: [],
  },
];

const setUp = (
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
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
      <SymbolConfigPanel profileId="p1" symbol="BTCUSDT" />
    </QueryClientProvider>,
  );
  return { fetchMock };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SymbolConfigPanel', () => {
  it('hydrates the form from the effective config (profile merged with override)', async () => {
    setUp((url) => {
      if (url.endsWith('/profiles/p1/symbols/BTCUSDT')) {
        return json({
          symbol: 'BTCUSDT',
          overrideConfig: { buy: { maxPurchaseAmount: '20' } },
          source: 'manual',
        });
      }
      if (url.endsWith('/profiles/p1')) return json(sampleProfile);
      if (url.endsWith('/strategies')) return json(sampleStrategies);
      return new Response('not found', { status: 404 });
    });

    await waitFor(() => expect(screen.getByLabelText('Max Purchase Amount')).toHaveValue('20'), {
      timeout: 5000,
    });
    expect(screen.getByTestId('override-count')).toHaveTextContent('1 overridden');
    // Drawer surface: no profile-wide tab bar rides this editor any more.
    expect(screen.queryByTestId('profile-sections-nav')).not.toBeInTheDocument();
  });

  it('Save sends a PATCH carrying only the diffed override leaf', async () => {
    let patchBody: unknown;
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/profiles/p1/symbols/BTCUSDT') && method === 'GET') {
        return json({ symbol: 'BTCUSDT', overrideConfig: null, source: 'manual' });
      }
      if (url.endsWith('/profiles/p1/symbols/BTCUSDT') && method === 'PATCH') {
        if (typeof init?.body === 'string') patchBody = JSON.parse(init.body);
        return json({
          symbol: 'BTCUSDT',
          overrideConfig: { buy: { maxPurchaseAmount: '30' } },
          source: 'manual',
        });
      }
      if (url.endsWith('/profiles/p1')) return json(sampleProfile);
      if (url.endsWith('/strategies')) return json(sampleStrategies);
      throw new Error(`unexpected ${method} ${url}`);
    });

    await waitFor(() => expect(screen.getByLabelText('Max Purchase Amount')).toHaveValue('50'), {
      timeout: 5000,
    });
    const input = screen.getByLabelText('Max Purchase Amount');
    await userEvent.clear(input);
    await userEvent.type(input, '30');
    await userEvent.click(screen.getByTestId('symbol-config-save'));

    await waitFor(() => expect(patchBody).toBeDefined());
    expect(patchBody).toEqual({ overrideConfig: { buy: { maxPurchaseAmount: '30' } } });
  });

  it('shows a config-unavailable notice when no strategy descriptor matches', async () => {
    setUp((url) => {
      if (url.endsWith('/profiles/p1/symbols/BTCUSDT')) {
        return json({ symbol: 'BTCUSDT', overrideConfig: null, source: 'manual' });
      }
      if (url.endsWith('/profiles/p1')) return json(sampleProfile);
      // Registry without the profile's strategy — descriptor resolves undefined.
      if (url.endsWith('/strategies')) return json([]);
      return new Response('not found', { status: 404 });
    });

    expect(await screen.findByText(/Config form unavailable/i)).toBeInTheDocument();
  });

  it('surfaces a server validation failure in the banner on save', async () => {
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/profiles/p1/symbols/BTCUSDT') && method === 'GET') {
        return json({ symbol: 'BTCUSDT', overrideConfig: null, source: 'manual' });
      }
      if (url.endsWith('/profiles/p1/symbols/BTCUSDT') && method === 'PATCH') {
        return json({ error: { code: 'VALIDATION_FAILED', message: 'override rejected' } }, 422);
      }
      if (url.endsWith('/profiles/p1')) return json(sampleProfile);
      if (url.endsWith('/strategies')) return json(sampleStrategies);
      throw new Error(`unexpected ${method} ${url}`);
    });

    await waitFor(() => expect(screen.getByLabelText('Max Purchase Amount')).toHaveValue('50'), {
      timeout: 5000,
    });
    const input = screen.getByLabelText('Max Purchase Amount');
    await userEvent.clear(input);
    await userEvent.type(input, '30');
    await userEvent.click(screen.getByTestId('symbol-config-save'));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/override rejected/i)),
    );
  });

  it('Reset to profile config confirms then PATCHes overrideConfig null', async () => {
    let patchBody: unknown;
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/profiles/p1/symbols/BTCUSDT') && method === 'GET') {
        return json({
          symbol: 'BTCUSDT',
          overrideConfig: { buy: { maxPurchaseAmount: '20' } },
          source: 'manual',
        });
      }
      if (url.endsWith('/profiles/p1/symbols/BTCUSDT') && method === 'PATCH') {
        if (typeof init?.body === 'string') patchBody = JSON.parse(init.body);
        return json({ symbol: 'BTCUSDT', overrideConfig: null, source: 'manual' });
      }
      if (url.endsWith('/profiles/p1')) return json(sampleProfile);
      if (url.endsWith('/strategies')) return json(sampleStrategies);
      throw new Error(`unexpected ${method} ${url}`);
    });

    await waitFor(() => expect(screen.getByTestId('symbol-config-reset')).toBeEnabled(), {
      timeout: 5000,
    });
    await userEvent.click(screen.getByTestId('symbol-config-reset'));
    expect(await screen.findByRole('dialog')).toHaveTextContent(/resumes inheriting/i);
    await userEvent.click(screen.getByTestId('symbol-config-reset-confirm'));

    await waitFor(() => expect(patchBody).toBeDefined());
    expect(patchBody).toEqual({ overrideConfig: null });
  });
});
