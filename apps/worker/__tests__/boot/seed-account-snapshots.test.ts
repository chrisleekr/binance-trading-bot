// Boot seed for the `account-info` cache: one unconditional getAccount ->
// persistAccount per active profile, with per-profile failure isolation.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';

import { runAccountSnapshotSeed } from '../../src/boot/seed-account-snapshots.js';
import type { ActiveProfile } from '../../src/profile-manager/profile-manager.js';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const profile = (profileId: string, accountId = 'a1'): ActiveProfile =>
  ({
    profileId,
    userId: 'u1',
    operatorId: 'u1',
    accountId,
    candleInterval: '1h',
    symbols: ['BTCUSDT'],
  }) as unknown as ActiveProfile;

const rest = (balances: { asset: string; free: string; locked: string }[]) =>
  ({ getAccount: vi.fn(async () => ({ balances })) }) as never;

describe('runAccountSnapshotSeed', () => {
  it('persists each active profile’s full account snapshot', async () => {
    const persistAccount = vi.fn(async () => undefined);
    const tally = await runAccountSnapshotSeed({
      logger: stubLogger,
      listActive: () => [profile('p1'), profile('p2')],
      resolveBinance: async () => rest([{ asset: 'BTC', free: '1', locked: '0' }]),
      persistAccount,
    });
    expect(tally).toEqual({ seeded: 2, skipped: 0, failed: 0 });
    // persistAccount is account-scoped now: (accountId, profileId, balances).
    expect(persistAccount).toHaveBeenCalledWith('a1', 'p1', [
      { asset: 'BTC', free: '1', locked: '0' },
    ]);
    expect(persistAccount).toHaveBeenCalledTimes(2);
  });

  it('skips a profile with no resolvable credentials without persisting', async () => {
    const persistAccount = vi.fn(async () => undefined);
    const tally = await runAccountSnapshotSeed({
      logger: stubLogger,
      listActive: () => [profile('p1')],
      resolveBinance: async () => null,
      persistAccount,
    });
    expect(tally).toEqual({ seeded: 0, skipped: 1, failed: 0 });
    expect(persistAccount).not.toHaveBeenCalled();
  });

  it('isolates a per-profile failure and still seeds the rest', async () => {
    const persistAccount = vi.fn(async () => undefined);
    const tally = await runAccountSnapshotSeed({
      logger: stubLogger,
      listActive: () => [profile('p1', 'a1'), profile('p2', 'a2')],
      // Binance resolution is per-account: the 2nd arg is the accountId.
      resolveBinance: async (_operatorId, accountId) =>
        accountId === 'a1'
          ? ({ getAccount: async () => Promise.reject(new Error('REST 418')) } as never)
          : rest([{ asset: 'ETH', free: '2', locked: '0' }]),
      persistAccount,
    });
    expect(tally).toEqual({ seeded: 1, skipped: 0, failed: 1 });
    expect(persistAccount).toHaveBeenCalledTimes(1);
    expect(persistAccount).toHaveBeenCalledWith('a2', 'p2', [
      { asset: 'ETH', free: '2', locked: '0' },
    ]);
  });

  it('counts a persistAccount failure (e.g. Redis cold at boot) as failed and seeds the rest', async () => {
    const persistAccount = vi.fn(async (_u: unknown, profileId: unknown) => {
      if (profileId === 'p1') throw new Error('Redis ECONNREFUSED');
    });
    const tally = await runAccountSnapshotSeed({
      logger: stubLogger,
      listActive: () => [profile('p1'), profile('p2')],
      resolveBinance: async () => rest([{ asset: 'BTC', free: '1', locked: '0' }]),
      persistAccount,
    });
    expect(tally).toEqual({ seeded: 1, skipped: 0, failed: 1 });
    expect(persistAccount).toHaveBeenCalledTimes(2);
  });

  it('returns an empty tally when no profiles are active', async () => {
    const persistAccount = vi.fn(async () => undefined);
    const tally = await runAccountSnapshotSeed({
      logger: stubLogger,
      listActive: () => [],
      resolveBinance: async () => rest([]),
      persistAccount,
    });
    expect(tally).toEqual({ seeded: 0, skipped: 0, failed: 0 });
    expect(persistAccount).not.toHaveBeenCalled();
  });
});
