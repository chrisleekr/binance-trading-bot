import { describe, it, expect, vi } from 'vitest';
import { createTelegramProvider, TelegramConfigSchema } from '../src/providers/telegram.js';
import { runNotifyProviderConformance } from '@app/notify/test-harness';
import { telegramProvider } from '../src/providers/telegram.js';
import type { NotifyMessage } from '../src/contract.js';

runNotifyProviderConformance(telegramProvider, {
  validConfig: { botToken: 'bot-token', chatId: -100123 },
  sendFixture: {
    message: { severity: 'info', topic: 'tt-test', title: 'Test' },
    buildProvider: (transport) => {
      const fetchImpl = (async (...args: unknown[]) => {
        transport.calls.push(args);
        return new Response('{"ok":true}', { status: 200 });
      }) as unknown as typeof fetch;
      return createTelegramProvider({ fetchImpl });
    },
  },
});

/** Capture the JSON body of the single sendMessage call. */
async function sendAndCapture(message: NotifyMessage): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {};
  const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
    captured = JSON.parse(init.body) as Record<string, unknown>;
    return new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof fetch;
  const provider = createTelegramProvider({ fetchImpl, apiBase: 'https://t.invalid' });
  await provider.send({ config: { botToken: 'TOKEN', chatId: '@ops' }, message });
  return captured;
}

describe('telegram provider', () => {
  it('schema accepts numeric chatId', () => {
    expect(TelegramConfigSchema.parse({ botToken: 'abc', chatId: -100123 })).toEqual({
      botToken: 'abc',
      chatId: -100123,
    });
  });

  it('POSTs to bot<token>/sendMessage with HTML parse_mode', async () => {
    const body = await sendAndCapture({ severity: 'warn', topic: 'x', title: 'Hi' });
    expect(body['parse_mode']).toBe('HTML');
  });

  it('renders title, context, body and fields as HTML lines', async () => {
    const body = await sendAndCapture({
      severity: 'warn',
      topic: 'binance-weight-throttle',
      title: 'Binance rate limit — throttling',
      profile: 'RealNet-Momentum',
      symbol: 'BTCUSDT',
      body: 'Slowing orders to avoid a ban.',
      fields: [{ label: 'Usage', value: '1,180 of 1,200 (98%)' }],
    });
    const text = body['text'] as string;
    expect(text).toContain('⚠️ <b>Binance rate limit — throttling</b>');
    expect(text).toContain('RealNet-Momentum · BTCUSDT');
    expect(text).toContain('Slowing orders to avoid a ban.');
    expect(text).toContain('• <b>Usage:</b> 1,180 of 1,200 (98%)');
  });

  it('escapes &<> in dynamic content so error text cannot break parsing', async () => {
    // A legacy-Markdown killer: underscores, asterisks and backticks. Under HTML
    // these are literal; only &<> need escaping, which we assert here.
    const body = await sendAndCapture({
      severity: 'error',
      topic: 'binance-emergency',
      title: 'Binance order error',
      body: 'insufficient balance for a<b>c & _under_ *star* `tick`',
      fields: [{ label: 'Error', value: '-2010 <code> & more' }],
    });
    const text = body['text'] as string;
    expect(text).toContain('a&lt;b&gt;c &amp; _under_ *star* `tick`');
    expect(text).toContain('-2010 &lt;code&gt; &amp; more');
    expect(text).not.toContain('<code>');
  });

  it('renders link as an HTML anchor when present', async () => {
    const body = await sendAndCapture({
      severity: 'info',
      topic: 'orphan-order',
      title: 'Untracked order on Binance',
      link: 'http://localhost:5173/account/orphan-orders',
    });
    expect(body['text'] as string).toContain(
      '<a href="http://localhost:5173/account/orphan-orders">Open →</a>',
    );
  });

  it('escapes a double-quote in the href so it cannot break out of the attribute', async () => {
    const body = await sendAndCapture({
      severity: 'info',
      topic: 't',
      title: 'T',
      link: 'http://x/a"onmouseover=1',
    });
    const text = body['text'] as string;
    expect(text).toContain('href="http://x/a&quot;onmouseover=1"');
    expect(text).not.toContain('a"onmouseover');
  });

  it('throws on non-2xx', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('bad', { status: 401 }),
    ) as unknown as typeof fetch;
    const provider = createTelegramProvider({ fetchImpl });
    await expect(
      provider.send({
        config: { botToken: 't', chatId: '1' },
        message: { severity: 'info', topic: 'x', title: 'y' },
      }),
    ).rejects.toThrow(/Telegram sendMessage failed/);
  });
});
