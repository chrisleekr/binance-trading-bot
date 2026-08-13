import type { Logger } from 'pino';
import type { Queue } from 'bullmq';

import type { MetricsSink } from 'metrics/catalog.js';

// Same cadence as the worker heartbeat. Both are "is this process healthy"
// samples, and a queue that has been backed up for less than a minute is a
// queue doing its job.
const SAMPLE_INTERVAL_MS = 60_000;

/**
 * The slice of `pg.Pool` this sampler reads. Declared structurally rather than
 * importing the type so the sampler can be driven by a plain object in a test
 * without standing up a database.
 */
export interface PoolCounters {
  readonly idleCount: number;
  readonly totalCount: number;
  readonly waitingCount: number;
}

export interface RuntimeGaugeDeps {
  readonly queues: Readonly<Record<string, Pick<Queue, 'getWaitingCount'>>>;
  readonly pool: PoolCounters;
  readonly metrics: MetricsSink;
  readonly logger: Logger;
}

/**
 * Export the two runtime pressures the worker is otherwise blind to: BullMQ
 * queue depth and Postgres pool saturation.
 *
 * Both present to an operator as "ticks are late" and call for opposite
 * responses — scale the consumer, or widen the pool — so each gets its own
 * series, and the queue depth is labelled per queue because a stuck pipeline
 * queue and a stuck tick queue are different incidents.
 *
 * An in-process interval rather than a repeatable BullMQ job: a cron job would
 * add jobs to the very queue whose depth it measures, so the measurement would
 * move the reading. The timer is `unref`'d and returned so the shutdown path
 * clears it alongside the heartbeat timers.
 *
 * `getWaitingCount()` is a plain Redis read of the queue's own list length —
 * no owner, no lease, no release or refund — so nothing here is a distributed
 * lock and the no-locks invariant is untouched. That matters twice over: a
 * sampler that had to take a lock could block the thing it is measuring
 * precisely when that thing is already in trouble.
 *
 * Sampling is best-effort. A failed read logs and leaves the gauge at its last
 * value; a monitoring sampler must never be able to take the worker down.
 */
export const startRuntimeGauges = async (
  deps: RuntimeGaugeDeps,
): Promise<ReturnType<typeof setInterval>[]> => {
  const { queues, pool, metrics, logger } = deps;

  const sample = async (): Promise<void> => {
    for (const [name, queue] of Object.entries(queues)) {
      try {
        metrics.record('bullmq_queue_wait_jobs', await queue.getWaitingCount(), { queue: name });
      } catch (err) {
        logger.warn({ err, queue: name }, 'runtime gauge: queue depth sample failed');
      }
    }
    // Read off the live pool object each pass, not captured at boot: the counts
    // are getters over its current connection list.
    metrics.record('pg_pool_idle', pool.idleCount);
    metrics.record('pg_pool_total', pool.totalCount);
    metrics.record('pg_pool_waiting', pool.waitingCount);
  };

  // Sample once at boot so the series exist before the first interval elapses.
  // A gauge that appears a minute after start is a gauge missing from exactly
  // the window a crash-loop lives in.
  //
  // Caught for the same reason the interval below is: this call is awaited by
  // the worker's startup path, so an unguarded throw here is the one failure
  // mode a monitoring sampler must not have — the process refusing to trade
  // because it could not write a gauge about itself.
  await sample().catch((err: unknown) => {
    logger.warn({ err }, 'runtime gauge: boot sample failed');
  });

  const timer = setInterval(() => {
    // The interval discards the promise, so the catch belongs here rather than
    // around today's three pool writes: an unhandled rejection ends the process,
    // and the guarantee above is that a sampler cannot take the worker down.
    void sample().catch((err: unknown) => {
      logger.warn({ err }, 'runtime gauge: sample pass failed');
    });
  }, SAMPLE_INTERVAL_MS);
  timer.unref();
  return [timer];
};
