// Contract tests for the entity-fan-out cron handlers that enumerate
// active profiles inline: alive, daily-ath, account-snapshot-safety,
// dust-snapshot. (technicals-compute has its own file.)
//
// The shared invariant: a per-entity failure is caught and logged, never
// aborts the rest of the batch — the cron re-fires on its next tick.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';

import type { BinanceRestClient } from '@app/binance';

import { accountSnapshotSafetyHandler } from '../../src/crons/account-snapshot-safety.cron.js';
import { aliveHandler } from '../../src/crons/alive.cron.js';
import { dailyAthHandler } from '../../src/crons/daily-ath.cron.js';
import { dustSnapshotHandler, mapDustSnapshot } from '../../src/crons/dust-snapshot.cron.js';
import type { ActiveProfile } from '../../src/profile-manager/profile-manager.js';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const job = { id: 'job-1', data: {} } as unknown as Job;

const profile = (profileId: string, symbols: readonly string[], accountId = 'a1'): ActiveProfile =>
  ({
    profileId,
    userId: 'u1',
    operatorId: 'u1',
    accountId,
    candleInterval: '1h',
    symbols,
  }) as unknown as ActiveProfile;

describe('aliveHandler', () => {
  it('sends a digest for every active profile', async () => {
    const sendDigest = vi.fn(async () => undefined);
    await aliveHandler({
      logger: stubLogger,
      listActive: () => [profile('p1', ['BTCUSDT']), profile('p2', ['ETHUSDT'])],
      sendDigest,
    })(job);
    expect(sendDigest).toHaveBeenCalledTimes(2);
  });

  it('isolates a per-profile digest failure and continues the batch', async () => {
    const sendDigest = vi.fn(async (p: ActiveProfile) => {
      if (p.profileId === 'p1') throw new Error('binance down');
    });
    await expect(
      aliveHandler({
        logger: stubLogger,
        listActive: () => [profile('p1', ['BTCUSDT']), profile('p2', ['ETHUSDT'])],
        sendDigest,
      })(job),
    ).resolves.toBeUndefined();
    expect(sendDigest).toHaveBeenCalledTimes(2);
  });

  it('throws when every profile digest fails so BullMQ retries (no 24h-stale silent failure)', async () => {
    await expect(
      aliveHandler({
        logger: stubLogger,
        listActive: () => [profile('p1', ['BTCUSDT']), profile('p2', ['ETHUSDT'])],
        sendDigest: async () => Promise.reject(new Error('binance down')),
      })(job),
    ).rejects.toThrow(/all 2 profile digests failed/);
  });

  it('does not throw when there are no active profiles', async () => {
    await expect(
      aliveHandler({
        logger: stubLogger,
        listActive: () => [],
        sendDigest: vi.fn(async () => undefined),
      })(job),
    ).resolves.toBeUndefined();
  });
});

describe('dailyAthHandler', () => {
  it('refreshes each distinct symbol exactly once across profiles', async () => {
    const refreshAth = vi.fn(async () => undefined);
    await dailyAthHandler({
      logger: stubLogger,
      // BTCUSDT appears twice — must be refreshed once.
      listActive: () => [profile('p1', ['BTCUSDT', 'ETHUSDT']), profile('p2', ['BTCUSDT'])],
      refreshAth,
    })(job);
    expect(refreshAth).toHaveBeenCalledTimes(2);
    expect(refreshAth).toHaveBeenCalledWith('BTCUSDT');
    expect(refreshAth).toHaveBeenCalledWith('ETHUSDT');
  });

  it('isolates a per-symbol failure and continues the batch', async () => {
    const refreshAth = vi.fn(async (symbol: string) => {
      if (symbol === 'BTCUSDT') throw new Error('klines 503');
    });
    await expect(
      dailyAthHandler({
        logger: stubLogger,
        listActive: () => [profile('p1', ['BTCUSDT', 'ETHUSDT'])],
        refreshAth,
      })(job),
    ).resolves.toBeUndefined();
    expect(refreshAth).toHaveBeenCalledTimes(2);
  });

  it('throws when every symbol refresh fails so BullMQ retries', async () => {
    await expect(
      dailyAthHandler({
        logger: stubLogger,
        listActive: () => [profile('p1', ['BTCUSDT', 'ETHUSDT'])],
        refreshAth: async () => Promise.reject(new Error('klines 503')),
      })(job),
    ).rejects.toThrow(/all 2 symbol refreshes failed/);
  });
});

