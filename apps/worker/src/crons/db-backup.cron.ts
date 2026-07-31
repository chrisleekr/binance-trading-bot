// db-backup cron.
//
// Periodically dumps the whole database to a file, then prunes old dumps to
// the operator's retention count. The cron is ALWAYS registered and self-gates
// on the DB `enabled` flag each cycle, so a UI toggle takes effect with no
// worker restart. Due-ness is driven by `lastBackupAt` + `intervalHours` from
// the same DB row, so the 5-min self-reschedule period is just the polling
// granularity, not the backup cadence.
//
// Self-rescheduling: a full pg_dump can run for minutes, so a fixed-cadence
// scheduler would overlap runs; enqueuing the next run only on the current
// run's terminal state makes a slow dump delay rather than overlap the next.

import { join } from 'node:path';
import * as fs from 'node:fs/promises';

import type { Job } from 'bullmq';
import type { Logger } from 'pino';

import { repo, type BackupConfigRow } from '@app/db';
import { pgDumpToFile } from '@app/core/backup';
import type { BootContext } from 'boot/boot-context.js';

import { defineCron, type CronDef } from './define.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import { selectBackupsToPrune } from './retention-select.js';

const HOUR_MS = 3_600_000;

export interface DbBackupDeps {
  readonly logger: Logger;
  /** Wall clock; injected so tests pin a deterministic backup filename. */
  readonly now: () => Date;
  readonly getConfig: () => Promise<BackupConfigRow>;
  /** Run pg_dump into `outPath`; rejects on a nonzero exit. */
  readonly runBackup: (outPath: string) => Promise<void>;
  readonly touchLastBackup: (at: Date) => Promise<void>;
  readonly listDir: () => Promise<string[]>;
  readonly removeFile: (name: string) => Promise<void>;
  readonly ensureDir: () => Promise<void>;
  readonly backupDir: string;
}

export const dbBackupHandler =
  (deps: DbBackupDeps) =>
  async (_job: Job): Promise<void> => {
    const cfg = await deps.getConfig();
    if (!cfg.enabled) {
      deps.logger.debug('db-backup: disabled, skipping');
      return;
    }

    const now = deps.now();
    const last = cfg.lastBackupAt;
    if (last != null && now.getTime() - last.getTime() < cfg.intervalHours * HOUR_MS) {
      const nextDueMs = last.getTime() + cfg.intervalHours * HOUR_MS;
      deps.logger.debug({ nextDueMs }, 'db-backup: not due yet, skipping');
      return;
    }

    await deps.ensureDir();
    const ts = now.getTime();
    const fileName = `backup-${ts}.dump`;
    const outPath = join(deps.backupDir, fileName);

    await deps.runBackup(outPath);
    // Record the success BEFORE pruning: a prune failure must not roll back the
    // backup signal, or the next cycle would re-dump even though a good archive
    // already exists on disk. The dump is the durable result; pruning is
    // best-effort housekeeping.
    await deps.touchLastBackup(now);

    const files = await deps.listDir();
    // A 0/negative retention must never delete every backup right after writing
    // one, so floor the keep count at 1.
    const keep = Math.max(1, cfg.retentionCount);
    const toPrune = selectBackupsToPrune(files, keep);
    for (const f of toPrune) await deps.removeFile(f);

    // By prune time this run's own temp has already been renamed to `.dump`, so
    // any remaining `.partial` is left over: either a prior crashed dump, or one
    // whose own cleanup unlink failed and reported instead of silently retrying.
    // Sweep them so they don't accumulate.
    const stale = files.filter((f) => f.endsWith('.dump.partial'));
    for (const f of stale) await deps.removeFile(f);

    deps.logger.info(
      { outPath, pruned: toPrune.length, staleRemoved: stale.length },
      'db-backup: dump written',
    );
  };

export const buildDbBackupCron = (ctx: BootContext): CronDef => {
  const backupDir = ctx.workerEnv.BACKUP_DIR;
  return defineCron({
    name: 'db-backup',
    queue: QUEUE_NAMES.dbBackup,
    selfReschedulePeriodMs: 300_000,
    handler: dbBackupHandler({
      logger: ctx.logger,
      now: () => new Date(),
      getConfig: () => repo.backupConfig.get(ctx.db),
      touchLastBackup: (at) => repo.backupConfig.touchLastBackup(ctx.db, at),
      runBackup: (outPath) =>
        pgDumpToFile({
          databaseUrl: ctx.workerEnv.DATABASE_URL,
          pgSslMode: ctx.workerEnv.PGSSLMODE,
          outPath,
        }),
      listDir: () => fs.readdir(backupDir),
      removeFile: (name) => fs.unlink(join(backupDir, name)),
      ensureDir: () => fs.mkdir(backupDir, { recursive: true }).then(() => undefined),
      backupDir,
    }),
  });
};
