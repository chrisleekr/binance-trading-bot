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
import {
  isStatementTimeout,
  poolCheckoutTimeoutKind,
  profileRepo,
  withStatementTimeout,
} from '@app/db';
import type { BootContext } from 'boot/boot-context.js';
import type { MetricsSink } from 'metrics/catalog.js';
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

/** How long between passes. Named once because `PASS_BUDGET_MS` is derived from it: a budget hardcoded next to the period is free to drift away from it. */
const SELF_RESCHEDULE_PERIOD_MS = 900_000;

/**
 * Execution budget for ONE STATEMENT of a profile's recoverable-symbol lookup, not for the lookup as a whole.
 *
 * This is NOT what keeps the pass inside its cadence, and it is not the repair for any query that has been slow in the past. A query that re-executed a subplan per candidate fill is what once made this sweep run for eight hours, and that was fixed in the query itself, by binding every outer reference in the coverage predicate to its immediate parent so the planner flattens it into an anti-join. That rewrite is asserted by a plan-shape test, and flattening is decided at rewrite time rather than by cost estimates, so it cannot come back through statistics drift.
 *
 * What this budget buys is narrower and structural: the loop is serial, so a statement that never returns parks the loop inside its `await`, and no per-pass deadline can even be evaluated while that is true. A server-side cancel is the only mechanism that hands control back WITHOUT stranding the connection, since racing a timer against the promise abandons the query and `pg` releases a pooled connection only when its query settles. So this bound exists to make `PASS_BUDGET_MS` reachable, for whatever unbounded await comes next: a lock wait, chunk growth, a predicate a later change adds.
 *
 * 30s bounds a stall rather than policing a slow but working query. The healthy query returns in roughly a tenth of a second, so only a query that has stopped behaving reaches this.
 */
const PER_STATEMENT_QUERY_BUDGET_MS = 30_000;

/**
 * Wall-clock budget for ONE PASS over the active profiles, checked before each profile is started.
 *
 * `statement_timeout` caps each STATEMENT, and one profile issues two that can stall, the ownership join minted by `scopeProfile` and `listRecoverableSymbols` itself. So the per-statement bound alone lets a pathological pass run for `2 x budget x active profiles`, and nothing bounds the active-profile count. Without a bound on the pass, the cron's own cadence is not held by any constant in this file, and the only thing that would report the breach is `cron_overrun_total` AFTER the run ends.
 *
 * Two thirds of the period. The check is made before a profile is started, not while one is running, so a pass can overshoot by one profile's worst case of `2 x PER_STATEMENT_QUERY_BUDGET_MS`: 600s of budget plus 60s of overshoot stays inside the 900s period, so a pass that exhausts its budget still re-arms with a positive delay instead of back to back. The remaining third also leaves room for the backfill jobs this pass enqueues, which run on the pipeline queue against the same database.
 */
const PASS_BUDGET_MS = (SELF_RESCHEDULE_PERIOD_MS * 2) / 3;

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
  /** Optional so a test or a caller that wires no metrics still runs the sweep; a missing sink loses the counts, never the repair. */
  readonly metrics?: MetricsSink;
  /** Wall-clock source for the pass budget. Optional because the default is a real clock, so the bound holds whether or not a caller wires one; tests inject a controllable clock to drive the budget deterministically. */
  readonly clock?: { nowMs(): number };
}

