// equity-snapshot-prune cron.
//
// Daily retention sweep over `equity_snapshots`. A 15-min cadence is ~96
// rows/profile/day, so the series is bounded but not free; retention keeps a
// long-but-finite window (EQUITY_SNAPSHOT_RETENTION_DAYS, default 365).
// Single-statement delete; errors bubble so BullMQ's `attempts: 3` retries.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { repo } from '@app/db';
import type { BootContext } from 'boot/boot-context.js';
import { defineCron, type CronDef } from './define.js';
import type { EquitySnapshotPruneJobData } from 'queues/job-payloads.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import { MS_PER_DAY, runRetentionSweep } from './_shared.js';

export interface EquitySnapshotPruneDeps {
  readonly logger: Logger;
  readonly retentionDays: number;
  readonly prune: () => Promise<number>;
}

export const equitySnapshotPruneHandler =
  (deps: EquitySnapshotPruneDeps) =>
  async (job: Job<EquitySnapshotPruneJobData>): Promise<void> =>
    runRetentionSweep(
      deps.logger,
      'equity-snapshot-prune',
      job.data.isoDate,
      deps.retentionDays,
      deps.prune,
    );

export const buildEquitySnapshotPruneCron = (ctx: BootContext): CronDef =>
  defineCron({
    name: 'equity-snapshot-prune',
    queue: QUEUE_NAMES.equitySnapshotPrune,
    pattern: '0 45 3 * * *',
    handler: equitySnapshotPruneHandler({
      logger: ctx.logger,
      retentionDays: ctx.workerEnv.EQUITY_SNAPSHOT_RETENTION_DAYS,
      prune: () =>
        repo.equitySnapshots.pruneOlderThan(
          ctx.db,
          new Date(Date.now() - ctx.workerEnv.EQUITY_SNAPSHOT_RETENTION_DAYS * MS_PER_DAY),
        ),
    }),
  });
