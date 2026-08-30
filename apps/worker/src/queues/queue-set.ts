// Construct the BullMQ Queue + Worker set bound to one ioredis connection.
// The DLQ watcher captures failed jobs from any queue and pushes them onto
// a single dlq queue with a typed payload. Audit-log persistence happens
// in the dlq Worker (see dlq-watcher.ts).

import { Queue, type ConnectionOptions, type Job, type Processor, Worker } from 'bullmq';
import type { Logger } from 'pino';
import { redactDrizzleParamsMessage, redactDrizzleParamsText } from '@app/core/logger';
import { QUEUE_NAMES, QUEUE_SPECS, type QueueName } from './queue-names.js';
import type { DlqJobData } from './job-payloads.js';

export interface QueueSet {
  readonly queues: Readonly<Record<QueueName, Queue>>;
  readonly workers: Worker[];
  enqueueDlq(data: DlqJobData): Promise<void>;
  registerWorker<T = unknown>(
    name: QueueName,
    processor: Processor<T>,
    concurrencyOverride?: number,
  ): Worker<T>;
  closeAll(): Promise<void>;
}

export interface CreateQueueSetOptions {
  readonly connection: ConnectionOptions;
  readonly logger: Logger;
}

// Bounds on the folded cause chain: enough depth to reach the driver-level
// fault (wrapper → app error → pg/redis error), capped so a pathological or
// cyclic chain can neither bloat the persisted record nor the notification.
const MAX_CAUSE_DEPTH = 5;
const MAX_ERROR_MESSAGE_LEN = 600;
// Redact the credentials embedded in a connection URI (e.g. postgres://u:pw@host,
// redis://:pw@host) before the message leaves the process: the DLQ record is
// persisted and the alert egresses to an external Slack channel, and a driver
// error can echo its DSN. Targeted at the `user:password@` segment only, so
// ordinary diagnostic text (the whole point of folding the cause) is untouched.
const CREDENTIAL_URI = /(\/\/[^\s/:@]*:)[^\s/@]+@/g;
// Ceiling on the pre-close handshake wait in closeAll. Sized against the caller's 10s drain deadline: long enough that a healthy connection always settles inside it, short enough that an unreachable Redis leaves the closes their own budget.
const READY_WAIT_MS = 2_000;

/**
 * Folds a bounded `cause` chain into one diagnostic message after redacting each isolated message, so a Drizzle bind tail cannot consume a later driver cause when the parts are joined and a cyclic or pathological chain cannot grow the DLQ record without limit.
 *
 * @param err - The exhausted job error whose wrapper and bounded causes identify the failure.
 * @returns The capped, credential-URI-redacted diagnostic message with Drizzle bind tails censored and useful cause text retained.
 */
export const flattenErrorMessage = (err: Error): string => {
  const parts = [redactDrizzleParamsMessage(err.message)];
  let cause: unknown = (err as { cause?: unknown }).cause;
  for (let depth = 0; cause != null && depth < MAX_CAUSE_DEPTH; depth += 1) {
    const c = cause as { name?: unknown; message?: unknown; cause?: unknown };
    const rawMessage = typeof c.message === 'string' ? c.message : String(cause);
    const msg = redactDrizzleParamsMessage(rawMessage);
    const name = typeof c.name === 'string' && c.name !== 'Error' ? `${c.name}: ` : '';
    parts.push(`${name}${msg}`);
    cause = c.cause;
  }
  const joined = parts.join(' ← caused by: ').replace(CREDENTIAL_URI, '$1[redacted]@');
  return joined.length > MAX_ERROR_MESSAGE_LEN
    ? `${joined.slice(0, MAX_ERROR_MESSAGE_LEN - 1)}…`
    : joined;
};

