// ProfileConfigPanel — the profile strategy config editor extracted from the
// /profiles/$profileId/config route so it can render inside the dashboard edit
// drawer. Mounts the panel directly (no router) with profileId supplied as a
// prop; fetch is mocked for the profile, strategies, PATCH, and switch-strategy
// endpoints. Ported from config-route.test.tsx.

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { ProfileConfigPanel } from '@/features/profile/components/profile-config-panel';

const PROFILE_ID = '00000000-0000-4000-8000-000000000001';

const toastWarning = vi.fn();
// `success` and `error` are stubbed alongside the asserted level because sibling
// panels this component mounts toast on their own paths.
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: (m: string) => toastWarning(m),
  },
}));

type Json = unknown;

const json = (body: Json, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// Minimal JSON Schema the API would ship for a strategy's config. The panel
// renders AutoForm from this; `sampleProfile.config` seeds the fields.
const configSchema = {
  type: 'object' as const,
  properties: {
    symbol: { type: 'string', minLength: 1 },
    buy: {
      type: 'object',
      properties: { maxPurchaseAmount: { type: 'string' } },
    },
  },
  required: ['symbol'],
};

const sampleProfile = {
  id: PROFILE_ID,
  accountId: '00000000-0000-4000-8000-000000000010',
  name: 'BTC bot',
  strategyName: 'trailing-trade',
  strategyVersion: '2.0.0',
  config: {
    symbol: 'BTCUSDT',
    buy: { maxPurchaseAmount: '10' },
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
    configSchema,
    overrideConfigSchema: configSchema,
    defaultConfig: { symbol: 'BTCUSDT', buy: { maxPurchaseAmount: '10' } },
    operatorActions: [],
  },
  {
    name: 'mean-reversion',
    version: '0.9.0',
    displayName: 'Mean Reversion (alpha)',
    description: 'demo strategy',
    configSchema,
    overrideConfigSchema: configSchema,
    defaultConfig: { symbol: 'BTCUSDT', buy: { maxPurchaseAmount: '10' } },
    operatorActions: [],
  },
];

const setUp = (
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetchMock: ReturnType<typeof vi.fn> } => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    // The panel renders <ConfigDiagnostics>, which lints the saved config on
    // mount. Short-circuit that POST with empty diagnostics so each test's
    // responder need not know about it (and the lint never throws/404s here).
    if (url.includes('/lint-config')) {
      return new Response(JSON.stringify({ diagnostics: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return responder(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <ProfileConfigPanel profileId={PROFILE_ID} />
    </QueryClientProvider>,
  );
  return { fetchMock };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ProfileConfigPanel', () => {
  it('hydrates the generated form from the profile config', async () => {
    setUp((url) => {
      if (url.endsWith(`/profiles/${PROFILE_ID}`)) return json(sampleProfile);
      if (url.endsWith('/strategies')) return json(sampleStrategies);
      return new Response('not found', { status: 404 });
    });

    await waitFor(
      () => {
        expect(screen.getByLabelText('Symbol')).toHaveValue('BTCUSDT');
      },
      { timeout: 5000 },
    );
    expect(screen.getByLabelText('Max Purchase Amount')).toHaveValue('10');
  });

  it('Save sends a PATCH with the form values', async () => {
    let patchBody: unknown;
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith(`/profiles/${PROFILE_ID}`) && method === 'GET') return json(sampleProfile);
      if (url.endsWith('/strategies')) return json(sampleStrategies);
      if (url.endsWith(`/profiles/${PROFILE_ID}`) && method === 'PATCH') {
        if (init?.body && typeof init.body === 'string') {
          patchBody = JSON.parse(init.body);
        }
        return json({
          ...sampleProfile,
          config: { symbol: 'ETHUSDT', buy: { maxPurchaseAmount: '10' } },
        });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    await waitFor(() => expect(screen.getByLabelText('Symbol')).toHaveValue('BTCUSDT'), {
      timeout: 5000,
    });
    const symbol = screen.getByLabelText('Symbol');
    await userEvent.clear(symbol);
    await userEvent.type(symbol, 'ETHUSDT');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patchBody).toBeDefined());
    expect((patchBody as { config: { symbol: string } }).config.symbol).toBe('ETHUSDT');
  });

  it('warns when the save landed but its order sizing was not verified', async () => {
    toastWarning.mockClear();
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith(`/profiles/${PROFILE_ID}`) && method === 'GET') return json(sampleProfile);
      if (url.endsWith('/strategies')) return json(sampleStrategies);
      if (url.endsWith(`/profiles/${PROFILE_ID}`) && method === 'PATCH')
        return json({
          ...sampleProfile,
          diagnostics: [
            {
              level: 'warn',
              code: 'filters-unavailable',
              message: 'BTCUSDT: trading rules have not loaded yet.',
            },
          ],
        });
      throw new Error(`unexpected ${method} ${url}`);
    });

    await waitFor(() => expect(screen.getByLabelText('Symbol')).toHaveValue('BTCUSDT'), {
      timeout: 5000,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // The save still succeeded, so the ok banner stands; the toast is what tells
    // the operator the check behind it did not actually run.
    await waitFor(() =>
      expect(toastWarning).toHaveBeenCalledWith('BTCUSDT: trading rules have not loaded yet.'),
    );
  });

  it('shows an inline validation error for an invalid field', async () => {
    setUp((url) => {
      if (url.endsWith(`/profiles/${PROFILE_ID}`)) return json(sampleProfile);
      if (url.endsWith('/strategies')) return json(sampleStrategies);
      return new Response('not found', { status: 404 });
    });

    await waitFor(() => expect(screen.getByLabelText('Symbol')).toHaveValue('BTCUSDT'), {
      timeout: 5000,
    });
    // `symbol` is required with minLength 1; clearing it must surface an error.
    await userEvent.clear(screen.getByLabelText('Symbol'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // An invalid submit raises two alerts: the inline field error and the
    // form-level "needs attention" banner. Assert the inline field error
    // specifically (the one that is not the banner) is present.
    const alerts = await screen.findAllByRole('alert');
    const fieldError = alerts.find((el) => !/need attention/i.test(el.textContent ?? ''));
    expect(fieldError).toBeDefined();
  });

  it('Strategy dropdown change opens modal; Confirm POSTs switch-strategy', async () => {
    let switchBody: unknown;
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith(`/profiles/${PROFILE_ID}`) && method === 'GET') return json(sampleProfile);
      if (url.endsWith('/strategies')) return json(sampleStrategies);
      if (url.endsWith(`/profiles/${PROFILE_ID}/switch-strategy`) && method === 'POST') {
        if (init?.body && typeof init.body === 'string') {
          switchBody = JSON.parse(init.body);
        }
        return json({
          ...sampleProfile,
          strategyName: 'mean-reversion',
          strategyVersion: '0.9.0',
          enabled: false,
        });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    await waitFor(() => expect(screen.getByLabelText('Strategy')).toBeInTheDocument(), {
      timeout: 5000,
    });
    await userEvent.selectOptions(screen.getByLabelText('Strategy'), 'mean-reversion@0.9.0');
    expect(await screen.findByRole('dialog')).toHaveTextContent(/State will reset/i);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(switchBody).toBeDefined());
    expect((switchBody as { strategyName: string }).strategyName).toBe('mean-reversion');
    expect((switchBody as { strategyVersion: string }).strategyVersion).toBe('0.9.0');
  });

  it('previews a percent entry as a quote figure computed from the dashboard equity', async () => {
    // Exercises the panel's equity calc (quote-asset filter + free/locked sum +
    // deployedQuote), which the widget-only tests bypass by injecting a
    // FormEquity directly. A config schema carrying the amount-or-percent widget
    // + a dashboard payload prove the exact arithmetic the operator sees.
    const sizingSchema = {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', minLength: 1 },
        entrySizing: {
          type: 'object',
          description: '@ui:amount-or-percent How much to spend on each buy.',
          properties: {
            mode: { type: 'string', enum: ['fixed', 'percentOfAccount'], default: 'fixed' },
            amount: { type: 'string', default: '' },
            percent: { type: 'string', default: '' },
          },
        },
      },
      required: ['symbol'],
    };
    const profileWithSizing = {
      ...sampleProfile,
      config: {
        symbol: 'BTCUSDT',
        entrySizing: { mode: 'percentOfAccount', amount: '', percent: '0.5' },
      },
    };
    const strategiesWithSizing = [
      { ...sampleStrategies[0], configSchema: sizingSchema, overrideConfigSchema: sizingSchema },
    ];
    setUp((url) => {
      if (url.endsWith(`/profiles/${PROFILE_ID}/dashboard`))
        return json({
          profileId: PROFILE_ID,
          enabled: true,
          binanceMode: 'test',
          quoteAsset: 'USDT',
          balances: [
            { asset: 'USDT', free: '500', locked: '100' }, // 600 quote cash
            { asset: 'BTC', free: '0.01', locked: '0' }, // excluded — wrong asset
          ],
          totalProfit: '0',
          deployedQuote: '200', // equity = 600 + 200 = 800
          enabledNotifierCount: 0,
          symbols: [],
          cachedAt: '2026-06-16T00:00:00.000Z',
        });
      if (url.endsWith(`/profiles/${PROFILE_ID}`)) return json(profileWithSizing);
      if (url.endsWith('/strategies')) return json(strategiesWithSizing);
      return new Response('not found', { status: 404 });
    });

    // 0.5 × 800 equity = 400; the BTC balance must not inflate it.
    await waitFor(
      () =>
        expect(screen.getByTestId('amount-or-percent-entrySizing-preview')).toHaveTextContent(
          '≈ 400 USDT',
        ),
      { timeout: 5000 },
    );
    expect(screen.getByText(/800 USDT now/)).toBeInTheDocument();
  });

  it('Cancel on the strategy switch modal does not POST', async () => {
    const { fetchMock } = setUp((url) => {
      if (url.endsWith(`/profiles/${PROFILE_ID}`)) return json(sampleProfile);
      if (url.endsWith('/strategies')) return json(sampleStrategies);
      return new Response('not found', { status: 404 });
    });

    await waitFor(() => expect(screen.getByLabelText('Strategy')).toBeInTheDocument(), {
      timeout: 5000,
    });
    await userEvent.selectOptions(screen.getByLabelText('Strategy'), 'mean-reversion@0.9.0');
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Cancel must not switch strategy. Assert specifically that no switch-strategy
    // POST fired (the panel's config-lint POST is unrelated and allowed).
    const switched = fetchMock.mock.calls.some(
      ([reqUrl, init]) =>
        String(reqUrl).endsWith(`/profiles/${PROFILE_ID}/switch-strategy`) &&
        (init as RequestInit)?.method === 'POST',
    );
    expect(switched).toBe(false);
  });
});
