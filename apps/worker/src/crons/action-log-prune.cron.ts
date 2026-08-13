// action-log-prune cron.
//
// Daily sweep over `action_logs`, applying two rules in one run: an age horizon
// across every profile, then a newest-N cap per profile. Writes a Redis receipt
// so the dashboard can render "last sweep N hours ago" without scanning the
// table. The rows are already deleted by the time the receipt write is
// attempted, so receipt failure is logged and swallowed.
//
// The per-rule counts are reported separately, never collapsed into one figure.
// An age sweep deleting nothing while a mis-set cap deletes a profile's whole
// history is indistinguishable from a healthy run if the receipt carries one
// number. The age rule reports two of its own: `action_logs` is a hypertable and
// the horizon always falls inside one chunk, so whole expired chunks are
// unlinked without reading a row and only the straddling chunk is swept row by
// row. A night that discarded a month therefore has a tiny row count.
//
// A failure writes a receipt too, then rethrows. The throw is what makes BullMQ
// retry; the receipt is what stops the previous success from standing on the
// dashboard as evidence of a horizon that is no longer being applied.
//
// Both settings are read from `retention_config` on every run rather than
// captured at boot, so an operator changing them in the UI does not have to
// restart the worker. This cron is also the ONLY deleter: the TimescaleDB
// retention policy that used to drop chunks on its own schedule was removed,
// because two owners for one horizon let the table be swept days earlier than
// the dashboard said.
//
// The cap can be this aggressive only because current state left the log
// stream. A condition holding for weeks lives in `condition_states` with its own
// `since`, so deleting its opening edge no longer erases the fact that it holds.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { repo } from '@app/db';
import type { BootContext } from 'boot/boot-context.js';
import { defineCron, type CronDef } from './define.js';
import type { ActionLogPruneJobData } from 'queues/job-payloads.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import { MS_PER_DAY, describeRetentionFailure, writeRetentionReceipt } from './_shared.js';

export interface ActionLogPruneDeps {
  readonly logger: Logger;
  /** Raw ioredis client. Receipts go through Redis without a key catalogue wrapper. */
  readonly redis: Redis;
  /** Wall-clock source. Tests inject a fixed clock so the receipt's `ranAtMs` is deterministic. */
  readonly clock?: { nowMs(): number };
  /**
   * Resolves this run's two limits. Invoked per tick rather than closed over, so
   * a UI change applies on the next sweep instead of the next restart. The
   * resolved values are what the receipt echoes, so the dashboard reports the
   * limits that actually deleted the rows.
   */
  readonly resolveLimits: () => Promise<{ retentionDays: number; maxRows: number }>;
  /**
   * Deletes everything older than `days` across every profile. Reports its two
   * units separately because it deletes in two: whole expired hypertable chunks
   * are unlinked without reading their rows, and only the chunk straddling the
   * horizon is swept row by row. A run that discarded a month of history can
   * therefore report a single-digit row count, so the chunk figure is what makes
   * the receipt able to say the sweep did anything at all.
   */
  readonly pruneByAge: (days: number) => Promise<{ chunksDropped: number; rowsDeleted: number }>;
  /** Every profile in the deployment, disabled included — their old rows still count. */
  readonly listProfileIds: () => Promise<string[]>;
  /** Trims one profile to its newest `maxRows` rows, returning the count deleted. */
  readonly pruneByRowCap: (profileId: string, maxRows: number) => Promise<number>;
}

export const actionLogPruneHandler =
  (deps: ActionLogPruneDeps) =>
  async (job: Job<ActionLogPruneJobData>): Promise<void> => {
    const { isoDate } = job.data;
    const clock = deps.clock ?? { nowMs: () => Date.now() };

    // Hoisted out of the try so a failure receipt can still report the limits
    // this run had read and the rows it had already deleted before it died. A
    // half-applied sweep that reports nothing is indistinguishable from one that
    // never started.
    let retentionDays: number | null = null;
    let maxRows: number | null = null;
    let ageChunks = 0;
    let ageRows = 0;
    let byRowCap = 0;

    try {
      const limits = await deps.resolveLimits();
      retentionDays = limits.retentionDays;
      maxRows = limits.maxRows;

      // Age first: it is cheap and cross-tenant, and every row it removes is one
      // the per-profile pass does not have to rank.
      const byAge = await deps.pruneByAge(retentionDays);
      ageChunks = byAge.chunksDropped;
      ageRows = byAge.rowsDeleted;
      deps.logger.info(
        { isoDate, rule: 'age', deleted: ageRows, chunksDropped: ageChunks, retentionDays },
        'cron action-log-prune: age horizon applied',
      );

      let cappedProfiles = 0;
      for (const profileId of await deps.listProfileIds()) {
        const deleted = await deps.pruneByRowCap(profileId, maxRows);
        if (deleted === 0) continue;
        byRowCap += deleted;
        cappedProfiles += 1;
        deps.logger.info(
          { isoDate, rule: 'row-cap', profileId, deleted, maxRows },
          'cron action-log-prune: profile trimmed to row cap',
        );
      }
      deps.logger.info(
        { isoDate, rule: 'row-cap', deleted: byRowCap, cappedProfiles, maxRows },
        'cron action-log-prune: row cap applied',
      );
    } catch (err) {
      // The throw still happens (BullMQ's `attempts` must retry the tick), but a
      // DLQ entry is not a surface the operator reads. Without this receipt the
      // last successful one stays on the dashboard, reporting a horizon that has
      // silently stopped being applied — which is how a stalling sweep ran
      // unnoticed while rows accumulated past their configured age.
      deps.logger.error(
        { isoDate, err, retentionDays, maxRows },
        'cron action-log-prune: sweep failed, receipt marked failed',
      );
      await writeRetentionReceipt(deps.redis, deps.logger, 'action-log-prune', {
        ranAtMs: clock.nowMs(),
        ok: false,
        // Classified, never the driver's own text: this string is served on a
        // route an anonymous visitor can read under LIVE_DEMO, and a Postgres
        // exception names internal hosts, ports and relations. The full message
        // is in the error log above.
        error: describeRetentionFailure(err),
        deleted: ageRows + byRowCap,
        retentionDays,
        byRule: { age: ageRows, ageChunks, rowCap: byRowCap },
        maxRows,
      });
      throw err;
    }

    await writeRetentionReceipt(deps.redis, deps.logger, 'action-log-prune', {
      ranAtMs: clock.nowMs(),
      deleted: ageRows + byRowCap,
      retentionDays,
      byRule: { age: ageRows, ageChunks, rowCap: byRowCap },
      maxRows,
    });
  };

export const buildActionLogPruneCron = (ctx: BootContext): CronDef =>
  defineCron({
    name: 'action-log-prune',
    queue: QUEUE_NAMES.actionLogPrune,
    pattern: '0 30 3 * * *',
    handler: actionLogPruneHandler({
      logger: ctx.logger,
      redis: ctx.redis,
      resolveLimits: async () => {
        const cfg = await repo.retentionConfig.get(ctx.db);
        return { retentionDays: cfg.actionLogDays, maxRows: cfg.actionLogMaxRows };
      },
      pruneByAge: (days) =>
        repo.actionLogs.pruneOlderThan(ctx.db, new Date(Date.now() - days * MS_PER_DAY)),
      listProfileIds: () => repo.profiles.listAllIds(ctx.db),
      pruneByRowCap: (profileId, maxRows) =>
        repo.actionLogs.pruneBeyondRowCap(ctx.db, profileId, maxRows),
    }),
  });
