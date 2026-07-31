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
 * Write one retention-prune receipt to Redis. Best-effort: a Redis-side
 * failure must not fail the cron (the row delete already succeeded), so
 * the helper logs and swallows. The receipt has no TTL — `/api/retention-
 * status` wants to render "last sweep N hours ago" even when N is large.
 */
export const writeRetentionReceipt = async (
  redis: Redis,
  logger: Logger,
  kind: 'action-log-prune' | 'audit-prune',
  receipt: { ranAtMs: number; deleted: number; retentionDays: number },
): Promise<void> => {
  try {
    await redis.set(GLOBAL_KEYS.retentionReceipt(kind), JSON.stringify({ kind, ...receipt }));
  } catch (err) {
    logger.warn({ kind, err: err }, 'retention-receipt write failed (cron continues)');
  }
};
