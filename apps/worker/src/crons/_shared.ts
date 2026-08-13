// Shared helpers for cron handlers.

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { GLOBAL_KEYS } from '@app/db';

/** One day in milliseconds — the retention crons' `Date.now() - days * MS_PER_DAY` cutoff. */
export const MS_PER_DAY: number = 24 * 60 * 60 * 1000;

/**
 * Run one retention-prune sweep: delete aged rows, log the count, and (for the
 * two operator-facing sweeps) write a Redis receipt. The single shape the four
 * prune crons share — each supplies only its name, horizon, delete fn, and
 * whether a receipt is written.
 */
export const runRetentionSweep = async (
  logger: Logger,
  name: string,
  isoDate: string,
  retentionDays: number,
  prune: () => Promise<number>,
  receipt?: { redis: Redis; kind: 'action-log-prune' | 'audit-prune'; clock?: { nowMs(): number } },
): Promise<void> => {
  const deleted = await prune();
  logger.info({ isoDate, deleted, retentionDays }, `cron ${name}: retention applied`);
  if (receipt) {
    const ranAtMs = (receipt.clock ?? { nowMs: () => Date.now() }).nowMs();
    await writeRetentionReceipt(receipt.redis, logger, receipt.kind, {
      ranAtMs,
      deleted,
      retentionDays,
    });
  }
};

/**
 * Classify a sweep failure into the closed vocabulary a receipt may carry.
 *
 * The receipt is served by `GET /api/retention-status`, which is reachable
 * without a login on a LIVE_DEMO deployment, and a driver exception names
 * internal hosts, ports and relations. These three phrases are everything the
 * dashboard sentence needs, a timeout told apart from a lost database, and the
 * full exception still reaches the server log where it belongs.
 */
export const describeRetentionFailure = (err: unknown): string => {
  const text = err instanceof Error ? err.message : String(err);
  if (/timeout|timed out|ETIMEDOUT|canceling statement/i.test(text)) return 'the sweep timed out';
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|EPIPE|connection/i.test(text)) {
    return 'the database was unreachable';
  }
  return 'the sweep failed';
};

/**
 * Write one retention-prune receipt to Redis. Best-effort: a Redis-side
 * failure must not fail the cron (the row delete already succeeded), so
 * the helper logs and swallows. The receipt has no TTL — `/api/retention-
 * status` wants to render "last sweep N hours ago" even when N is large.
 */
export const writeRetentionReceipt = async (
  redis: Redis,
  logger: Logger,
  kind: 'action-log-prune' | 'audit-prune',
  receipt: {
    ranAtMs: number;
    deleted: number;
    retentionDays: number | null;
    /**
     * Omitted by a successful sweep. The reader defaults an absent `ok` to true,
     * so a healthy receipt stays the shape it has always been and only a failure
     * has to say so.
     */
    ok?: false;
    error?: string;
    /** Per-rule split, for a sweep applying more than one rule. */
    byRule?: { age: number; ageChunks: number; rowCap: number };
    maxRows?: number | null;
  },
): Promise<void> => {
  try {
    await redis.set(GLOBAL_KEYS.retentionReceipt(kind), JSON.stringify({ kind, ...receipt }));
  } catch (err) {
    logger.warn({ kind, err: err }, 'retention-receipt write failed (cron continues)');
  }
};
