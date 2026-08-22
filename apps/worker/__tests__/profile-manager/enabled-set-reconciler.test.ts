import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';

import { createEnabledSetReconciler } from '../../src/profile-manager/enabled-set-reconciler.js';
import type { ProfileLoadRow } from '../../src/profile-manager/profile-manager.js';

const silentLogger = new Proxy({} as Logger, { get: () => () => undefined }) as Logger;

const rows: ProfileLoadRow[] = [
  {
    userId: 'u1' as ProfileLoadRow['userId'],
    operatorId: 'u1' as ProfileLoadRow['operatorId'],
    accountId: 'a1' as ProfileLoadRow['accountId'],
    profileId: 'p1' as ProfileLoadRow['profileId'],
    symbols: ['BTCUSDT'],
    candleInterval: '1h',
    technicalsIntervals: [],
  },
];

describe('enabledSetReconciler', () => {
  it('reads the enabled set, converges the manager, then re-elects ownership', async () => {
    const loadEnabledProfiles = vi.fn(async () => rows);
    const reconcile = vi.fn(async () => undefined);
    const ownershipReconcile = vi.fn(async () => undefined);

    const r = createEnabledSetReconciler({
      loadEnabledProfiles,
      profileManager: { reconcile },
      ownership: { reconcile: ownershipReconcile },
      logger: silentLogger,
    });
    await r.reconcile();

    expect(reconcile).toHaveBeenCalledWith(rows);
    // Membership converge happens before the stream re-election.
    expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(
      ownershipReconcile.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it('keeps membership on a DB read failure (skips converge + re-election)', async () => {
    const loadEnabledProfiles = vi.fn(async () => {
      throw new Error('db down');
    });
    const reconcile = vi.fn(async () => undefined);
    const ownershipReconcile = vi.fn(async () => undefined);

    const r = createEnabledSetReconciler({
      loadEnabledProfiles,
      profileManager: { reconcile },
      ownership: { reconcile: ownershipReconcile },
      logger: silentLogger,
    });
    await r.reconcile();

    expect(reconcile).not.toHaveBeenCalled();
    expect(ownershipReconcile).not.toHaveBeenCalled();
  });

  it('swallows a converge error so the timer never rejects, and reconverges next pass', async () => {
    const loadEnabledProfiles = vi.fn(async () => rows);
    const reconcile = vi.fn(async () => {
      throw new Error('market hook rejected');
    });
    const ownershipReconcile = vi.fn(async () => undefined);

    const r = createEnabledSetReconciler({
      loadEnabledProfiles,
      profileManager: { reconcile },
      ownership: { reconcile: ownershipReconcile },
      logger: silentLogger,
    });

    // A converge throw must resolve (not reject) so the timer callback and the
    // awaited boot start() never see an unhandled rejection.
    await expect(r.reconcile()).resolves.toBeUndefined();
    expect(ownershipReconcile).not.toHaveBeenCalled();
    // inFlight was cleared in the finally, so the next pass runs a fresh load.
    await r.reconcile();
    expect(loadEnabledProfiles).toHaveBeenCalledTimes(2);
  });

  it('serialises overlapping reconciles (a slow pass blocks a re-entrant one)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const loadEnabledProfiles = vi.fn(async () => {
      await gate;
      return rows;
    });
    const reconcile = vi.fn(async () => undefined);
    const ownershipReconcile = vi.fn(async () => undefined);

    const r = createEnabledSetReconciler({
      loadEnabledProfiles,
      profileManager: { reconcile },
      ownership: { reconcile: ownershipReconcile },
      logger: silentLogger,
    });
    const first = r.reconcile();
    await r.reconcile(); // inFlight -> returns immediately without a second load
    expect(loadEnabledProfiles).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});
