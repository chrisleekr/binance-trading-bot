import { describe, it, expect, vi } from 'vitest';
import { createSlackProvider, SlackConfigSchema } from '../src/providers/slack.js';
import { runNotifyProviderConformance } from '@app/notify/test-harness';
import { slackProvider } from '../src/providers/slack.js';
import type { NotifyMessage } from '../src/contract.js';

runNotifyProviderConformance(slackProvider, {
  validConfig: { webhookUrl: 'https://hooks.slack.com/services/T/B/X', channel: '#ops' },
  sendFixture: {
    message: { severity: 'info', topic: 'tt-test', title: 'Test' },
    buildProvider: (transport) => {
      const fetchImpl = (async (...args: unknown[]) => {
        transport.calls.push(args);
        return new Response('ok', { status: 200 });
      }) as unknown as typeof fetch;
      return createSlackProvider({ fetchImpl });
    },
  },
});

/** Capture the JSON body posted to the Slack webhook. */
async function sendAndCapture(message: NotifyMessage): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {};
  const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
    captured = JSON.parse(init.body) as Record<string, unknown>;
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  const provider = createSlackProvider({ fetchImpl });
  await provider.send({ config: { webhookUrl: 'https://hooks.slack.com/x' }, message });
  return captured;
}

describe('slack provider', () => {
  it('config schema requires a URL', () => {
    expect(() => SlackConfigSchema.parse({ webhookUrl: 'not-a-url' })).toThrow();
    expect(SlackConfigSchema.parse({ webhookUrl: 'https://hooks.slack.com/x' })).toEqual({
      webhookUrl: 'https://hooks.slack.com/x',
    });
  });

  it('POSTs JSON body to the webhook URL', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('ok', { status: 200 }),
    ) as unknown as typeof fetch;
    const provider = createSlackProvider({ fetchImpl });
    await provider.send({
      config: { webhookUrl: 'https://hooks.slack.com/x', channel: '#ops' },
      message: { severity: 'info', topic: 'tt-test', title: 'Test' },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hooks.slack.com/x',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('renders title, context, body and bullet fields as mrkdwn', async () => {
    const body = await sendAndCapture({
      severity: 'warn',
      topic: 'edge-decay-warning',
      title: 'Edge decay — heads-up only',
      profile: 'RealNet-Momentum',
      body: 'Live results below baseline.',
      fields: [
        { label: 'Live profit factor', value: '0.92' },
        { label: 'Baseline', value: '1.45' },
      ],
    });
    const text = body['text'] as string;
    expect(text).toContain(':warning: *Edge decay — heads-up only*');
    expect(text).toContain('RealNet-Momentum');
    expect(text).toContain('Live results below baseline.');
    expect(text).toContain('• *Live profit factor:* 0.92');
    expect(text).toContain('• *Baseline:* 1.45');
  });

  it('escapes &<> in dynamic content', async () => {
    const body = await sendAndCapture({
      severity: 'error',
      topic: 'binance-emergency',
      title: 'Binance order error',
      body: 'balance < needed & <b>bold</b>',
    });
    const text = body['text'] as string;
    expect(text).toContain('balance &lt; needed &amp; &lt;b&gt;bold&lt;/b&gt;');
    expect(text).not.toContain('<b>bold</b>');
  });

  it('renders link as Slack <url|text> syntax', async () => {
    const body = await sendAndCapture({
      severity: 'info',
      topic: 'backtest-complete',
      title: 'Backtest finished',
      link: 'http://localhost:5173/?run=abc',
    });
    expect(body['text'] as string).toContain('<http://localhost:5173/?run=abc|Open →>');
  });

  it('percent-encodes > and | in the link so they cannot break the <url|text> markup', async () => {
    const body = await sendAndCapture({
      severity: 'info',
      topic: 't',
      title: 'T',
      link: 'http://x/a>b|c',
    });
    expect(body['text'] as string).toContain('<http://x/a%3Eb%7Cc|Open →>');
  });

  it('throws on non-2xx', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 500 }),
    ) as unknown as typeof fetch;
    const provider = createSlackProvider({ fetchImpl });
    await expect(
      provider.send({
        config: { webhookUrl: 'https://hooks.slack.com/x' },
        message: { severity: 'error', topic: 'x', title: 'y' },
      }),
    ).rejects.toThrow(/Slack webhook failed/);
  });
});
