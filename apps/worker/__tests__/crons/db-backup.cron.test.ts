// db-backup cron handler contract. Pure ports, fixed clock, no real pg_dump or
// fs: assert the enabled self-gate, the due-ness window, the deterministic
// filename, and that pruning targets the oldest dumps only.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { BackupConfigRow } from '@app/db';

import { dbBackupHandler, type DbBackupDeps } from '../../src/crons/db-backup.cron.js';

const FIXED_MS = 1_700_000_000_000;
const FIXED = new Date(FIXED_MS);

const noopLogger = (): Logger =>
  ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }) as unknown as Logger;

const config = (over: Partial<BackupConfigRow> = {}): BackupConfigRow => ({
  id: 1,
  enabled: true,
  intervalHours: 24,
  retentionCount: 14,
  lastBackupAt: null,
  updatedAt: FIXED,
  ...over,
});

const baseDeps = (over: Partial<DbBackupDeps> = {}): DbBackupDeps => ({
  logger: noopLogger(),
  now: () => FIXED,
  getConfig: vi.fn(async () => config()),
  runBackup: vi.fn<DbBackupDeps['runBackup']>(async () => undefined),
  touchLastBackup: vi.fn<DbBackupDeps['touchLastBackup']>(async () => undefined),
  listDir: vi.fn(async () => []),
  removeFile: vi.fn(async () => undefined),
  ensureDir: vi.fn(async () => undefined),
  backupDir: '/backups',
  ...over,
});

describe('dbBackupHandler', () => {
  it('skips entirely when backup is disabled', async () => {
    const deps = baseDeps({ getConfig: vi.fn(async () => config({ enabled: false })) });
    await dbBackupHandler(deps)({} as Job);
    expect(deps.runBackup).not.toHaveBeenCalled();
    expect(deps.touchLastBackup).not.toHaveBeenCalled();
    expect(deps.ensureDir).not.toHaveBeenCalled();
  });

  it('skips when enabled but not yet due', async () => {
    // Last backup an hour ago, interval 24h — not due.
    const oneHourAgo = new Date(FIXED_MS - 3_600_000);
    const deps = baseDeps({
      getConfig: vi.fn(async () => config({ lastBackupAt: oneHourAgo, intervalHours: 24 })),
    });
    await dbBackupHandler(deps)({} as Job);
    expect(deps.runBackup).not.toHaveBeenCalled();
    expect(deps.touchLastBackup).not.toHaveBeenCalled();
  });

  it('dumps and touches when due (lastBackupAt null), with a deterministic filename', async () => {
    const deps = baseDeps();
    await dbBackupHandler(deps)({} as Job);
    expect(deps.ensureDir).toHaveBeenCalledTimes(1);
    expect(deps.runBackup).toHaveBeenCalledTimes(1);
    const outPath = (deps.runBackup as ReturnType<typeof vi.fn<DbBackupDeps['runBackup']>>).mock
      .calls[0]?.[0];
    expect(outPath).toBe(`/backups/backup-${FIXED_MS}.dump`);
    expect(deps.touchLastBackup).toHaveBeenCalledTimes(1);
    expect(
      (deps.touchLastBackup as ReturnType<typeof vi.fn<DbBackupDeps['touchLastBackup']>>).mock
        .calls[0]?.[0],
    ).toEqual(FIXED);
  });

  it('does not touch or prune when the dump itself fails', async () => {
    // A failed dump must reject before the success/prune step, so the backup
    // signal and housekeeping never run on a non-existent archive.
    const deps = baseDeps({
      runBackup: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(dbBackupHandler(deps)({} as Job)).rejects.toThrow('boom');
    expect(deps.touchLastBackup).not.toHaveBeenCalled();
    expect(deps.removeFile).not.toHaveBeenCalled();
  });

  it('prunes the oldest dumps beyond retentionCount, keeping the newest', async () => {
    const f = (ms: number): string => `backup-${ms}.dump`;
    const files = [f(100), f(500), f(300), f(200), f(400)];
    const deps = baseDeps({
      getConfig: vi.fn(async () => config({ retentionCount: 2 })),
      listDir: vi.fn(async () => files),
    });
    await dbBackupHandler(deps)({} as Job);
    const removed = (deps.removeFile as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    // Keep 500, 400 (the 2 newest); delete 100, 200, 300.
    expect([...removed].sort()).toEqual([f(100), f(200), f(300)].sort());
    expect(removed).not.toContain(f(500));
    expect(removed).not.toContain(f(400));
  });
});
