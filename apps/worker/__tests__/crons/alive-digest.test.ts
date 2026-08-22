// Contract for createAliveDigest — the alive cron's per-profile digest.
// Fetches Binance balances and fans them out to the profile's notifiers;
// no-ops cleanly when there are no notifiers or no credentials.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { AnyNotifyProvider, NotifyProviderRegistry } from '@app/notify';

import { createAliveDigest } from '../../src/crons/alive-digest.js';
import type { NotifierRowInput } from '../../src/notifiers/lookup.js';
import type { ActiveProfile } from '../../src/profile-manager/profile-manager.js';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const profile: ActiveProfile = {
  profileId: 'p1',
  userId: 'u1',
  candleInterval: '1h',
  symbols: ['BTCUSDT'],
} as unknown as ActiveProfile;

const notifierRow = (overrides?: Partial<NotifierRowInput>): NotifierRowInput => ({
  provider: 'slack',
  config: { channel: '#trades' },
  secrets: { webhookUrl: 'https://hooks.example/abc' },
  enabled: true,
  ...overrides,
});

const restWith = (balances: readonly { asset: string; free: string; locked: string }[]) =>
  ({ getAccount: async () => ({ balances }) }) as never;

describe('createAliveDigest', () => {
  it('skips the digest when the profile has no notifiers configured', async () => {
    const resolveBinance = vi.fn(async () => restWith([]));
    await createAliveDigest({
      logger: stubLogger,
      resolveBinance,
      listNotifiers: async () => [],
      isEventEnabled: async () => true,
      resolveProfileName: async () => null,
      notifyRegistry: { get: () => undefined } as unknown as NotifyProviderRegistry,
    })(profile);
    // No notifiers → no point spending a Binance call.
    expect(resolveBinance).not.toHaveBeenCalled();
  });

  it('skips the digest when the alive event is muted', async () => {
    const resolveBinance = vi.fn(async () => restWith([]));
    await createAliveDigest({
      logger: stubLogger,
      resolveBinance,
      listNotifiers: async () => [notifierRow()],
      isEventEnabled: async () => false,
      resolveProfileName: async () => null,
      notifyRegistry: { get: () => undefined } as unknown as NotifyProviderRegistry,
    })(profile);
    // Muted → no notifier resolution and no Binance call.
    expect(resolveBinance).not.toHaveBeenCalled();
  });

  it('skips disabled notifier rows', async () => {
    const resolveBinance = vi.fn(async () => restWith([]));
    await createAliveDigest({
      logger: stubLogger,
      resolveBinance,
      listNotifiers: async () => [notifierRow({ enabled: false })],
      isEventEnabled: async () => true,
      resolveProfileName: async () => null,
      notifyRegistry: { get: () => undefined } as unknown as NotifyProviderRegistry,
    })(profile);
    expect(resolveBinance).not.toHaveBeenCalled();
  });

  it('skips the digest when the profile has no resolvable credentials', async () => {
    const send = vi.fn(async () => undefined);
    await createAliveDigest({
      logger: stubLogger,
      resolveBinance: async () => null,
      listNotifiers: async () => [notifierRow()],
      isEventEnabled: async () => true,
      resolveProfileName: async () => null,
      notifyRegistry: {
        get: () => ({ name: 'slack', send }),
      } as unknown as NotifyProviderRegistry,
    })(profile);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends a digest of non-zero balances to each configured notifier', async () => {
    const send = vi.fn<AnyNotifyProvider['send']>(async () => undefined);
    await createAliveDigest({
      logger: stubLogger,
      resolveBinance: async () =>
        restWith([
          { asset: 'BTC', free: '0.5', locked: '0' },
          { asset: 'USDT', free: '0', locked: '0' },
          { asset: 'ETH', free: '0', locked: '2' },
        ]),
      listNotifiers: async () => [notifierRow()],
      isEventEnabled: async () => true,
      resolveProfileName: async () => 'RealNet-Momentum',
      notifyRegistry: {
        get: (name: string) => (name === 'slack' ? { name: 'slack', send } : undefined),
      } as unknown as NotifyProviderRegistry,
    })(profile);

    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0]?.[0];
    if (!arg) throw new Error('expected one notification');
    expect(arg.message.topic).toBe('alive');
    expect(arg.message.title).toBe('Periodic summary');
    expect(arg.message.profile).toBe('RealNet-Momentum');
    // The zero-balance USDT row is dropped; BTC (free) and ETH (locked, total 2) stay.
    const holdings = arg.message.fields?.find((f) => f.label === 'Holdings')?.value;
    expect(holdings).toBe('0.5 BTC, 2 ETH');
    // config + secrets merged for the provider.
    expect(arg.config).toMatchObject({
      channel: '#trades',
      webhookUrl: 'https://hooks.example/abc',
    });
  });

  it('caps the holdings list with "+N more" and omits the profile when the name is unresolved', async () => {
    const send = vi.fn<AnyNotifyProvider['send']>(async () => undefined);
    // Eight held assets: HOLDINGS_CAP is 6, so two collapse into "+2 more".
    const balances = Array.from({ length: 8 }, (_, i) => ({
      asset: `A${i}`,
      free: '1',
      locked: '0',
    }));
    await createAliveDigest({
      logger: stubLogger,
      resolveBinance: async () => restWith(balances),
      listNotifiers: async () => [notifierRow()],
      isEventEnabled: async () => true,
      resolveProfileName: async () => null,
      notifyRegistry: {
        get: (name: string) => (name === 'slack' ? { name: 'slack', send } : undefined),
      } as unknown as NotifyProviderRegistry,
    })(profile);

    const message = send.mock.calls[0]?.[0];
    if (!message) throw new Error('expected one notification');
    expect(message.message.profile).toBeUndefined();
    expect(message.message.fields?.find((f) => f.label === 'Holdings')?.value).toContain('+2 more');
  });
});
