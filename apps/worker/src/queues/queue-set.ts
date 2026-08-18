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