describe('accountSnapshotSafetyHandler', () => {
  const stubRest = {
    getAccount: vi.fn(async () => ({
      balances: [{ asset: 'BTC', free: '1', locked: '0' }],
    })),
  };

  it('skips the REST refresh while the WS user-stream is fresh AND the cache is present', async () => {
    const resolveBinance = vi.fn(async () => stubRest as never);
    const persistAccount = vi.fn(async () => undefined);
    await accountSnapshotSafetyHandler({
      logger: stubLogger,
      listActive: () => [profile('p1', ['BTCUSDT'])],
      resolveBinance,
      persistAccount,
      // WS event 10s ago — inside the 30s staleness window.
      lastWsEventMs: async () => 990_000,
      accountInfoExists: async () => true,
      clock: { nowMs: () => 1_000_000 },
      staleThresholdMs: 30_000,
    })(job);
    expect(resolveBinance).not.toHaveBeenCalled();
    expect(persistAccount).not.toHaveBeenCalled();
  });

  it('forces a full reconcile once the interval elapses, even while WS is fresh and the cache is present', async () => {
    // A missed `outboundAccountPosition` unlock delta leaves a stale per-asset
    // balance the WS merge path never corrects, while `executionReport`s keep
    // the marker fresh and merges keep the key alive — so the plain
    // `wsFresh && present` skip would fire forever. The bounded reconcile must
    // break that: a tick past the interval refreshes from `getAccount`.
    const persistAccount = vi.fn(async () => undefined);
    let nowMs = 1_000_000;
    // One handler instance: the per-profile reconcile clock lives in its closure.
    const handler = accountSnapshotSafetyHandler({
      logger: stubLogger,
      listActive: () => [profile('p1', ['BTCUSDT'])],
      resolveBinance: async () => stubRest as never,
      persistAccount,
      // WS always fresh and cache always present — only the interval forces it.
      lastWsEventMs: async () => nowMs - 1_000,
      accountInfoExists: async () => true,
      clock: { nowMs: () => nowMs },
      staleThresholdMs: 30_000,
      fullReconcileIntervalMs: 30_000,
    });

    // First tick starts reconciled (boot seed already ran a full refresh): skip.
    await handler(job);
    expect(persistAccount).not.toHaveBeenCalled();

    // Still within the interval: skip again.
    nowMs += 20_000;
    await handler(job);
    expect(persistAccount).not.toHaveBeenCalled();

    // Past the interval: force a full reconcile.
    nowMs += 11_000;
    await handler(job);
    expect(persistAccount).toHaveBeenCalledTimes(1);
    expect(persistAccount).toHaveBeenCalledWith('a1', 'p1', [
      { asset: 'BTC', free: '1', locked: '0' },
    ]);

    // The reconcile resets the clock, so the next tick skips again.
    nowMs += 5_000;
    await handler(job);
    expect(persistAccount).toHaveBeenCalledTimes(1);

    // Exactly at the interval forces the next reconcile (the guard is inclusive
    // `>=`): 5_000 + 25_000 = 30_000 since the last reconcile.
    nowMs += 25_000;
    await handler(job);
    expect(persistAccount).toHaveBeenCalledTimes(2);
  });

  it('REST-refreshes when the WS marker is fresh but the cache has expired', async () => {
    // The starvation case: an `executionReport`-only burst keeps the WS marker
    // fresh, but only `account-position` frames write the cache, so the 35s key
    // lapses. Without the presence check the cron would skip and leave the
    // dashboard blank; with it, an absent cache forces a refresh.
    const persistAccount = vi.fn(async () => undefined);
    await accountSnapshotSafetyHandler({
      logger: stubLogger,
      listActive: () => [profile('p1', ['BTCUSDT'])],
      resolveBinance: async () => stubRest as never,
      persistAccount,
      lastWsEventMs: async () => 990_000,
      accountInfoExists: async () => false,
      clock: { nowMs: () => 1_000_000 },
      staleThresholdMs: 30_000,
    })(job);
    expect(persistAccount).toHaveBeenCalledWith('a1', 'p1', [
      { asset: 'BTC', free: '1', locked: '0' },
    ]);
  });

  it('REST-refreshes and persists when no WS event is recorded', async () => {
    const persistAccount = vi.fn(async () => undefined);
    // No WS marker -> the skip short-circuits before reading the cache, so the
    // presence check must NOT be consulted on the dropped-WS path.
    const accountInfoExists = vi.fn(async () => true);
    await accountSnapshotSafetyHandler({
      logger: stubLogger,
      listActive: () => [profile('p1', ['BTCUSDT'])],
      resolveBinance: async () => stubRest as never,
      persistAccount,
      lastWsEventMs: async () => null,
      accountInfoExists,
      clock: { nowMs: () => 1_000_000 },
    })(job);
    expect(persistAccount).toHaveBeenCalledWith('a1', 'p1', [
      { asset: 'BTC', free: '1', locked: '0' },
    ]);
    expect(accountInfoExists).not.toHaveBeenCalled();
  });

  it('skips a profile with no resolvable credentials', async () => {
    const persistAccount = vi.fn(async () => undefined);
    await accountSnapshotSafetyHandler({
      logger: stubLogger,
      listActive: () => [profile('p1', ['BTCUSDT'])],
      resolveBinance: async () => null,
      persistAccount,
      lastWsEventMs: async () => null,
      accountInfoExists: async () => true,
    })(job);
    expect(persistAccount).not.toHaveBeenCalled();
  });

  it('isolates a per-profile REST failure and continues the batch', async () => {
    const persistAccount = vi.fn(async () => undefined);
    const resolveBinance = vi.fn(async (_operatorId: unknown, accountId: unknown) =>
      accountId === 'a1'
        ? ({ getAccount: async () => Promise.reject(new Error('REST 418')) } as never)
        : (stubRest as never),
    );
    await expect(
      accountSnapshotSafetyHandler({
        logger: stubLogger,
        listActive: () => [profile('p1', ['BTCUSDT'], 'a1'), profile('p2', ['ETHUSDT'], 'a2')],
        resolveBinance,
        persistAccount,
        lastWsEventMs: async () => null,
        accountInfoExists: async () => true,
      })(job),
    ).resolves.toBeUndefined();
    // p1's account threw, p2's account still persisted.
    expect(persistAccount).toHaveBeenCalledTimes(1);
    expect(persistAccount).toHaveBeenCalledWith('a2', 'p2', expect.anything());
  });
});

