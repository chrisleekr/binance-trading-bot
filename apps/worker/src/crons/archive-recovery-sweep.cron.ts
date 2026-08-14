// archive-recovery-sweep cron.
//
// Periodic backstop for Trade History gaps. The forward archive only fires when
// a SELL resolves the position to `clear`; anything that closed a cycle without
// reaching that branch (a fee-inflated residual, a stale-order reap, a symbol
// rotated out mid-exit) leaves real, realised P/L with no `trade_archive` row
// and no signal — the operator's history just silently omits the trade.
//
// `listRecoverableSymbols` already computes exactly that set (closed cycle, no
// archive row, no still-valid backfill attempt), but until now only the archive
// SCREEN called it, so a gap was repaired only if the operator happened to open
// the page and press the button. This sweep closes that loop: the same query,
// on a timer, enqueueing the same `backfill-trade-archive` job the button does.
//
// `selfReschedulePeriodMs`, not `pattern`: the pass fans out one scoped query
// per active profile and the jobs it enqueues each paginate `myTrades`, so a
// slow run must delay the next one rather than overlap it and re-enqueue the
// same symbols against the account's Binance weight budget.

import type { Job, Queue } from 'bullmq';
import type { Logger } from 'pino';
import { profileRepo } from '@app/db';
import type { BootContext } from 'boot/boot-context.js';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import { defineCron, type CronDef } from './define.js';

/**
 * Symbols enqueued per profile per run. A profile that has accumulated a long
 * gap list would otherwise fire one full `myTrades` pagination per symbol in a
 * single burst against one account's weight budget. The remainder is picked up
 * on the following runs, so the backlog drains at a bounded rate.
 */
const MAX_SYMBOLS_PER_PROFILE_PER_RUN = 5;

/**
 * The run's slice of a profile's recoverable set, rotated by `offset` symbols.
 *
 * A fixed head would starve the tail: `listRecoverableSymbols` returns symbols
 * in a stable alphabetical order, and NOT every handler exit lands the marker
 * that drops a symbol out of the set — an unresolvable Binance client and a
 * cold symbol-info cache both leave it recoverable. Five such symbols at the
 * head would monopolise the budget on every run forever and symbol six onward
 * would never be repaired.
 */
const rotatedBatch = (symbols: readonly string[], offset: number): string[] => {
  const take = Math.min(MAX_SYMBOLS_PER_PROFILE_PER_RUN, symbols.length);
  const start = offset % symbols.length;
  const batch: string[] = [];
  for (let i = 0; i < take; i += 1) {
    const symbol = symbols[(start + i) % symbols.length];
    if (symbol !== undefined) batch.push(symbol);
  }
  return batch;
};

export interface ArchiveRecoverySweepDeps {
  readonly logger: Logger;
  readonly listActive: () => readonly ActiveProfile[];
  /** Closed cycles with no archive row and no still-valid backfill attempt. */
  readonly listRecoverable: (profile: ActiveProfile) => Promise<readonly string[]>;
  readonly enqueueBackfill: (profile: ActiveProfile, symbol: string) => Promise<void>;
}

export const archiveRecoverySweepHandler = (deps: ArchiveRecoverySweepDeps) => {
  // Advances once per run to rotate each profile's window. In-process state, not
  // a lock: the worker is single-replica, and a lost count after a restart only
  // re-picks the head, which is the pre-rotation behaviour rather than a fault.
  let run = 0;
  return async (_job: Job): Promise<void> => {
    const offset = run * MAX_SYMBOLS_PER_PROFILE_PER_RUN;
    run += 1;
    const profiles = deps.listActive();
    if (profiles.length === 0) {
      deps.logger.debug('cron archive-recovery-sweep: no active profiles; skipped');
      return;
    }
    let enqueued = 0;
    let deferred = 0;
    for (const profile of profiles) {
      // Per-profile isolation: one profile's DB or queue fault must not stop the
      // sweep from repairing every other profile's history.
      try {
        const symbols = await deps.listRecoverable(profile);
        if (symbols.length === 0) continue;
        const batch = rotatedBatch(symbols, offset);
        deferred += symbols.length - batch.length;
        for (const symbol of batch) {
          await deps.enqueueBackfill(profile, symbol);
          enqueued += 1;
          deps.logger.info(
            { profileId: profile.profileId, symbol },
            'cron archive-recovery-sweep: closed cycle with no archive row; backfill enqueued',
          );
        }
      } catch (err) {
        deps.logger.warn(
          { err: err, profileId: profile.profileId },
          'cron archive-recovery-sweep: profile sweep failed (will retry next run)',
        );
      }
    }
    deps.logger.info({ enqueued, deferred }, 'cron archive-recovery-sweep: complete');
  };
};

/**
 * Enqueue the same pipeline job the archive screen's "Recover" button enqueues,
 * over the symbol's whole history (`null` bounds). A distinct `jobId` per run
 * rather than a static one: the pipeline queue RETAINS terminal jobs
 * (`removeOnComplete: { count: 1_000 }`), so a static id would be permanently
 * occupied after the first completion and every later repair would be silently
 * dropped. Re-running is safe — the handler skips round-trips whose closing
 * trade id is already archived.
 */
const enqueueBackfillJob = async (
  queue: Queue,
  profile: ActiveProfile,
  symbol: string,
): Promise<void> => {
  await queue.add(
    'backfill-trade-archive',
    {
      userId: profile.operatorId,
      accountId: profile.accountId,
      profileId: profile.profileId,
      symbol,
      fromMs: null,
      toMs: null,
    },
    { jobId: `backfill-archive:sweep:${profile.profileId}:${symbol}:${Date.now()}` },
  );
};

export const buildArchiveRecoverySweepCron = (ctx: BootContext): CronDef =>
  defineCron({
    name: 'archive-recovery-sweep',
    queue: QUEUE_NAMES.archiveRecoverySweep,
    // 15 minutes, matching the other convergence backstops. A missing history
    // row is not time-critical (the money already moved and the fills are
    // recorded); what matters is that it heals without the operator noticing.
    selfReschedulePeriodMs: 900_000,
    handler: archiveRecoverySweepHandler({
      logger: ctx.logger,
      listActive: ctx.listActive,
      listRecoverable: async (p) => {
        const scoped = await profileRepo(ctx.db, p.operatorId, p.accountId, p.profileId);
        return scoped.tradeArchive.listRecoverableSymbols();
      },
      enqueueBackfill: (p, symbol) =>
        enqueueBackfillJob(ctx.queueSet.queues[QUEUE_NAMES.pipeline], p, symbol),
    }),
  });