export const createQueueSet = ({ connection, logger }: CreateQueueSetOptions): QueueSet => {
  const queues = Object.fromEntries(
    Object.values(QUEUE_NAMES).map((name) => [name, new Queue(name, { connection })]),
  ) as Record<QueueName, Queue>;

  const workers: Worker[] = [];

  const enqueueDlq = async (data: DlqJobData): Promise<void> => {
    await queues.dlq.add('dlq', data, {
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 10_000 },
    });
  };

  const registerWorker = <T = unknown>(
    name: QueueName,
    processor: Processor<T>,
    concurrencyOverride?: number,
  ): Worker<T> => {
    const spec = QUEUE_SPECS[name];
    const worker = new Worker<T>(name, processor, {
      connection,
      concurrency: concurrencyOverride ?? spec.concurrency,
      ...(spec.lockDurationMs !== undefined && { lockDuration: spec.lockDurationMs }),
    });
    worker.on('failed', (job: Job | undefined, err: Error) => {
      logger.error(
        {
          queue: name,
          jobId: job?.id,
          attemptsMade: job?.attemptsMade,
          err: err,
        },
        'job failed',
      );
      // Only divert to DLQ when retry budget is exhausted.
      if (job && job.attemptsMade >= (job.opts.attempts ?? spec.attempts)) {
        const userId = extractField(job.data, 'userId');
        const profileId = extractField(job.data, 'profileId');
        const dlqEntry: DlqJobData = {
          fromQueue: name,
          fromJobId: String(job.id ?? 'unknown'),
          reason: 'attempts-exhausted',
          errorName: err.name,
          // Fold the `.cause` chain in so the alert/record names the root fault
          // (e.g. RedisUnavailableError's eval-timeout vs a real connection
          // error), not just the wrapper. Without this the incident is opaque.
          errorMessage: flattenErrorMessage(err),
          originalData: job.data,
          ...(err.stack !== undefined ? { stack: redactDrizzleParamsText(err.stack) } : {}),
          ...(userId !== undefined ? { userId } : {}),
          ...(profileId !== undefined ? { profileId } : {}),
        };
        enqueueDlq(dlqEntry).catch((dlqErr: unknown) => {
          logger.error({ queue: name, jobId: job.id, err: dlqErr }, 'failed to enqueue DLQ entry');
        });
      }
    });
    workers.push(worker);
    return worker;
  };

  const closeAll = async (): Promise<void> => {
    // Let every connection finish handshaking before any of them is closed. BullMQ's RedisConnection.close() awaits its own pending init ONLY when that connection already reached 'ready'; one still mid-handshake is disconnected outright, and ioredis's close handler then flushes the commands the handshake had in flight (the version INFO, the per-queue meta HMSET) by rejecting them with "Connection is closed.". Those rejections carry no `.command`, so they surface with no frame naming their writer and nothing left to await them. Boot opens one connection per queue plus one per registered worker and awaits none of them, so a shutdown close to boot cuts a variable handful mid-flight.
    //
    // Settled rather than awaited for success: a connection whose init genuinely failed must close like any other, not turn shutdown into a throw.
    //
    // Bounded rather than unbounded, because the two shutdowns this has to serve pull in opposite directions. A long-running worker's connections are long since settled, so the wait costs nothing and closes the race above. A worker that took SIGTERM during a Redis outage shortly after boot has connections that never reached 'ready', and ioredis retries a failed handshake indefinitely: waiting on that burns the caller's whole 10s drain deadline and converts an exit that used to be fast and clean into a timed-out one that deliberately skips destructive teardown. The bound buys the first case without paying for the second. 2s is the trade: far above any healthy handshake, and small enough against the 10s budget that the closes themselves still have 8s.
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...workers, ...Object.values(queues)].map((c) => c.waitUntilReady())),
        new Promise<void>((resolve) => {
          readyTimer = setTimeout(resolve, READY_WAIT_MS);
        }),
      ]);
    } finally {
      // Cleared, not unref'd. An unref'd timer does not hold the loop open, so were it ever the last live handle the process would exit with this await unresolved and none of the closes below running; that it cannot be today rests entirely on the caller arming a ref'd drain timer in another file, which is not a property this function should depend on. Clearing also releases the handle the moment the handshakes settle rather than leaving it armed for the full wait after a fast drain.
      if (readyTimer !== undefined) clearTimeout(readyTimer);
    }
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all(Object.values(queues).map((q) => q.close()));
  };

  return { queues, workers, enqueueDlq, registerWorker, closeAll };
};

const extractField = (data: unknown, key: 'userId' | 'profileId'): string | undefined => {
  if (data && typeof data === 'object' && key in data) {
    const v = (data as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
};
