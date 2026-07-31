// Locks the action-log-prune + audit-prune handler shapes that the
// worker boot wires up. The handlers themselves are tiny (one repo
// call + one log line) but the wiring is what was broken in this
// cycle's issue: the factories existed but were never instantiated,
// and the retention env vars had no consumer. These tests assert
// (a) the factories propagate `retentionDays` to the injected pruner,
// (b) the deleted-row count lands in the log payload, and (c) pruner
// errors bubble so BullMQ's `attempts: 3` retries the cron tick (the
// alternative — silent ack — would lose the retention sweep without
// a DLQ entry).

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import { actionLogPruneHandler } from '../../src/crons/action-log-prune.cron.js';
import { auditPruneHandler } from '../../src/crons/audit-prune.cron.js';
import { discoverySnapshotPruneHandler } from '../../src/crons/discovery-snapshot-prune.cron.js';
import { equitySnapshotPruneHandler } from '../../src/crons/equity-snapshot-prune.cron.js';
import type {
  ActionLogPruneJobData,
  AuditPruneJobData,
  DiscoverySnapshotPruneJobData,
  EquitySnapshotPruneJobData,
} from '../../src/queues/job-payloads.js';

// Minimal Redis stub: the handlers only call `.set(key, value)`. Returning a
// real `Redis` typed value would force a testcontainers dependency; the
// stub instead records the call args so tests can assert receipt content.
const stubRedis = (): { redis: Redis; sets: { key: string; value: string }[] } => {
  const sets: { key: string; value: string }[] = [];
  const redis = {
    set: vi.fn(async (key: string, value: string) => {
      sets.push({ key, value });
      return 'OK';
    }),
  } as unknown as Redis;
  return { redis, sets };
};

const captureLogger = (): { logger: Logger; entries: { msg: string; ctx: unknown }[] } => {
  const entries: { msg: string; ctx: unknown }[] = [];
  const logger = {
    info: (ctx: unknown, msg: string) => entries.push({ ctx, msg }),
    warn: (ctx: unknown, msg: string) => entries.push({ ctx, msg }),
    error: (ctx: unknown, msg: string) => entries.push({ ctx, msg }),
    debug: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
    child() {
      return this;
    },
  } as unknown as Logger;
  return { logger, entries };
};

describe('actionLogPruneHandler', () => {
  it('invokes the injected pruner and logs the deleted-row count', async () => {
    const { logger, entries } = captureLogger();
    const { redis } = stubRedis();
    const prune = vi.fn(async () => 17);
    const handler = actionLogPruneHandler({
      logger,
      redis,
      retentionDays: 30,
      prune,
    });
    await handler({
      data: { isoDate: '2026-05-14' } as ActionLogPruneJobData,
    } as Job<ActionLogPruneJobData>);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.msg).toMatch(/action-log-prune/);
    expect(entries[0]?.ctx).toMatchObject({
      isoDate: '2026-05-14',
      deleted: 17,
      retentionDays: 30,
    });
  });

  it('writes a retention receipt to Redis on each successful run', async () => {
    const { logger } = captureLogger();
    const { redis, sets } = stubRedis();
    const handler = actionLogPruneHandler({
      logger,
      redis,
      retentionDays: 30,
      clock: { nowMs: () => 1_715_000_000_000 },
      prune: async () => 7,
    });
    await handler({
      data: { isoDate: '2026-05-14' } as ActionLogPruneJobData,
    } as Job<ActionLogPruneJobData>);
    expect(sets).toHaveLength(1);
    expect(sets[0]?.key).toBe('retention:receipt:action-log-prune');
    expect(JSON.parse(sets[0]?.value ?? '{}')).toEqual({
      kind: 'action-log-prune',
      ranAtMs: 1_715_000_000_000,
      deleted: 7,
      retentionDays: 30,
    });
  });

  it('lets pruner errors bubble so BullMQ retries the cron tick', async () => {
    const { logger } = captureLogger();
    const { redis } = stubRedis();
    const prune = vi.fn(async () => {
      throw new Error('db timeout');
    });
    const handler = actionLogPruneHandler({
      logger,
      redis,
      retentionDays: 30,
      prune,
    });
    await expect(
      handler({
        data: { isoDate: '2026-05-14' } as ActionLogPruneJobData,
      } as Job<ActionLogPruneJobData>),
    ).rejects.toThrow(/db timeout/);
  });
});

