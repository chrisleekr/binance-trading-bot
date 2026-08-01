// NotificationsPanel — route-decoupled notifier editor rendered directly in a
// drawer. Ported from notifications-route.test.tsx: same fetch-mock contract,
// but the panel renders standalone under a QueryClientProvider (no router) and
// takes profileId as a prop.

import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { Toaster } from '@/shared/components/ui/sonner';
import { NotificationsPanel } from '@/features/notifications/components/notifications-panel';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

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
      <NotificationsPanel profileId="p1" />
      <Toaster />
    </QueryClientProvider>,
  );
  return { fetchMock, ...utils };
};

const sampleProviders = [
  {
    name: 'slack',
    version: '1.0.0',
    displayName: 'Slack',
    secretFields: ['webhookUrl'],
    configSchema: {
      type: 'object',
      properties: { webhookUrl: { type: 'string' }, channel: { type: 'string' } },
    },
  },
  {
    name: 'telegram',
    version: '1.0.0',
    displayName: 'Telegram',
    secretFields: ['botToken', 'chatId'],
    configSchema: { type: 'object', properties: { botToken: { type: 'string' } } },
  },
];

describe('NotificationsPanel', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders under the notifications-panel test id', async () => {
    setUp((url) => {
      if (url.endsWith('/profiles/p1/notify-providers')) return json(sampleProviders);
      if (url.includes('/profiles/p1/notify-providers/')) {
        const name = url.split('/').pop() ?? '';
        const d = sampleProviders.find((p) => p.name === name);
        if (!d) return json({}, 404);
        return json({ ...d, enabled: null, config: null });
      }
      return json({}, 404);
    });
    await screen.findByRole('heading', { name: /^slack$/i });
    expect(screen.getByTestId('notifications-panel')).toBeInTheDocument();
  });

  it('renders one card per provider with display name + secret-field names', async () => {
    setUp((url) => {
      if (url.endsWith('/profiles/p1/notify-providers')) return json(sampleProviders);
      if (url.includes('/profiles/p1/notify-providers/')) {
        const name = url.split('/').pop() ?? '';
        const d = sampleProviders.find((p) => p.name === name);
        if (!d) return json({}, 404);
        return json({ ...d, enabled: null, config: null });
      }
      return json({}, 404);
    });
    expect(await screen.findByRole('heading', { name: /^slack$/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^telegram$/i })).toBeInTheDocument();
    // Secret-field labels render humanised (titleCase) on the password inputs.
    // The heading comes from the provider-list GET; the fields come from a
    // per-provider GET, one per provider on its own promise chain. Awaiting
    // Slack's does not flush Telegram's, so each provider is awaited in turn.
    expect((await screen.findAllByText(/Webhook URL/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/Bot Token/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/Chat ID/)).length).toBeGreaterThan(0);
  });

  it('renders schema descriptions as inline help and marks secrets required vs optional from the schema', async () => {
    const webhookProvider = {
      name: 'webhook',
      version: '1.0.0',
      displayName: 'Generic Webhook',
      secretFields: ['apiKey', 'authHeader'],
      configSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'HTTPS endpoint that receives the payload.' },
          apiKey: { type: 'string', description: 'Required API key for the endpoint.' },
          authHeader: { type: 'string', description: 'Optional Authorization header value.' },
        },
        required: ['url', 'apiKey'],
      },
    };
    setUp((url) => {
      if (url.endsWith('/profiles/p1/notify-providers')) return json([webhookProvider]);
      if (url.includes('/profiles/p1/notify-providers/'))
        return json({ ...webhookProvider, enabled: null, config: null });
      return json({}, 404);
    });
    await screen.findByRole('heading', { name: /generic webhook/i });
    // Non-secret fields render through AutoForm/FieldRenderer, whose description
    // is painted inline under the field; secret-field help renders inline from
    // the panel. All visible without interaction.
    // Field help arrives with the per-provider GET, one round trip after the heading.
    expect(
      await screen.findByText('HTTPS endpoint that receives the payload.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Required API key for the endpoint.')).toBeInTheDocument();
    expect(screen.getByText('Optional Authorization header value.')).toBeInTheDocument();
    // Required secret → asterisk, aria-required=true.
    expect(screen.getByTestId('secret-webhook-apiKey')).toHaveAttribute('aria-required', 'true');
    // Optional secret → "(optional)", aria-required=false, never an asterisk.
    expect(screen.getByText(/\(optional\)/)).toBeInTheDocument();
    expect(screen.getByTestId('secret-webhook-authHeader')).toHaveAttribute(
      'aria-required',
      'false',
    );
  });

  it('per-provider save and test-fire buttons are wired', async () => {
    setUp((url) => {
      if (url.endsWith('/profiles/p1/notify-providers')) return json(sampleProviders);
      if (url.includes('/profiles/p1/notify-providers/')) {
        const name = url.split('/').pop() ?? '';
        const d = sampleProviders.find((p) => p.name === name);
        if (!d) return json({}, 404);
        return json({ ...d, enabled: null, config: null });
      }
      return json({}, 404);
    });
    await screen.findByRole('heading', { name: /^slack$/i });
    // Buttons mount with the per-provider GET, one round trip after the heading,
    // and each provider fetches independently — so both are awaited.
    expect(await screen.findByTestId('save-slack')).not.toBeDisabled();
    expect(await screen.findByTestId('save-telegram')).not.toBeDisabled();
    // Test Fire is disabled until a config has been saved.
    expect(screen.getByTestId('test-fire-slack')).toBeDisabled();
  });

  it('shows an empty-state hint when the provider list is empty', async () => {
    setUp((url) => {
      if (url.endsWith('/profiles/p1/notify-providers')) return json([]);
      return json({}, 404);
    });
    expect(await screen.findByText(/no notifiers registered/i)).toBeInTheDocument();
  });

  it('seeds the editor from the persisted GET response when a row exists', async () => {
    const savedSlack = {
      name: 'slack',
      version: '1.0.0',
      displayName: 'Slack',
      secretFields: ['webhookUrl'],
      configSchema: { type: 'object' },
      enabled: false,
      config: { channel: '#alerts' },
    };
    setUp((url) => {
      if (url.endsWith('/profiles/p1/notify-providers')) return json(sampleProviders);
      if (url.endsWith('/profiles/p1/notify-providers/slack')) return json(savedSlack);
      if (url.includes('/profiles/p1/notify-providers/')) {
        const name = url.split('/').pop() ?? '';
        const d = sampleProviders.find((p) => p.name === name);
        if (!d) return json({}, 404);
        return json({ ...d, enabled: null, config: null });
      }
      return json({}, 404);
    });
    await screen.findByRole('heading', { name: /^slack$/i });
    // The AutoForm seeds its non-secret `channel` field from the persisted config.
    expect(await screen.findByDisplayValue('#alerts')).toBeInTheDocument();
    // Saved row exists ⇒ the Test Fire button is enabled.
    expect(screen.getByTestId('test-fire-slack')).not.toBeDisabled();
  });

  it('posts the merged config on Save and renders a success banner', async () => {
    const calls: { url: string; body: unknown }[] = [];
    setUp((url, init) => {
      if (url.endsWith('/profiles/p1/notify-providers')) return json(sampleProviders);
      if (url.endsWith('/profiles/p1/notify-providers/slack')) {
        if (init?.method === 'POST') {
          const parsed = JSON.parse(init.body as string) as unknown;
          calls.push({ url, body: parsed });
          return json({
            name: 'slack',
            version: '1.0.0',
            displayName: 'Slack',
            secretFields: ['webhookUrl'],
            configSchema: {},
            enabled: true,
          });
        }
        return json({}, 404);
      }
      if (url.includes('/profiles/p1/notify-providers/')) {
        const name = url.split('/').pop() ?? '';
        const d = sampleProviders.find((p) => p.name === name);
        if (!d) return json({}, 404);
        return json({ ...d, enabled: null, config: null });
      }
      return json({}, 404);
    });
    await screen.findByRole('heading', { name: /^slack$/i });

    // Fill a non-secret AutoForm field + a secret, then Save.
    fireEvent.change(await screen.findByLabelText(/channel/i), { target: { value: '#ops' } });
    const secretInput = await screen.findByTestId('secret-slack-webhookUrl');
    fireEvent.change(secretInput, { target: { value: 'https://hooks.example/abc' } });
    fireEvent.click(screen.getByTestId('save-slack'));

    await screen.findByText('Saved.');
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body as { config: Record<string, unknown>; enabled: boolean };
    expect(body.enabled).toBe(true);
    expect(body.config['channel']).toBe('#ops');
    expect(body.config['webhookUrl']).toBe('https://hooks.example/abc');
  });

  it('renders the test-fire outcome from a successful POST', async () => {
    const savedSlack = {
      name: 'slack',
      version: '1.0.0',
      displayName: 'Slack',
      secretFields: ['webhookUrl'],
      configSchema: {},
      enabled: true,
      config: {},
    };
    setUp((url, init) => {
      if (url.endsWith('/profiles/p1/notify-providers')) return json(sampleProviders);
      if (url.endsWith('/profiles/p1/notify-providers/slack/test-fire')) {
        if (init?.method === 'POST') return json({ ok: true, error: null });
        return json({}, 404);
      }
      if (url.endsWith('/profiles/p1/notify-providers/slack')) return json(savedSlack);
      if (url.includes('/profiles/p1/notify-providers/')) {
        const name = url.split('/').pop() ?? '';
        const d = sampleProviders.find((p) => p.name === name);
        if (!d) return json({}, 404);
        return json({ ...d, enabled: null, config: null });
      }
      return json({}, 404);
    });
    await screen.findByRole('heading', { name: /^slack$/i });
    await waitFor(() => expect(screen.getByTestId('test-fire-slack')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('test-fire-slack'));
    expect(await screen.findByText(/test message sent/i)).toBeInTheDocument();
  });

  it('renders event-subscription toggles and PATCHes the profile on toggle', async () => {
    const profile = {
      id: '11111111-1111-4111-8111-111111111111',
      accountId: '22222222-2222-4222-8222-222222222222',
      name: 'P1',
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.0',
      config: {},
      enabled: false,
      binanceMode: 'test',
      quoteAsset: 'USDT',
      notifyEvents: {
        'daily-loss-halt': true,
        'edge-decay-warning': true,
        discovery: true,
        alive: true,
      },
      createdAt: '2026-06-20T00:00:00.000Z',
      updatedAt: '2026-06-20T00:00:00.000Z',
    };
    const patches: unknown[] = [];
    setUp((url, init) => {
      if (url.endsWith('/profiles/p1')) {
        if (init?.method === 'PATCH') {
          patches.push(JSON.parse(init.body as string));
          return json({ ...profile, notifyEvents: { ...profile.notifyEvents, alive: false } });
        }
        return json(profile);
      }
      if (url.endsWith('/profiles/p1/notify-providers')) return json([]);
      return json({}, 404);
    });

    // The capital-safety toggle and the chatty digest toggle both render.
    expect(await screen.findByTestId('event-daily-loss-halt')).toBeInTheDocument();
    const aliveToggle = await screen.findByTestId('event-alive');
    fireEvent.click(aliveToggle);

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ notifyEvents: { alive: false, 'daily-loss-halt': true } });
  });

  it('renders the test-fire failure surface when the API reports ok=false', async () => {
    const savedSlack = {
      name: 'slack',
      version: '1.0.0',
      displayName: 'Slack',
      secretFields: ['webhookUrl'],
      configSchema: {},
      enabled: true,
      config: {},
    };
    setUp((url, init) => {
      if (url.endsWith('/profiles/p1/notify-providers')) return json(sampleProviders);
      if (url.endsWith('/profiles/p1/notify-providers/slack/test-fire')) {
        if (init?.method === 'POST') return json({ ok: false, error: 'send failed' });
        return json({}, 404);
      }
      if (url.endsWith('/profiles/p1/notify-providers/slack')) return json(savedSlack);
      if (url.includes('/profiles/p1/notify-providers/')) {
        const name = url.split('/').pop() ?? '';
        const d = sampleProviders.find((p) => p.name === name);
        if (!d) return json({}, 404);
        return json({ ...d, enabled: null, config: null });
      }
      return json({}, 404);
    });
    await screen.findByRole('heading', { name: /^slack$/i });
    await waitFor(() => expect(screen.getByTestId('test-fire-slack')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('test-fire-slack'));
    expect(await screen.findByText('send failed')).toBeInTheDocument();
  });
});
