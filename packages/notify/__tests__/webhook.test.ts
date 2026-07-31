import { describe, it, expect, vi } from 'vitest';
import { createWebhookProvider, WebhookConfigSchema } from '../src/providers/webhook.js';
import { runNotifyProviderConformance } from '@app/notify/test-harness';
import { webhookProvider } from '../src/providers/webhook.js';

runNotifyProviderConformance(webhookProvider, {
  validConfig: { url: 'https://example.com/hook' },
  sendFixture: {
    message: { severity: 'info', topic: 'tt-test', title: 'Test' },
    buildProvider: (transport) => {
      const fetchImpl = (async (...args: unknown[]) => {
        transport.calls.push(args);
        return new Response('ok', { status: 200 });
      }) as unknown as typeof fetch;
      return createWebhookProvider({ fetchImpl });
    },
  },
});

describe('webhook provider', () => {
  it('schema rejects non-URL input', () => {
    expect(() => WebhookConfigSchema.parse({ url: 'not-a-url' })).toThrow();
  });

  it('POSTs the structured envelope verbatim plus a ts', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body) as Record<string, unknown>;
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const provider = createWebhookProvider({ fetchImpl });
    await provider.send({
      config: { url: 'https://x.example/hook', authHeader: 'Bearer xyz' },
      message: {
        severity: 'warn',
        topic: 'orphan-order',
        title: 'Untracked order on Binance',
        profile: 'RealNet-Momentum',
        symbol: 'BTCUSDT',
        fields: [{ label: 'Order ID', value: '91823' }],
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://x.example/hook',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer xyz' }),
      }),
    );
    expect(body).toMatchObject({
      severity: 'warn',
      topic: 'orphan-order',
      title: 'Untracked order on Binance',
      profile: 'RealNet-Momentum',
      symbol: 'BTCUSDT',
      fields: [{ label: 'Order ID', value: '91823' }],
    });
    expect(typeof body['ts']).toBe('number');
  });

  it('throws on non-2xx', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('no', { status: 500 }),
    ) as unknown as typeof fetch;
    const provider = createWebhookProvider({ fetchImpl });
    await expect(
      provider.send({
        config: { url: 'https://x.example/hook' },
        message: { severity: 'info', topic: 't', title: 'p' },
      }),
    ).rejects.toThrow(/Webhook failed/);
  });
});
