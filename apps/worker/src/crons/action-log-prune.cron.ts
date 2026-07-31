// action-log-prune cron.
//
// Daily retention sweep over `action_log`. Writes a Redis receipt so the
// dashboard can render "last sweep N hours ago" without scanning the
// table. Single-statement delete; the row delete already succeeded by
// the time the receipt write is attempted, so receipt failure is logged
// and swallowed.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { repo } from '@app/db';
import type { BootContext } from 'boot/boot-context.js';
import { defineCron, type CronDef } from './define.js';
import type { ActionLogPruneJobData } from 'queues/job-payloads.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import { MS_PER_DAY, runRetentionSweep } from './_shared.js';

export interface ActionLogPruneDeps {
  readonly logger: Logger;
  /** Raw ioredis client. Receipts go through Redis without a key catalogue wrapper. */
  readonly redis: Redis;
  /** Wall-clock source. Tests inject a fixed clock so the receipt's `ranAtMs` is deterministic. */
  readonly clock?: { nowMs(): number };
  /** Retention horizon (days) the cron applied — echoed into the receipt so the dashboard can render the policy. */
  readonly retentionDays: number;
  /**
   * Invoked once per cron tick to sweep aged-out action_log rows. The
   * caller closes over the retention horizon (today: the worker's
   * `ACTION_LOG_RETENTION_DAYS` env var, applied globally). The function
   * name stays generic so a future per-profile retention implementation
   * can swap in without changing this interface.
   */
  readonly prune: () => Promise<number>;
}

export const actionLogPruneHandler =
  (deps: ActionLogPruneDeps) =>
  async (job: Job<ActionLogPruneJobData>): Promise<void> =>
    runRetentionSweep(
      deps.logger,
      'action-log-prune',
      job.data.isoDate,
      deps.retentionDays,
      deps.prune,
      { redis: deps.redis, kind: 'action-log-prune', ...(deps.clock ? { clock: deps.clock } : {}) },
    );

export const buildActionLogPruneCron = (ctx: BootContext): CronDef =>
  defineCron({
    name: 'action-log-prune',
    queue: QUEUE_NAMES.actionLogPrune,
    pattern: '0 30 3 * * *',
    handler: actionLogPruneHandler({
      logger: ctx.logger,
      redis: ctx.redis,
      retentionDays: ctx.workerEnv.ACTION_LOG_RETENTION_DAYS,
      prune: () =>
        repo.actionLogs.pruneOlderThan(
          ctx.db,
          new Date(Date.now() - ctx.workerEnv.ACTION_LOG_RETENTION_DAYS * MS_PER_DAY),
        ),
    }),
  });
