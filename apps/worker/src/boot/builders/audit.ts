// Audit shipper (producer) and the audit-stream drainer (consumer).
//
// `auditShipper` is PRIVATE — the tick handler writes through it. The drainer
// copies the per-tick audit stream into `action_logs` on its OWN Redis
// connection: a blocking XREADGROUP on the shared socket would stall every other
// consumer until it returns.

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import { repo, type Database } from '@app/db';

import {
  createAuditShipper,
  createAuditDrainer,
  type AuditDrainer,
  type AuditEntry,
} from 'audit-shipper/audit-shipper.js';
import { auditEntriesToActionLogs } from 'audit-shipper/audit-to-action-log.js';
import {
  createRetentionSettingsCache,
  type RetentionSettingsCache,
} from 'lib/retention-settings.js';
import { buildAuditStreamKey } from 'executor/redis-namespace.js';
import type { ProfileManager } from 'profile-manager/profile-manager.js';

import type { MetricsSink } from 'metrics/catalog.js';

/**
 * Pull the SQLSTATE out of a rejected query. drizzle wraps every query error in
 * a `DrizzleQueryError` and hangs the driver's error off `cause`, so the code is
 * never on the error handed to the caller. Walks a bounded chain rather than
 * reaching two levels down, which would break on a driver that nests deeper.
 */
const sqlState = (err: unknown): string | undefined => {
  for (let e: unknown = err, hops = 0; e != null && hops < 5; hops++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
};

/**
 * Whether Postgres refused the ROW, as opposed to refusing to talk. Class 22
 * (data exception) and class 23 (integrity constraint violation) are properties
 * of the values, so the same row fails identically forever. Everything else —
 * class 08 connection, 40 rollback, 53 resources, 57 operator intervention —
 * fails one statement and accepts the next, so retrying eventually lands it.
 * An unrecognised code returns false: the drainer drops on true, so anything we
 * cannot classify must keep its place in the pending list.
 */
export const isUnpersistableRow = (err: unknown): boolean => {
  const code = sqlState(err);
  return code !== undefined && (code.startsWith('22') || code.startsWith('23'));
};

/**
 * Map audit entries to `action_logs` rows and write them, resolving with the
 * number of rows Postgres actually inserted. Exported because it is the
 * whole production half of the poison gate: the drainer treats a non-zero
 * return as proof Postgres accepted something, and the rewrap below is what
 * keeps a failed INSERT out of the logs.
 */
export const auditPersistBatch =
  (db: Database, settings?: RetentionSettingsCache) =>
  async (rows: readonly AuditEntry[]): Promise<number> => {
    // Which profile (if any) is under deep capture is read per pass, not per
    // boot, so arming it from the UI takes effect without a worker restart. A
    // cache miss yields capture-off, so the expensive mode fails closed.
    const policy = settings
      ? { debugCaptureProfileId: (await settings.get()).debugCaptureProfileId }
      : { debugCaptureProfileId: null };
    // Report the inserted row count, not the input or mapped count. Replayed
    // tick ids conflict with rows already stored, so only the RETURNING count
    // proves Postgres accepted something new.
    const inserts = auditEntriesToActionLogs(rows, policy);
    try {
      return await repo.actionLogs.insertMany(db, inserts);
    } catch (err) {
      // drizzle's wrapper carries the whole INSERT and every bound parameter in
      // its own MESSAGE, and pino folds a cause's message into the log line. So
      // the wrapper must never be reachable from what we throw — not even as a
      // fallback cause. Only its driver error goes on, which names the column
      // and constraint without echoing a single bound value.
      const code = sqlState(err);
      const wrapped = new Error(`action_logs insert failed: sqlstate ${code ?? 'unknown'}`, {
        cause: err instanceof Error ? err.cause : undefined,
      });
      // Stamped rather than left to the cause walk: dropping the drizzle wrapper
      // can also drop the only link holding the SQLSTATE, and a code the gate
      // cannot read fails closed into a row that is never retried out.
      if (code !== undefined) (wrapped as { code?: string }).code = code;
      throw wrapped;
    }
  };

export interface AuditDeps {
  readonly db: Database;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly metrics: MetricsSink;
  readonly profileManager: ProfileManager;
}

export interface Audit {
  readonly auditShipper: ReturnType<typeof createAuditShipper>;
  readonly auditDrainerRedis: Redis;
  readonly auditDrainer: AuditDrainer;
}

export const buildAudit = ({ db, redis, logger, metrics, profileManager }: AuditDeps): Audit => {
  // One cached read shared by both halves: the shipper needs the trim length on
  // every XADD and the drainer needs the capture flag on every pass, and neither
  // can afford a query at that rate.
  const settings = createRetentionSettingsCache({ db, logger });
  const auditShipper = createAuditShipper({
    redis,
    logger,
    maxlen: async () => (await settings.get()).auditStreamMaxlen,
  });

  // Actionable-only policy (orders / technicals vetoes) keeps noop ticks out of
  // the feed. Started as a background loop in index.ts and stopped on shutdown.
  // Blocking XREADGROUP must run on its own connection: on the shared socket a
  // 1s BLOCK stalls every other consumer (weight governor, snapshot store) until
  // it returns, tripping their command timeouts. Mirrors BullMQ's dedicated
  // connection.
  const auditDrainerRedis = redis.duplicate();
  const auditDrainer = createAuditDrainer({
    redis: auditDrainerRedis,
    logger,
    metrics,
    persistBatch: auditPersistBatch(db, settings),
    isUnpersistableRow,
    enabledStreams: async () =>
      profileManager.listActive().map((p) => buildAuditStreamKey(p.accountId, p.profileId)),
  });

  return { auditShipper, auditDrainerRedis, auditDrainer };
};