describe('auditPruneHandler', () => {
  it('propagates retentionDays to the injected pruner and logs the receipt', async () => {
    const { logger, entries } = captureLogger();
    const pruneOlderThan = vi.fn(async (_days: number) => 42);
    const { redis, sets } = stubRedis();
    const handler = auditPruneHandler({
      logger,
      redis,
      retentionDays: 90,
      clock: { nowMs: () => 1_715_000_000_000 },
      pruneOlderThan,
    });
    await handler({
      data: { isoDate: '2026-05-14' } as AuditPruneJobData,
    } as Job<AuditPruneJobData>);
    expect(pruneOlderThan).toHaveBeenCalledWith(90);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.msg).toMatch(/audit-prune/);
    expect(entries[0]?.ctx).toMatchObject({ retentionDays: 90, deleted: 42 });
    expect(sets).toHaveLength(1);
    expect(sets[0]?.key).toBe('retention:receipt:audit-prune');
    expect(JSON.parse(sets[0]?.value ?? '{}')).toEqual({
      kind: 'audit-prune',
      ranAtMs: 1_715_000_000_000,
      deleted: 42,
      retentionDays: 90,
    });
  });

  it('lets pruner errors bubble so BullMQ retries the cron tick', async () => {
    const { logger } = captureLogger();
    const { redis } = stubRedis();
    const pruneOlderThan = vi.fn(async () => {
      throw new Error('connection reset');
    });
    const handler = auditPruneHandler({
      logger,
      redis,
      retentionDays: 90,
      pruneOlderThan,
    });
    await expect(
      handler({ data: { isoDate: '2026-05-14' } as AuditPruneJobData } as Job<AuditPruneJobData>),
    ).rejects.toThrow(/connection reset/);
  });
});

describe('discoverySnapshotPruneHandler', () => {
  it('invokes the injected pruner and logs the deleted-row count', async () => {
    const { logger, entries } = captureLogger();
    const prune = vi.fn(async () => 5);
    const handler = discoverySnapshotPruneHandler({ logger, retentionDays: 180, prune });
    await handler({
      data: { isoDate: '2026-06-10' } as DiscoverySnapshotPruneJobData,
    } as Job<DiscoverySnapshotPruneJobData>);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.msg).toMatch(/discovery-snapshot-prune/);
    expect(entries[0]?.ctx).toMatchObject({
      isoDate: '2026-06-10',
      deleted: 5,
      retentionDays: 180,
    });
  });

  it('lets pruner errors bubble so BullMQ retries the cron tick', async () => {
    const { logger } = captureLogger();
    const prune = vi.fn(async () => {
      throw new Error('db timeout');
    });
    const handler = discoverySnapshotPruneHandler({ logger, retentionDays: 180, prune });
    await expect(
      handler({
        data: { isoDate: '2026-06-10' } as DiscoverySnapshotPruneJobData,
      } as Job<DiscoverySnapshotPruneJobData>),
    ).rejects.toThrow(/db timeout/);
  });
});

describe('equitySnapshotPruneHandler', () => {
  it('invokes the injected pruner and logs the deleted-row count', async () => {
    const { logger, entries } = captureLogger();
    const prune = vi.fn(async () => 8);
    const handler = equitySnapshotPruneHandler({ logger, retentionDays: 365, prune });
    await handler({
      data: { isoDate: '2026-06-10' } as EquitySnapshotPruneJobData,
    } as Job<EquitySnapshotPruneJobData>);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.msg).toMatch(/equity-snapshot-prune/);
    expect(entries[0]?.ctx).toMatchObject({
      isoDate: '2026-06-10',
      deleted: 8,
      retentionDays: 365,
    });
  });

  it('lets pruner errors bubble so BullMQ retries the cron tick', async () => {
    const { logger } = captureLogger();
    const prune = vi.fn(async () => {
      throw new Error('db timeout');
    });
    const handler = equitySnapshotPruneHandler({ logger, retentionDays: 365, prune });
    await expect(
      handler({
        data: { isoDate: '2026-06-10' } as EquitySnapshotPruneJobData,
      } as Job<EquitySnapshotPruneJobData>),
    ).rejects.toThrow(/db timeout/);
  });
});
