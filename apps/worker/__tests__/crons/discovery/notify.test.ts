import { describe, expect, it, vi } from 'vitest';
import { discoveryMessage, notifyDiscovery } from '../../../src/crons/discovery/notify.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

describe('notifyDiscovery — provider-agnostic fan-out', () => {
  const fakeProviders = (sends: Record<string, ReturnType<typeof vi.fn>>) =>
    ({
      get: (name: string) => (sends[name] ? { name, send: sends[name] } : undefined),
    }) as never;

  it('sends the discovery message to every enabled notifier, forwarded verbatim', async () => {
    const slack = vi.fn(async () => undefined);
    const webhook = vi.fn(async () => undefined);
    const resolved = [
      { providerName: 'slack', config: { a: 1 } },
      { providerName: 'webhook', config: { b: 2 } },
    ] as never;
    const message = discoveryMessage('added', 'AAAUSDT', 'RealNet-Momentum');
    await notifyDiscovery(fakeProviders({ slack, webhook }), resolved, message, logger);
    expect(slack).toHaveBeenCalledTimes(1);
    expect(webhook).toHaveBeenCalledTimes(1);
    expect((slack.mock.calls[0] as unknown[])[0]).toEqual({ config: { a: 1 }, message });
    expect(message).toMatchObject({
      severity: 'info',
      topic: 'discovery',
      title: 'Discovery: symbol added',
      profile: 'RealNet-Momentum',
      symbol: 'AAAUSDT',
      body: 'Auto-discovery started trading AAAUSDT.',
    });
  });

  it('does not throw with zero notifiers', async () => {
    await expect(
      notifyDiscovery(
        fakeProviders({}),
        [] as never,
        discoveryMessage('removed', 'AAAUSDT', 'P'),
        logger,
      ),
    ).resolves.toBeUndefined();
  });

  it('skips an unknown provider and swallows a send failure (best-effort)', async () => {
    const slack = vi.fn(async () => {
      throw new Error('slack down');
    });
    const resolved = [
      { providerName: 'slack', config: {} },
      { providerName: 'missing', config: {} },
    ] as never;
    await expect(
      notifyDiscovery(
        fakeProviders({ slack }),
        resolved,
        discoveryMessage('removed', 'X', 'P'),
        logger,
      ),
    ).resolves.toBeUndefined();
    expect(slack).toHaveBeenCalledTimes(1);
  });
});