export const archiveRecoverySweepHandler = (deps: ArchiveRecoverySweepDeps) => {
  // Advances once per run to rotate each profile's window. In-process state, not
  // a lock: the worker is single-replica, and a lost count after a restart only
  // re-picks the head, which is the pre-rotation behaviour rather than a fault.
  let run = 0;
  // Resume cursor into the active-profile list, advanced by however many profiles a run actually reached. `listActive` returns a stable order, so a pass that stops at its budget stops at the same place every time; without resuming, the profiles past that point would never be swept at all. That is the starvation `rotatedBatch` prevents among one profile's symbols, one level up. In-process state, not a lock: the worker is single-replica, and a lost cursor after a restart only re-sweeps from the head.
  let profileCursor = 0;
  return async (_job: Job): Promise<void> => {
    const clock = deps.clock ?? { nowMs: () => Date.now() };
    const startedMs = clock.nowMs();
    const offset = run * MAX_SYMBOLS_PER_PROFILE_PER_RUN;
    run += 1;
    const profiles = deps.listActive();
    if (profiles.length === 0) {
      // Reported rather than skipped silently. A run that emits neither a line nor a counter is indistinguishable from the cron not running at all, and the counter makes that worse rather than better, because the sink creates a series on first use and an all-idle deployment would never create one.
      deps.logger.info(
        { active: 0, swept: 0, failed: 0, timedOut: 0, unswept: 0, enqueued: 0, deferred: 0 },
        'cron archive-recovery-sweep: complete; no active profiles',
      );
      return;
    }
    // Rotated up front so the loop reads in one order and the cursor arithmetic below has one meaning. Same guard shape as `rotatedBatch`: the modulo can never land out of range, and skipping a hole rather than asserting keeps an impossible case from taking the whole pass down.
    const start = profileCursor % profiles.length;
    const rotated: ActiveProfile[] = [];
    for (let i = 0; i < profiles.length; i += 1) {
      const candidate = profiles[(start + i) % profiles.length];
      if (candidate !== undefined) rotated.push(candidate);
    }
    let enqueued = 0;
    let deferred = 0;
    let swept = 0;
    let failed = 0;
    let timedOut = 0;
    let reached = 0;
    for (const profile of rotated) {
      // Before the work, not after: a profile the pass never started is not one it reached.
      if (clock.nowMs() - startedMs >= PASS_BUDGET_MS) break;
      reached += 1;
      // Per-profile isolation: one profile's DB or queue fault must not stop the
      // sweep from repairing every other profile's history.
      try {
        const symbols = await deps.listRecoverable(profile);
        const batch = symbols.length === 0 ? [] : rotatedBatch(symbols, offset);
        deferred += symbols.length - batch.length;
        for (const symbol of batch) {
          await deps.enqueueBackfill(profile, symbol);
          enqueued += 1;
          deps.logger.info(
            { profileId: profile.profileId, symbol },
            'cron archive-recovery-sweep: closed cycle with no archive row; backfill enqueued',
          );
        }
        // A profile with nothing to repair counts as reached, not as skipped: the question the counts answer is how far the pass got, not how much work it found.
        swept += 1;
        deps.metrics?.record('archive_recovery_sweep_profiles_total', 1, { outcome: 'swept' });
      } catch (err) {
        // Three fault shapes, three counts. A cancelled query says the query has degraded until it no longer fits its budget; a broken one says it errored; a refused checkout says the pool was empty before this profile's work began. The third is the account-wide shape — every profile in the pass fails identically — and folding it into `failed` makes a starved pool indistinguishable from one profile's broken query. `withStatementTimeout` opens a transaction, so the checkout is now this sweep's first failure mode, not a theoretical one.
        const outcome = poolCheckoutTimeoutKind(err)
          ? 'checkout'
          : isStatementTimeout(err)
            ? 'timeout'
            : 'failed';
        if (outcome === 'timeout') timedOut += 1;
        else failed += 1;
        deps.metrics?.record('archive_recovery_sweep_profiles_total', 1, { outcome });
        deps.logger.warn(
          { err: err, profileId: profile.profileId, outcome },
          'cron archive-recovery-sweep: profile sweep failed (will retry next run)',
        );
      }
    }
    // Advanced by what this pass reached, so the next one starts on the first profile this one did not.
    profileCursor = start + reached;
    const unswept = rotated.length - reached;
    if (unswept > 0) {
      // Counted by the profiles left behind rather than as one event, so the series answers "how much of the list is going unswept" instead of "did this happen".
      deps.metrics?.record('archive_recovery_sweep_profiles_total', unswept, {
        outcome: 'unswept',
      });
      deps.logger.warn(
        {
          active: rotated.length,
          reached,
          unswept,
          budgetMs: PASS_BUDGET_MS,
          elapsedMs: clock.nowMs() - startedMs,
        },
        'cron archive-recovery-sweep: pass budget exhausted; remaining profiles deferred to the next run',
      );
    }
    // `enqueued` alone cannot separate "nothing needed repair" from "the pass never reached most of the list", which is what made an eight-hour run look like a quiet one.
    deps.logger.info(
      { active: rotated.length, swept, failed, timedOut, unswept, enqueued, deferred },
      'cron archive-recovery-sweep: complete',
    );
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
    selfReschedulePeriodMs: SELF_RESCHEDULE_PERIOD_MS,
    handler: archiveRecoverySweepHandler({
      logger: ctx.logger,
      listActive: ctx.listActive,
      listRecoverable: (p) =>
        withStatementTimeout(ctx.db, PER_STATEMENT_QUERY_BUDGET_MS, async (tx) => {
          const scoped = await profileRepo(tx, p.operatorId, p.accountId, p.profileId);
          return scoped.tradeArchive.listRecoverableSymbols();
        }),
      enqueueBackfill: (p, symbol) =>
        enqueueBackfillJob(ctx.queueSet.queues[QUEUE_NAMES.pipeline], p, symbol),
      metrics: ctx.metrics,
    }),
  });
