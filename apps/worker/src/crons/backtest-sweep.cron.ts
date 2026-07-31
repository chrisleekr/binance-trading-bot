// backtest-sweep cron.
//
// Periodic crash-only reconciliation for the backtest subsystem: stuck runs left
// non-terminal (`queued`/`running`) by a process that died before any terminal
// write. The backtest worker's own catch marks a run `error`, but that does not
// close the gap while the worker stays up: a hard kill, or a `failById` that
// itself failed, strands the row `running` forever. The UI then shows it running
// until the next worker reboot.
//
// Runs: each tick reconciles every non-terminal run against its BullMQ job. A
// run whose job is gone (removed) or already terminal (`failed`/`completed`) has
// no live worker, so the row is marked `error`. A run whose job is still live
// (`waiting`/`active`/`delayed`/…) is left untouched, so a legitimately long
// backtest is never killed — and a hung-but-still-locked run is the operator's
// to abort, not the sweep's to guess at. A small age floor skips a just-created
// run so the api's insert→enqueue gap is never misread as abandoned.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';

import type { CronDef } from './define.js';
import { defineCron } from './define.js';
import { QUEUE_NAMES, backtestJobId } from 'queues/queue-names.js';
import { repo } from '@app/db';
import type { BootContext } from 'boot/boot-context.js';

// Skip rows younger than this. The api inserts the `backtest_runs` row and then
// enqueues the job a beat later, so a just-created run can momentarily have no
// job; this floor sits comfortably past that gap. A genuinely abandoned run is
// always older, and a live run is recognised by its job state regardless of age.
const MIN_AGE_MS = 5 * 60_000;

// BullMQ states that mean a worker still owns the job (or soon will). Any other
// state — no job at all (`null`), a terminal `failed`/`completed`, or the
// transient `unknown` — means no live worker for a still-non-terminal row, so it
// is reclaimed. This is exactly the set `Job.getState()` can return that is not
// terminal/unknown: a paused-queue job reports as `waiting` (BullMQ never
// returns the literal `paused` from getState), so it is covered here too.
const LIVE_JOB_STATES = new Set([
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'waiting-children',
]);

export interface BacktestSweepDeps {
  readonly logger: Logger;
  /** Wall clock; injected so a test pins a deterministic age cutoff. */
  readonly clock?: { nowMs(): number };
  /** Non-terminal runs created before `olderThan`, across every profile. */
  readonly listCandidates: (
    olderThan: Date,
  ) => Promise<readonly { id: string; profileId: string }[]>;
  /** BullMQ state of a run's job, or null when no job exists for it. */
  readonly jobState: (runId: string) => Promise<string | null>;
  /** Mark a run `error` by id; returns whether a row transitioned. */
  readonly failRun: (runId: string) => Promise<boolean>;
}

/**
 * Build the handler. Reconciles each candidate run against its queue job and
 * reclaims the abandoned ones. Per-run failures are caught and logged, never
 * thrown, so one unreadable job cannot stop the loop (the next tick retries).
 */
export const backtestSweepHandler = (deps: BacktestSweepDeps) => {
  return async (_job: Job): Promise<void> => {
    const nowMs = (deps.clock ?? { nowMs: () => Date.now() }).nowMs();
    const candidates = await deps.listCandidates(new Date(nowMs - MIN_AGE_MS));
    let recovered = 0;
    for (const run of candidates) {
      try {
        const state = await deps.jobState(run.id);
        // A live job means a worker owns the run — leave it (a long backtest, or
        // a hung run the operator can abort). Only reclaim when nothing live remains.
        if (state !== null && LIVE_JOB_STATES.has(state)) continue;
        if (await deps.failRun(run.id)) {
          recovered += 1;
          deps.logger.warn(
            { runId: run.id, profileId: run.profileId, jobState: state ?? 'gone' },
            'backtest-sweep: reclaimed abandoned run (no live queue job)',
          );
        }
      } catch (err) {
        deps.logger.warn(
          { runId: run.id, err: err },
          'backtest-sweep: reconcile failed (will retry next tick)',
        );
      }
    }
    if (recovered === 0) {
      deps.logger.debug('backtest-sweep: no abandoned runs to reclaim');
    }
  };
};

export const buildBacktestSweepCron = (ctx: BootContext): CronDef => {
  const queue = ctx.queueSet.queues.backtest;
  return defineCron({
    name: 'backtest-sweep',
    queue: QUEUE_NAMES.backtestSweep,
    pattern: '0 */15 * * * *',
    handler: backtestSweepHandler({
      logger: ctx.logger,
      listCandidates: (olderThan) => repo.backtestRuns.listNonTerminalOlderThan(ctx.db, olderThan),
      jobState: async (runId) => {
        const job = await queue.getJob(backtestJobId(runId));
        return job ? await job.getState() : null;
      },
      failRun: (runId) =>
        repo.backtestRuns.failById(
          ctx.db,
          runId,
          'run abandoned: no live backtest worker (queue job gone or terminal)',
        ),
    }),
  });
};
