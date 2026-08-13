// audit-prune cron.
//
// Daily retention sweep over the audit log table. The horizon comes from
// `retention_config` and is re-read on every run, so an operator changing it in
// the UI does not have to restart the worker.
//
// This horizon is deliberately separate from the action-log one: audit_logs is
// the record of what the OPERATOR changed — config edits, manual orders,
// kill-switch flips — and cutting it to the action-log horizon would make
// "when did I change that setting?" unanswerable.
//
// A failure writes a receipt too, then rethrows. The throw is what makes BullMQ
// retry; the receipt is what stops the previous success from standing on the
// dashboard as evidence of a horizon that is no longer being applied.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { repo } from '@app/db';
import type { BootContext } from 'boot/boot-context.js';
import { defineCron, type CronDef } from './define.js';
import type { AuditPruneJobData } from 'queues/job-payloads.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import {
  MS_PER_DAY,
  describeRetentionFailure,
  runRetentionSweep,
  writeRetentionReceipt,
} from './_shared.js';

export interface AuditPruneDeps {
  readonly logger: Logger;
  readonly redis: Redis;
  readonly clock?: { nowMs(): number };
  /**
   * Resolves this run's retention horizon. Invoked per tick rather than closed
   * over, so a UI change applies on the next sweep instead of the next restart.
   */
  readonly resolveRetentionDays: () => Promise<number>;
  readonly pruneOlderThan: (days: number) => Promise<number>;
}

export const auditPruneHandler =
  (deps: AuditPruneDeps) =>
  async (job: Job<AuditPruneJobData>): Promise<void> => {
    const { isoDate } = job.data;
    const clock = deps.clock ?? { nowMs: () => Date.now() };
    // Hoisted so a failure receipt can still name the horizon a run had read
    // before it died. Null means it never got that far.
    let retentionDays: number | null = null;

    try {
      const days = await deps.resolveRetentionDays();
      retentionDays = days;
      await runRetentionSweep(
        deps.logger,
        'audit-prune',
        isoDate,
        days,
        () => deps.pruneOlderThan(days),
        { redis: deps.redis, kind: 'audit-prune', ...(deps.clock ? { clock: deps.clock } : {}) },
      );
    } catch (err) {
      // The throw still reaches BullMQ so the tick retries, but a DLQ entry is
      // not a surface the operator reads. Without this receipt the last success
      // stays on the audit panel reporting a horizon that has silently stopped
      // being applied.
      deps.logger.error(
        { isoDate, err, retentionDays },
        'cron audit-prune: sweep failed, receipt marked failed',
      );
      await writeRetentionReceipt(deps.redis, deps.logger, 'audit-prune', {
        ranAtMs: clock.nowMs(),
        ok: false,
        // Classified, never the driver's own text: this string is served on a
        // route an anonymous visitor can read under LIVE_DEMO.
        error: describeRetentionFailure(err),
        // Nothing is known to have been deleted: `pruneAllOlderThan` reports its
        // count only on success, so claiming a partial figure here would invent one.
        deleted: 0,
        retentionDays,
      });
      throw err;
    }
  };

export const buildAuditPruneCron = (ctx: BootContext): CronDef =>
  defineCron({
    name: 'audit-prune',
    queue: QUEUE_NAMES.auditPrune,
    pattern: '0 35 3 * * *',
    handler: auditPruneHandler({
      logger: ctx.logger,
      redis: ctx.redis,
      resolveRetentionDays: async () => (await repo.retentionConfig.get(ctx.db)).auditLogDays,
      pruneOlderThan: (days) =>
        repo.auditLogs.pruneAllOlderThan(ctx.db, new Date(Date.now() - days * MS_PER_DAY)),
    }),
  });
