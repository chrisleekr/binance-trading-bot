// Cron-status recorder. Wraps every cron handler so each run records its
// terminal outcome (ok / error), timestamp, and duration to a single Redis hash
// (field = cron name). The /api/worker/crons endpoint reads it so the operator
// can see which crons last ran and whether they failed — the single-replica
// worker's self-rescheduling crons are otherwise invisible until a downstream
// screen goes empty.
//
// Contract: the status write must NEVER change the cron's own outcome. A write
// failure is logged and swallowed; a handler error is recorded then RE-THROWN
// unchanged, so BullMQ's retry and the self-reschedule loop see the real result.

import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { GLOBAL_KEYS } from '@app/db';
import type { CronName } from './define.js';

/** One cron's last-run record, serialised as a `worker:cron-status` hash field. */
export interface CronStatusRecord {
  readonly lastRunAtMs: number;
  readonly status: 'ok' | 'error';
  readonly durationMs: number;
  /** Failure message on `status: 'error'`, else absent. */
  readonly error?: string;
}

const MAX_ERROR_LEN = 300;

/**
 * Sanitise a cron error before it is recorded and shown to the operator. The
 * raw `err.message` can carry infra detail — most notably the `db-backup` cron,
 * which shells out to `pg_dump` with the `DATABASE_URL` (password inline) and
 * touches absolute backup paths. Redact any embedded postgres credentials and
 * absolute filesystem paths, and bound the length, so a privileged subprocess's
 * raw error can't leak internals (or a future secret) into the UI. One chokepoint
 * covers every cron.
 */
export const sanitizeCronError = (raw: string): string => {
  let s = raw
    // postgres://user:pass@host -> postgres://***@host
    .replace(/(postgres(?:ql)?:\/\/)[^@\s]*@/gi, '$1***@')
    // absolute unix paths -> <path>
    .replace(/(?:\/[^\s:()]+){2,}/g, '<path>');
  if (s.length > MAX_ERROR_LEN) s = `${s.slice(0, MAX_ERROR_LEN)}…`;
  return s;
};

const write = async (
  redis: Redis,
  logger: Logger,
  name: CronName,
  record: CronStatusRecord,
): Promise<void> => {
  try {
    await redis.hset(GLOBAL_KEYS.cronStatus(), name, JSON.stringify(record));
  } catch (err: unknown) {
    // A status-write failure must not fail an otherwise-healthy cron.
    logger.warn({ cron: name, err: err }, 'cron-status: failed to record run');
  }
};

/**
 * Wrap a cron handler so its terminal outcome lands in the cron-status hash.
 * Records on both success and failure; rethrows the original error so the
 * caller's retry/reschedule logic is unchanged.
 */
export const withCronStatus =
  (redis: Redis, logger: Logger, name: CronName, handler: (job: Job) => Promise<void>) =>
  async (job: Job): Promise<void> => {
    const start = Date.now();
    try {
      await handler(job);
      await write(redis, logger, name, {
        lastRunAtMs: Date.now(),
        status: 'ok',
        durationMs: Date.now() - start,
      });
    } catch (err: unknown) {
      await write(redis, logger, name, {
        lastRunAtMs: Date.now(),
        status: 'error',
        durationMs: Date.now() - start,
        error: sanitizeCronError(err instanceof Error ? err.message : String(err)),
      });
      throw err;
    }
  };
