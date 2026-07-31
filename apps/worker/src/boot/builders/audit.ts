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
} from 'audit-shipper/audit-shipper.js';
import { auditEntriesToActionLogs } from 'audit-shipper/audit-to-action-log.js';
import { buildAuditStreamKey } from 'executor/redis-namespace.js';
import type { ProfileManager } from 'profile-manager/profile-manager.js';

import type { StatePersistence } from './state-persistence.js';

export interface AuditDeps {
  readonly db: Database;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly metrics: StatePersistence['metrics'];
  readonly profileManager: ProfileManager;
}

export interface Audit {
  readonly auditShipper: ReturnType<typeof createAuditShipper>;
  readonly auditDrainerRedis: Redis;
  readonly auditDrainer: AuditDrainer;
}

export const buildAudit = ({ db, redis, logger, metrics, profileManager }: AuditDeps): Audit => {
  const auditShipper = createAuditShipper({ redis, logger });

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
    persistBatch: (rows) => repo.actionLogs.insertMany(db, auditEntriesToActionLogs(rows)),
    enabledStreams: async () =>
      profileManager.listActive().map((p) => buildAuditStreamKey(p.accountId, p.profileId)),
  });

  return { auditShipper, auditDrainerRedis, auditDrainer };
};
