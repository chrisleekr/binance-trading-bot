// audit-prune cron.
//
// Daily retention sweep over the audit log table.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { repo } from '@app/db';
import type { BootContext } from 'boot/boot-context.js';
import { defineCron, type CronDef } from './define.js';
import type { AuditPruneJobData } from 'queues/job-payloads.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import { MS_PER_DAY, runRetentionSweep } from './_shared.js';

export interface AuditPruneDeps {
  readonly logger: Logger;
  readonly redis: Redis;
  readonly clock?: { nowMs(): number };
  readonly retentionDays: number;
  readonly pruneOlderThan: (days: number) => Promise<number>;
}

export const auditPruneHandler =
  (deps: AuditPruneDeps) =>
  async (job: Job<AuditPruneJobData>): Promise<void> =>
    runRetentionSweep(
      deps.logger,
      'audit-prune',
      job.data.isoDate,
      deps.retentionDays,
      () => deps.pruneOlderThan(deps.retentionDays),
      { redis: deps.redis, kind: 'audit-prune', ...(deps.clock ? { clock: deps.clock } : {}) },
    );

export const buildAuditPruneCron = (ctx: BootContext): CronDef =>
  defineCron({
    name: 'audit-prune',
    queue: QUEUE_NAMES.auditPrune,
    pattern: '0 35 3 * * *',
    handler: auditPruneHandler({
      logger: ctx.logger,
      redis: ctx.redis,
      retentionDays: ctx.workerEnv.AUDIT_LOG_RETENTION_DAYS,
      pruneOlderThan: (days) =>
        repo.auditLogs.pruneAllOlderThan(ctx.db, new Date(Date.now() - days * MS_PER_DAY)),
    }),
  });