describe('mapDustSnapshot', () => {
  it('maps dust-btc details to DustAsset rows, all canDustTransfer', () => {
    const snap = mapDustSnapshot(
      {
        details: [
          {
            asset: 'TRX',
            assetFullName: 'TRON',
            amountFree: '12.5',
            toBTC: '0.0000123',
            toBNB: '0.001',
            toBNBOffExchange: '0.001',
            exchange: '0',
          },
        ],
        totalTransferBtc: '0.0000123',
        totalTransferBNB: '0.001',
        dribbletPercentage: '0.02',
      },
      1_700_000_000_000,
    );
    expect(snap.assets).toEqual([
      { asset: 'TRX', free: '12.5', locked: '0', estimatedBTC: '0.0000123', canDustTransfer: true },
    ]);
    expect(snap.fetchedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });
});

describe('dustSnapshotHandler', () => {
  const dustRest = (overrides: Partial<BinanceRestClient> = {}): BinanceRestClient =>
    ({
      convertDust: vi.fn(async () => ({
        totalServiceCharge: '0',
        totalTransfered: '0',
        transferResult: [],
      })),
      getDustBtc: vi.fn(async () => ({
        details: [],
        totalTransferBtc: '0',
        totalTransferBNB: '0',
        dribbletPercentage: '0',
      })),
      ...overrides,
    }) as unknown as BinanceRestClient;

  /** Fresh logger so per-test `warn` assertions do not see other tests' calls. */
  const mkLogger = () =>
    ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as Logger;

  /** dustSnapshotHandler deps with replay-safe claim/finalize stubs that all succeed. */
  const dustDeps = (overrides: Partial<Parameters<typeof dustSnapshotHandler>[0]> = {}) => ({
    logger: stubLogger,
    listActive: () => [profile('p1', ['BTCUSDT'])],
    resolveBinance: async () => ({ rest: dustRest(), mode: 'live' as const }),
    persistDust: vi.fn(async () => undefined),
    listPendingDustTransfers: async () => [],
    claimAction: vi.fn(async () => true),
    finalize: vi.fn(async () => true),
    releaseClaim: vi.fn(async () => undefined),
    reapStaleProcessing: vi.fn(async () => 0),
    reapExpiredOverrides: vi.fn(async () => ({ expired: 0, unresolved: [] })),
    clock: { nowMs: () => 1_700_000_000_000 },
    ...overrides,
  });

  it('claims, converts, then finalises a pending transfer and refreshes the snapshot', async () => {
    const rest = dustRest();
    const deps = dustDeps({
      resolveBinance: async () => ({ rest, mode: 'live' as const }),
      listPendingDustTransfers: async () => [{ id: 'a1', assets: ['TRX', 'XRP'] }],
    });
    await expect(dustSnapshotHandler(deps)(job)).resolves.toBeUndefined();
    // The stamp is the caller's, and the release below is fenced on the same value.
    expect(deps.claimAction).toHaveBeenCalledWith('u1', 'a1', 'p1', 'a1', expect.any(Date));
    expect(rest.convertDust).toHaveBeenCalledWith(['TRX', 'XRP']);
    // finalise now also stores the convertDust result as durable history.
    expect(deps.finalize).toHaveBeenCalledWith(
      'u1',
      'a1',
      'p1',
      'a1',
      expect.objectContaining({
        transferResult: expect.any(Array),
      }),
    );
    expect(deps.releaseClaim).not.toHaveBeenCalled();
    expect(deps.persistDust).toHaveBeenCalledTimes(1);
  });

  it('skips an action whose claim is refused so the conversion is not replayed', async () => {
    const rest = dustRest();
    const deps = dustDeps({
      resolveBinance: async () => ({ rest, mode: 'live' as const }),
      listPendingDustTransfers: async () => [{ id: 'a1', assets: ['TRX'] }],
      claimAction: vi.fn(async () => false),
    });
    await expect(dustSnapshotHandler(deps)(job)).resolves.toBeUndefined();
    expect(rest.convertDust).not.toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
    // The snapshot still refreshes regardless of the skipped action.
    expect(deps.persistDust).toHaveBeenCalledTimes(1);
  });

  it('reaps stale claims before listing pending transfers', async () => {
    const calls: string[] = [];
    const reapStaleProcessing = vi.fn(async () => {
      calls.push('reap');
      return 1;
    });
    const listPendingDustTransfers = vi.fn(async () => {
      calls.push('list');
      return [];
    });
    const deps = dustDeps({ reapStaleProcessing, listPendingDustTransfers });
    await expect(dustSnapshotHandler(deps)(job)).resolves.toBeUndefined();
    expect(calls).toEqual(['reap', 'list']);
    // Default 10-min horizon: claims older than now-600s are abandoned.
    expect(reapStaleProcessing).toHaveBeenCalledWith(
      'u1',
      'a1',
      'p1',
      new Date(1_700_000_000_000 - 600_000),
    );
  });

  it('honours a custom staleProcessingMs horizon', async () => {
    const reapStaleProcessing = vi.fn(async () => 0);
    const deps = dustDeps({ reapStaleProcessing, staleProcessingMs: 60_000 });
    await expect(dustSnapshotHandler(deps)(job)).resolves.toBeUndefined();
    expect(reapStaleProcessing).toHaveBeenCalledWith(
      'u1',
      'a1',
      'p1',
      new Date(1_700_000_000_000 - 60_000),
    );
  });

  it('isolates a per-profile failure and continues the batch', async () => {
    const failing = dustRest({
      getDustBtc: vi.fn(async () => Promise.reject(new Error('SAPI 404 — testnet'))),
    });
    const deps = dustDeps({
      listActive: () => [profile('p1', ['BTCUSDT'], 'a1'), profile('p2', ['ETHUSDT'], 'a2')],
      resolveBinance: async (_operatorId, accountId) => ({
        rest: accountId === 'a1' ? failing : dustRest(),
        mode: 'live' as const,
      }),
    });
    await expect(dustSnapshotHandler(deps)(job)).resolves.toBeUndefined();
    // p1's getDustBtc threw; p2 still persisted.
    expect(deps.persistDust).toHaveBeenCalledTimes(1);
    expect(deps.persistDust).toHaveBeenCalledWith('a2', 'p2', expect.anything());
  });

  it('releases the claim and skips finalize when the dust transfer fails', async () => {
    const rest = dustRest({
      convertDust: vi.fn(async () => Promise.reject(new Error('Binance -2010'))),
    });
    const deps = dustDeps({
      resolveBinance: async () => ({ rest, mode: 'live' as const }),
      listPendingDustTransfers: async () => [{ id: 'a1', assets: ['TRX'] }],
    });
    await expect(dustSnapshotHandler(deps)(job)).resolves.toBeUndefined();
    // Fenced on the stamp the claim was made with, so a release abandoned at its
    // deadline cannot come back and clear a later pass's claim.
    const claimedAt = (deps.claimAction as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[4];
    expect(claimedAt).toBeInstanceOf(Date);
    expect(deps.releaseClaim).toHaveBeenCalledWith('u1', 'a1', 'p1', 'a1', claimedAt);
    expect(deps.finalize).not.toHaveBeenCalled();
    // Snapshot still refreshes after the isolated transfer failure.
    expect(deps.persistDust).toHaveBeenCalledTimes(1);
  });

  it('tolerates a releaseClaim failure after a failed transfer — reaper recovers it', async () => {
    const logger = mkLogger();
    const rest = dustRest({
      convertDust: vi.fn(async () => Promise.reject(new Error('Binance -2010'))),
    });
    const deps = dustDeps({
      logger,
      resolveBinance: async () => ({ rest, mode: 'live' as const }),
      listPendingDustTransfers: async () => [{ id: 'a1', assets: ['TRX'] }],
      releaseClaim: vi.fn(async () => Promise.reject(new Error('DB blip'))),
    });
    await expect(dustSnapshotHandler(deps)(job)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'a1' }),
      expect.stringContaining('failed to release'),
    );
    expect(deps.persistDust).toHaveBeenCalledTimes(1);
  });

  it('isolates a claimAction failure — snapshot still refreshes, claim not released', async () => {
    const releaseClaim = vi.fn(async () => undefined);
    const deps = dustDeps({
      listPendingDustTransfers: async () => [{ id: 'a1', assets: ['TRX'] }],
      claimAction: vi.fn(async () => Promise.reject(new Error('DB down'))),
      releaseClaim,
    });
    await expect(dustSnapshotHandler(deps)(job)).resolves.toBeUndefined();
    // A claim that threw is left for the reaper, not released by this pass.
    expect(releaseClaim).not.toHaveBeenCalled();
    // The per-action failure stays isolated — the snapshot still refreshes.
    expect(deps.persistDust).toHaveBeenCalledTimes(1);
  });

  it('warns when the transfer succeeds but the action could not be finalised', async () => {
    const logger = mkLogger();
    const deps = dustDeps({
      logger,
      listPendingDustTransfers: async () => [{ id: 'a1', assets: ['TRX'] }],
      finalize: vi.fn(async () => false),
    });
    await expect(dustSnapshotHandler(deps)(job)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'a1' }),
      expect.stringContaining('not finalised'),
    );
  });
});
