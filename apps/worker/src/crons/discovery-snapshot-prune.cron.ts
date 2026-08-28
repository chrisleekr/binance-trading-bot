// discovery-snapshot-prune cron.
//
// Daily retention sweep over `discovery_universe_snapshots`. The series
// is MEANT to accumulate for a net-edge discovery backtest window, so retention
// is deliberately generous (DISCOVERY_SNAPSHOT_RETENTION_DAYS, default 180).
// Single-statement delete; the row delete is the only side effect, and errors
// bubble so BullMQ's `attempts: 3` retries the tick rather than silently losing
// the sweep.
//
// Unlike action-log-prune / audit-prune this sweep intentionally writes NO Redis
// retention receipt: the /retention-status dashboard surface tracks only those
// two operator-facing sweeps, and the discovery snapshot series is internal
// backtest fuel. The deleted count is logged instead. Wire a receipt later only
// if the dashboard needs to show this sweep.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { repo } from '@app/db';
import type { BootContext } from 'boot/boot-context.js';
import { defineCron, type CronDef } from './define.js';
import type { DiscoverySnapshotPruneJobData } from 'queues/job-payloads.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import { MS_PER_DAY, runRetentionSweep } from './_shared.js';

export interface DiscoverySnapshotPruneDeps {
  readonly logger: Logger;
  /** Retention horizon (days) the cron applied — echoed into the log line. */
  readonly retentionDays: number;
  /** Invoked once per cron tick to sweep aged-out discovery snapshot rows. */
  readonly prune: () => Promise<number>;
}

export const discoverySnapshotPruneHandler =
  (deps: DiscoverySnapshotPruneDeps) =>
  async (job: Job<DiscoverySnapshotPruneJobData>): Promise<void> =>
    runRetentionSweep(
      deps.logger,
      'discovery-snapshot-prune',
      job.data.isoDate,
      deps.retentionDays,
      deps.prune,
    );

export const buildDiscoverySnapshotPruneCron = (ctx: BootContext): CronDef =>
  defineCron({
    name: 'discovery-snapshot-prune',
    queue: QUEUE_NAMES.discoverySnapshotPrune,
    pattern: '0 40 3 * * *',
    handler: discoverySnapshotPruneHandler({
      logger: ctx.logger,
      retentionDays: ctx.workerEnv.DISCOVERY_SNAPSHOT_RETENTION_DAYS,
      prune: () =>
        repo.discoveryUniverseSnapshots.pruneOlderThan(
          ctx.db,
          new Date(Date.now() - ctx.workerEnv.DISCOVERY_SNAPSHOT_RETENTION_DAYS * MS_PER_DAY),
        ),
    }),
  });
