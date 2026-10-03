// The audit-prune cron's built handler also sweeps security events on their own horizon and deletes expired single sign-on state. That wiring lives in buildAuditPruneCron rather than the injectable handler, so these cases build the real cron and stub the repo functions it calls.

import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BootContext } from '../../src/boot/boot-context.js';
import { buildAuditPruneCron } from '../../src/crons/audit-prune.cron.js';
import { MS_PER_DAY } from '../../src/crons/_shared.js';
import type { AuditPruneJobData } from '../../src/queues/job-payloads.js';

const stubs = vi.hoisted(() => ({
  storedSettings: vi.fn(async (): Promise<{ settings: unknown; securityEpoch: number }> => ({
    settings: {},
    securityEpoch: 0,
  })),
  pruneAllOlderThan: vi.fn(async (_db: unknown, _cutoff: Date) => 3),
  pruneSecurityOlderThan: vi.fn(async (_db: unknown, _cutoff: Date) => 2),
  pruneExpiredVerifications: vi.fn(async (_db: unknown, _now: Date) => 5),
}));

vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return {
    ...orig,
    repo: {
      ...orig.repo,
      retentionConfig: { ...orig.repo.retentionConfig, get: async () => ({ auditLogDays: 90 }) },
      auditLogs: {
        ...orig.repo.auditLogs,
        pruneAllOlderThan: stubs.pruneAllOlderThan,
        pruneSecurityOlderThan: stubs.pruneSecurityOlderThan,
      },
      authSecuritySettings: { ...orig.repo.authSecuritySettings, get: stubs.storedSettings },
      authIdentity: {
        ...orig.repo.authIdentity,
        pruneExpiredVerifications: stubs.pruneExpiredVerifications,
      },
    },
  };
});

const NOW_MS = Date.UTC(2026, 8, 29);

/**
 * Runs the built audit-prune cron once against the stubbed repo.
 *
 * @returns Resolves when the sweep finished.
 */
const runSweep = async (): Promise<void> => {
  const ctx = {
    db: {},
    logger: pino({ level: 'silent' }),
    redis: { set: async () => 'OK' } as unknown as Redis,
  } as unknown as BootContext;
  await buildAuditPruneCron(ctx).handler({
    data: { isoDate: '2026-09-29' } as AuditPruneJobData,
  } as Job<AuditPruneJobData>);
};

/**
 * Reads how many days back the security sweep's cutoff sat from the fixed clock.
 *
 * @returns Whole days between now and the cutoff passed to pruneSecurityOlderThan.
 */
const securityCutoffDays = (): number => {
  const cutoff = stubs.pruneSecurityOlderThan.mock.calls[0]?.[1];
  if (cutoff === undefined) throw new Error('security sweep did not run');
  return (NOW_MS - cutoff.getTime()) / MS_PER_DAY;
};

describe('audit-prune security event retention', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    stubs.pruneSecurityOlderThan.mockClear();
    stubs.pruneExpiredVerifications.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sweeps security events on the stored retention, not the general audit horizon', async () => {
    stubs.storedSettings.mockResolvedValueOnce({
      settings: { securityEventRetentionDays: 400 },
      securityEpoch: 0,
    });
    await runSweep();
    expect(securityCutoffDays()).toBe(400);
  });

  it('falls back to the default 365 days when the stored retention itself fails validation', async () => {
    // Below the contract's 365-day floor, so trusting the raw value would erase security history early.
    stubs.storedSettings.mockResolvedValueOnce({
      settings: { securityEventRetentionDays: 10 },
      securityEpoch: 0,
    });
    await runSweep();
    expect(securityCutoffDays()).toBe(365);
  });

  it('keeps a valid retention when an unrelated setting fails validation', async () => {
    // One bad field must not drag the security horizon to the default: that would permanently delete events between 365 and 1825 days old that the operator chose to keep.
    stubs.storedSettings.mockResolvedValueOnce({
      settings: { securityEventRetentionDays: 1825, knownDeviceLifetimeDays: 9999 },
      securityEpoch: 0,
    });
    await runSweep();
    expect(securityCutoffDays()).toBe(1825);
  });

  it('deletes expired single sign-on state as of now', async () => {
    await runSweep();
    expect(stubs.pruneExpiredVerifications).toHaveBeenCalledTimes(1);
    expect(stubs.pruneExpiredVerifications.mock.calls[0]?.[1]).toEqual(new Date(NOW_MS));
  });
});
