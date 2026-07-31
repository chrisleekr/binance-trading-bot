// Lock the "no silent failures" contract that used to live, inconsistently, in
// five separate fan-out loops. `dispatchNotify` owns it now: whenever nothing
// reaches the operator — no notifier, no registered provider, or every send
// failing — the undelivered hook fires and a warn is logged.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { AnyNotifyProvider, NotifyMessage, NotifyProviderRegistry } from '@app/notify';

import { dispatchNotify } from '../../src/notifiers/dispatch.js';
import type { ResolvedNotifier } from '../../src/notifiers/lookup.js';

const MESSAGE: NotifyMessage = {
  severity: 'error',
  topic: 'binance-emergency',
  title: 'Order failed',
  body: 'the exchange rejected the order',
};

const fakeLogger = (): Logger =>
  ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) as unknown as Logger;

const provider = (name: string, send: () => Promise<void>): AnyNotifyProvider =>
  ({ name, send }) as unknown as AnyNotifyProvider;

const registryOf = (...providers: AnyNotifyProvider[]): NotifyProviderRegistry =>
  ({
    get: (n: string) => providers.find((p) => p.name === n),
    list: () => providers,
  }) as unknown as NotifyProviderRegistry;

const resolved = (...names: string[]): ResolvedNotifier[] =>
  names.map((providerName) => ({ providerName, config: {} }));

describe('dispatchNotify', () => {
  it('delivers to every resolved notifier and reports the delivered count', async () => {
    const slack = provider(
      'slack',
      vi.fn(async () => undefined),
    );
    const telegram = provider(
      'telegram',
      vi.fn(async () => undefined),
    );
    const onUndelivered = vi.fn(async () => undefined);

    const delivered = await dispatchNotify(
      { registry: registryOf(slack, telegram), logger: fakeLogger() },
      resolved('slack', 'telegram'),
      MESSAGE,
      onUndelivered,
    );

    expect(delivered).toBe(2);
    expect(onUndelivered).not.toHaveBeenCalled();
  });

  it('fires the undelivered hook when no notifier is configured', async () => {
    const onUndelivered = vi.fn(async () => undefined);
    const logger = fakeLogger();

    const delivered = await dispatchNotify(
      { registry: registryOf(), logger },
      [],
      MESSAGE,
      onUndelivered,
    );

    expect(delivered).toBe(0);
    expect(onUndelivered).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('fires the undelivered hook when an enabled notifier names an unregistered provider', async () => {
    const onUndelivered = vi.fn(async () => undefined);

    const delivered = await dispatchNotify(
      { registry: registryOf(), logger: fakeLogger() },
      resolved('telegram'),
      MESSAGE,
      onUndelivered,
    );

    expect(delivered).toBe(0);
    expect(onUndelivered).toHaveBeenCalledOnce();
  });

  it('fires the undelivered hook when the only provider throws — the operator was not alerted', async () => {
    // The pre-dispatch code counted a provider as "dispatched" the moment it was
    // found in the registry, so a lone broken webhook produced no gap trace.
    const slack = provider(
      'slack',
      vi.fn(async () => {
        throw new Error('webhook down');
      }),
    );
    const onUndelivered = vi.fn(async () => undefined);

    const delivered = await dispatchNotify(
      { registry: registryOf(slack), logger: fakeLogger() },
      resolved('slack'),
      MESSAGE,
      onUndelivered,
    );

    expect(delivered).toBe(0);
    expect(onUndelivered).toHaveBeenCalledOnce();
  });

  it('does not fire the hook when one provider throws but another delivers', async () => {
    const slack = provider(
      'slack',
      vi.fn(async () => {
        throw new Error('webhook down');
      }),
    );
    const telegram = provider(
      'telegram',
      vi.fn(async () => undefined),
    );
    const onUndelivered = vi.fn(async () => undefined);

    const delivered = await dispatchNotify(
      { registry: registryOf(slack, telegram), logger: fakeLogger() },
      resolved('slack', 'telegram'),
      MESSAGE,
      onUndelivered,
    );

    expect(delivered).toBe(1);
    expect(slack.send).toHaveBeenCalledOnce();
    expect(telegram.send).toHaveBeenCalledOnce();
    expect(onUndelivered).not.toHaveBeenCalled();
  });

  it('swallows a throwing undelivered hook: the caller path must never see it', async () => {
    // emergency-notify calls this from a post-accept catch block whose contract
    // is a non-retryable RETURN. A throw there would replay the BullMQ job and
    // place a duplicate live order.
    const logger = fakeLogger();
    const onUndelivered = vi.fn(async () => {
      throw new Error('postgres down');
    });

    await expect(
      dispatchNotify({ registry: registryOf(), logger }, [], MESSAGE, onUndelivered),
    ).resolves.toBe(0);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('logs the warn but needs no hook when the caller has no durable home for the trace', async () => {
    const logger = fakeLogger();

    const delivered = await dispatchNotify({ registry: registryOf(), logger }, [], MESSAGE);

    expect(delivered).toBe(0);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
