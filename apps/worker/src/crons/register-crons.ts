// Cron registration loop.
//
// Walks an array of {@link CronDef} and for each entry:
//   1. Upserts a BullMQ Job Scheduler on the matching queue. Schedulers
//      are Redis-coordinated; multiple worker replicas can call this
//      and only one trigger fires per tick.
//   2. Registers the matching Worker on the same queue so jobs the
//      scheduler enqueues actually get processed.
//
// The previous `switch (spec.name)` dispatch + `RegisterCronsDeps`
// god-union are gone: each `defineCron` call at the boot site already
// closed over its own deps and produced a bound handler. Adding a cron
// is one new file (or one new `defineCron(...)` literal) plus a push
// into the boot array — no central registry to grow.

import type { Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { QueueSet } from 'queues/queue-set.js';
import { QUEUE_SPECS } from 'queues/queue-names.js';
import type { MetricsSink } from 'metrics/catalog.js';
import type { CronDef } from './define.js';
import { withCronStatus } from './cron-status.js';

export interface RegisterCronsDeps {
  readonly queueSet: QueueSet;
  readonly logger: Logger;
  /** Records each cron's terminal run outcome for the ops health panel. */
  readonly redis: Redis;
  readonly crons: readonly CronDef[];
  /** Optional so a caller that wires no metrics still boots; a missing sink loses the overrun signal, never the cron. */
  readonly metrics?: MetricsSink;
}

const SELF_RESCHEDULE_OPTS = {
  removeOnComplete: { count: 50 },
  removeOnFail: { count: 100 },
} as const;

/**
 * Wire a self-rescheduling cron (see {@link CronDef.selfReschedulePeriodMs}).
 * No BullMQ Job Scheduler is created; instead the next run is enqueued only on
 * the current run's terminal state, so iterations can never overlap or backlog.
 * Removing any prior scheduler and draining the jobs it leaked lets a restart
 * heal a deployment whose fixed-cadence scheduler had already wedged.
 */
const registerSelfReschedulingCron = async (
  queue: Queue,
  def: CronDef,
  deps: RegisterCronsDeps,
): Promise<void> => {
  const periodMs = def.selfReschedulePeriodMs ?? 0;
  await queue.removeJobScheduler(def.name).catch(() => undefined);
  // The wedged scheduler leaked ~1000 delayed `repeat:*` jobs and a large
  // failed set; drain them so they stop accumulating and consuming memory.
  await queue.clean(0, 10_000, 'delayed').catch(() => undefined);
  await queue.clean(0, 10_000, 'failed').catch(() => undefined);

  const enqueueNext = (delayMs: number): void => {
    void queue
      .add(def.name, {}, { delay: Math.max(0, delayMs), ...SELF_RESCHEDULE_OPTS })
      .catch((err: unknown) => {
        deps.logger.error(
          { cron: def.name, err: err },
          'cron self-reschedule: failed to enqueue next run',
        );
      });
  };

  const worker = deps.queueSet.registerWorker(
    def.queue as Parameters<QueueSet['registerWorker']>[0],
    withCronStatus(deps.redis, deps.logger, def.name, def.handler),
  );
  // Hold the cadence start-to-start when runs are fast; collapse to back-to-back
  // (never overlapping) when a run overruns the period. `failed` re-arms too so
  // a stalled or failed run cannot silently stop the loop.
  //
  // Collapsing is the correct behaviour but it is also indistinguishable from a healthy fast loop: the delay floor absorbs any overrun, however large, and nothing downstream compares a run's duration to its period, which is why the overrun is reported here.
  //
  // The re-arm goes FIRST and the diagnostics run behind it under a catch-all. This function is the only place a self-rescheduling cron enqueues its successor, and the loop is seeded exactly once at boot, so a throw out of a log write or a metrics write ahead of `enqueueNext` would leave that cron silent until the next worker restart. An observability write must never change the cron's outcome.
  const reschedule = (elapsedMs: number): void => {
    enqueueNext(periodMs - elapsedMs);
    if (elapsedMs <= periodMs) return;
    try {
      // Counter first: the sink cannot throw for a catalogued name, so the logger is the only plausible thrower here, and ordering it second means one broken log write cannot take the alert-bearing half of the signal with it.
      deps.metrics?.record('cron_overrun_total', 1, { cron: def.name });
      deps.logger.warn(
        { cron: def.name, periodMs, elapsedMs },
        'cron self-reschedule: run overran its period; next run starts immediately',
      );
    } catch {
      // Nowhere left to escalate: the caller is a BullMQ event listener with no error channel, and the run this describes has already finished, so swallowing costs a diagnostic and nothing else.
    }
  };
  worker.on('completed', (job) => reschedule(elapsedOf(job)));
  // BullMQ emits `failed` on EVERY attempt, then retries the same job up to its
  // retry budget. Re-arm only on the terminal failure, else a retried run
  // double-arms the loop and reintroduces the backlog this design removes.
  const attempts = QUEUE_SPECS[def.queue].attempts;
  worker.on('failed', (job: Job | undefined) => {
    if (!job || job.attemptsMade >= (job.opts.attempts ?? attempts)) reschedule(elapsedOf(job));
  });

  // Seed the loop only when nothing is already pending, so a restart heals a
  // dead loop without double-seeding when a prior run is still in flight.
  const pending =
    (await queue.getActiveCount()) +
    (await queue.getWaitingCount()) +
    (await queue.getDelayedCount());
  if (pending === 0) enqueueNext(0);
  deps.logger.info({ cron: def.name, periodMs }, 'cron self-reschedule registered');
};

/** Run duration from a BullMQ job's processing timestamps; 0 when unavailable. */
const elapsedOf = (job: { processedOn?: number; finishedOn?: number } | undefined): number => {
  if (!job?.processedOn || !job.finishedOn) return 0;
  return Math.max(0, job.finishedOn - job.processedOn);
};

export const registerCrons = async (deps: RegisterCronsDeps): Promise<void> => {
  for (const def of deps.crons) {
    const queue = deps.queueSet.queues[def.queue as keyof typeof deps.queueSet.queues];
    if (!queue) {
      // `CronDef.queue` is typed against `QueueName`, so a typo at the def
      // site is a tsc error. The only realistic trigger for this guard is
      // a queueSet that was constructed without one of the entries from
      // `QUEUE_NAMES` — i.e. a queueSet bug, not a cron-config bug. Loud-
      // fail at boot beats a silently-unscheduled cron.
      throw new Error(
        `registerCrons: queueSet is missing queue "${def.queue}" for cron "${def.name}"`,
      );
    }

    if (def.selfReschedulePeriodMs !== undefined) {
      await registerSelfReschedulingCron(queue, def, deps);
      continue;
    }
    if (def.pattern === undefined) {
      throw new Error(
        `registerCrons: cron "${def.name}" has neither a pattern nor a selfReschedulePeriodMs`,
      );
    }

    await queue.upsertJobScheduler(
      def.name,
      { pattern: def.pattern },
      {
        name: def.name,
        data: {},
        opts: { removeOnComplete: { count: 100 }, removeOnFail: { count: 1_000 } },
      },
    );
    deps.queueSet.registerWorker(
      def.queue as Parameters<QueueSet['registerWorker']>[0],
      withCronStatus(deps.redis, deps.logger, def.name, def.handler),
    );
    deps.logger.info({ cron: def.name, pattern: def.pattern }, 'cron scheduler upserted');
  }
};
