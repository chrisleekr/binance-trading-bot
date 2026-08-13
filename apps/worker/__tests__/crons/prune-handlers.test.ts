// Locks the action-log-prune + audit-prune handler shapes that the
// worker boot wires up. The handlers themselves are tiny (one repo
// call + one log line) but the wiring is what was broken in this
// cycle's issue: the factories existed but were never instantiated,
// and the retention env vars had no consumer. These tests assert
// (a) the factories propagate the resolved horizon to the injected pruner,
// (b) the deleted-row count lands in the log payload, and (c) pruner
// errors bubble so BullMQ's `attempts: 3` retries the cron tick (the
// alternative — silent ack — would lose the retention sweep without
// a DLQ entry).
//
// The log-table limits now come from `retention_config`, resolved per run. The
// per-run call is the point: it is what makes a UI change take effect on the
// next sweep rather than the next restart, so the tests assert it is invoked,
// not just that its value is used.
//
// action-log-prune applies two rules, an age horizon and a per-profile row cap,
// and reports them as separate counts. That separation is asserted directly: one
// combined number cannot tell a quiet night from a mis-set cap deleting a
// profile's whole history.

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

// Same capture as `captureLogger`, but keeps the level. A failure has to be
// distinguishable from the info chatter of a healthy sweep, so the tests that
// assert an operator-visible failure signal need the level, not just the text.
const leveledLogger = (): {
  logger: Logger;
  entries: { level: string; msg: string; ctx: unknown }[];
} => {
  const entries: { level: string; msg: string; ctx: unknown }[] = [];
  const at =
    (level: string) =>
    (ctx: unknown, msg: string): void => {
      entries.push({ level, ctx, msg });
    };
  const logger = {
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    debug: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
    child() {
      return this;
    },
  } as unknown as Logger;
  return { logger, entries };
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
  const deps = (
    over: Partial<Parameters<typeof actionLogPruneHandler>[0]> = {},
  ): Parameters<typeof actionLogPruneHandler>[0] => ({
    logger: captureLogger().logger,
    redis: stubRedis().redis,
    resolveLimits: async () => ({ retentionDays: 30, maxRows: 200_000 }),
    pruneByAge: async () => ({ chunksDropped: 0, rowsDeleted: 0 }),
    listProfileIds: async () => [],
    pruneByRowCap: async () => 0,
    ...over,
  });

  const run = async (
    handler: ReturnType<typeof actionLogPruneHandler>,
    isoDate = '2026-05-14',
  ): Promise<void> =>
    handler({ data: { isoDate } as ActionLogPruneJobData } as Job<ActionLogPruneJobData>);

  it('invokes the injected pruner and logs the deleted-row count', async () => {
    const { logger, entries } = captureLogger();
    const pruneByAge = vi.fn(async (_days: number) => ({ chunksDropped: 2, rowsDeleted: 17 }));
    const resolveLimits = vi.fn(async () => ({ retentionDays: 30, maxRows: 200_000 }));
    await run(actionLogPruneHandler(deps({ logger, pruneByAge, resolveLimits })));

    expect(resolveLimits).toHaveBeenCalledTimes(1);
    expect(pruneByAge).toHaveBeenCalledWith(30);
    expect(entries[0]?.ctx).toMatchObject({
      isoDate: '2026-05-14',
      rule: 'age',
      deleted: 17,
      chunksDropped: 2,
      retentionDays: 30,
    });
  });

  it('re-reads both limits on every run so a UI change lands without a restart', async () => {
    const { redis, sets } = stubRedis();
    const resolveLimits = vi
      .fn()
      .mockResolvedValueOnce({ retentionDays: 30, maxRows: 200_000 })
      .mockResolvedValueOnce({ retentionDays: 3, maxRows: 5_000 });
    const pruneByAge = vi.fn(async (_days: number) => ({ chunksDropped: 0, rowsDeleted: 0 }));
    const handler = actionLogPruneHandler(deps({ redis, resolveLimits, pruneByAge }));
    await run(handler);
    await run(handler);

    expect(pruneByAge.mock.calls.map(([days]) => days)).toEqual([30, 3]);
    expect(
      sets.map((s) => (JSON.parse(s.value) as { retentionDays: number }).retentionDays),
    ).toEqual([30, 3]);
    expect(sets.map((s) => (JSON.parse(s.value) as { maxRows: number }).maxRows)).toEqual([
      200_000, 5_000,
    ]);
  });

  it('reports the age sweep and the row cap as separate counts, never one total', async () => {
    // The failure this guards: a horizon deleting nothing while a mis-set cap
    // deletes a profile's whole history reads as a healthy 900-row night if the
    // two are summed. The receipt has to be able to say which rule did it.
    const { redis, sets } = stubRedis();
    await run(
      actionLogPruneHandler(
        deps({
          redis,
          clock: { nowMs: () => 1_715_000_000_000 },
          resolveLimits: async () => ({ retentionDays: 1, maxRows: 1_000 }),
          pruneByAge: async () => ({ chunksDropped: 0, rowsDeleted: 0 }),
          listProfileIds: async () => ['p1'],
          pruneByRowCap: async () => 900,
        }),
      ),
    );

    expect(JSON.parse(sets[0]?.value ?? '{}')).toEqual({
      kind: 'action-log-prune',
      ranAtMs: 1_715_000_000_000,
      deleted: 900,
      retentionDays: 1,
      maxRows: 1_000,
      byRule: { age: 0, ageChunks: 0, rowCap: 900 },
    });
  });

  it('counts dropped chunks, so a sweep that discarded a month is not read as a quiet night', async () => {
    // The age rule unlinks whole expired chunks without reading their rows, so
    // its row count is near zero however much history it discarded. A receipt
    // carrying only rows would report the biggest sweep of the year as "4
    // pruned" — a signal that cannot move.
    const { redis, sets } = stubRedis();
    await run(
      actionLogPruneHandler(
        deps({
          redis,
          clock: { nowMs: () => 1_715_000_000_000 },
          resolveLimits: async () => ({ retentionDays: 7, maxRows: 1_000 }),
          pruneByAge: async () => ({ chunksDropped: 31, rowsDeleted: 4 }),
        }),
      ),
    );

    expect(JSON.parse(sets[0]?.value ?? '{}')).toMatchObject({
      deleted: 4,
      byRule: { age: 4, ageChunks: 31, rowCap: 0 },
    });
  });

  it('applies the cap to every profile separately, disabled ones included', async () => {
    // A table-wide cap lets the noisy profile evict the quiet one. The contract
    // is that each profile is trimmed against its own budget.
    const pruneByRowCap = vi.fn(async (profileId: string) => (profileId === 'noisy' ? 5_000 : 0));
    const { logger, entries } = captureLogger();
    await run(
      actionLogPruneHandler(
        deps({
          logger,
          resolveLimits: async () => ({ retentionDays: 7, maxRows: 1_000 }),
          listProfileIds: async () => ['noisy', 'quiet'],
          pruneByRowCap,
        }),
      ),
    );

    expect(pruneByRowCap.mock.calls).toEqual([
      ['noisy', 1_000],
      ['quiet', 1_000],
    ]);
    // Only the profile that was actually trimmed is named; a per-profile line
    // for every untouched profile would bury the one that mattered.
    const perProfile = entries.filter((e) => /trimmed to row cap/.test(e.msg));
    expect(perProfile).toHaveLength(1);
    expect(perProfile[0]?.ctx).toMatchObject({ profileId: 'noisy', deleted: 5_000 });
  });

  it('lets pruner errors bubble so BullMQ retries the cron tick', async () => {
    const pruneByAge = vi.fn(async (): Promise<never> => {
      throw new Error('db timeout');
    });
    await expect(run(actionLogPruneHandler(deps({ pruneByAge })))).rejects.toThrow(/db timeout/);
  });

  it('lets a row-cap error bubble too, rather than acking a half-applied sweep', async () => {
    const pruneByRowCap = vi.fn(async () => {
      throw new Error('statement timeout');
    });
    await expect(
      run(actionLogPruneHandler(deps({ listProfileIds: async () => ['p1'], pruneByRowCap }))),
    ).rejects.toThrow(/statement timeout/);
  });

  // A throw reaches the DLQ, which nothing in the operator's UI reads. The
  // retention receipt is the only surface that answers "did retention run?", so a
  // sweep that dies leaving the last success receipt in place reports a healthy
  // horizon for as long as the failure persists — which is how a stalling sweep
  // ran unnoticed while rows accumulated past their configured horizon.
  describe('failure is visible, not just thrown', () => {
    // The receipt's `error` is a classification, never the driver's own text:
    // `GET /api/retention-status` is readable without a login under LIVE_DEMO and
    // a Postgres exception names internal hosts, ports and relations. Each case
    // therefore throws a realistic driver message and asserts both that the
    // classification is right and that none of the raw text survives into it.
    const failing = [
      {
        rule: 'age',
        message: 'connect ECONNREFUSED 10.0.4.7:5432',
        classified: 'the database was unreachable',
        over: {
          pruneByAge: async (): Promise<never> => {
            throw new Error('connect ECONNREFUSED 10.0.4.7:5432');
          },
        },
      },
      {
        rule: 'row cap',
        message: 'canceling statement due to statement timeout',
        classified: 'the sweep timed out',
        over: {
          listProfileIds: async (): Promise<string[]> => ['p1'],
          pruneByRowCap: async (): Promise<number> => {
            throw new Error('canceling statement due to statement timeout');
          },
        },
      },
    ] as const;

    it.each(failing)('writes a failure receipt and logs an error when $rule throws', async (c) => {
      const { logger, entries } = leveledLogger();
      const { redis, sets } = stubRedis();
      await expect(
        run(
          actionLogPruneHandler(
            deps({ logger, redis, clock: { nowMs: () => 1_715_000_000_000 }, ...c.over }),
          ),
        ),
      ).rejects.toThrow(c.message);

      expect(sets).toHaveLength(1);
      expect(sets[0]?.key).toBe('retention:receipt:action-log-prune');
      expect(JSON.parse(sets[0]?.value ?? '{}')).toMatchObject({
        kind: 'action-log-prune',
        ok: false,
        ranAtMs: 1_715_000_000_000,
        error: c.classified,
      });
      expect(sets[0]?.value ?? '').not.toContain(c.message);
      // The full exception belongs in the log, which is not an anonymous surface.
      const errors = entries.filter((e) => e.level === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.ctx).toMatchObject({
        err: expect.objectContaining({ message: c.message }),
      });
    });

    it('reports the work the failed run had already done, not a blank receipt', async () => {
      // A sweep that dropped 12 chunks and then timed out on the row cap did
      // real work; reporting zero would send the operator looking for a sweep
      // that never started instead of a cap query that cannot finish.
      const { logger } = leveledLogger();
      const { redis, sets } = stubRedis();
      await expect(
        run(
          actionLogPruneHandler(
            deps({
              logger,
              redis,
              resolveLimits: async () => ({ retentionDays: 7, maxRows: 1_000 }),
              pruneByAge: async () => ({ chunksDropped: 12, rowsDeleted: 40 }),
              listProfileIds: async () => ['p1'],
              pruneByRowCap: async () => {
                throw new Error('statement timeout');
              },
            }),
          ),
        ),
      ).rejects.toThrow(/statement timeout/);

      expect(JSON.parse(sets[0]?.value ?? '{}')).toMatchObject({
        ok: false,
        deleted: 40,
        retentionDays: 7,
        maxRows: 1_000,
        byRule: { age: 40, ageChunks: 12, rowCap: 0 },
      });
    });

    it('still writes a receipt when the run dies before it can read its limits', async () => {
      // The horizon is unknown here, so the receipt reports it as null rather
      // than echoing a default the sweep never applied.
      const { logger } = leveledLogger();
      const { redis, sets } = stubRedis();
      await expect(
        run(
          actionLogPruneHandler(
            deps({
              logger,
              redis,
              resolveLimits: async () => {
                throw new Error('retention_config unreachable');
              },
            }),
          ),
        ),
      ).rejects.toThrow(/retention_config unreachable/);

      expect(JSON.parse(sets[0]?.value ?? '{}')).toMatchObject({
        ok: false,
        error: 'the sweep failed',
        deleted: 0,
        retentionDays: null,
        maxRows: null,
      });
    });
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
      resolveRetentionDays: async () => 90,
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
      resolveRetentionDays: async () => 90,
      pruneOlderThan,
    });
    await expect(
      handler({ data: { isoDate: '2026-05-14' } as AuditPruneJobData } as Job<AuditPruneJobData>),
    ).rejects.toThrow(/connection reset/);
  });

  // The throw above reaches only the DLQ, which no operator surface reads. The
  // audit panel's footer renders `ok: false` in the danger colour, so without a
  // failure receipt that branch can never fire in production and a sweep that
  // stopped running keeps reading as healthy off its last success.
  describe('failure is visible, not just thrown', () => {
    const failedRun = async (
      over: Partial<Parameters<typeof auditPruneHandler>[0]>,
    ): Promise<{
      sets: { key: string; value: string }[];
      entries: { level: string; msg: string; ctx: unknown }[];
      message: string;
    }> => {
      const { logger, entries } = leveledLogger();
      const { redis, sets } = stubRedis();
      const message = 'connect ECONNREFUSED 10.0.4.7:5432';
      const handler = auditPruneHandler({
        logger,
        redis,
        clock: { nowMs: () => 1_715_000_000_000 },
        resolveRetentionDays: async () => 90,
        pruneOlderThan: async (): Promise<number> => {
          throw new Error(message);
        },
        ...over,
      });
      await expect(
        handler({ data: { isoDate: '2026-05-14' } as AuditPruneJobData } as Job<AuditPruneJobData>),
      ).rejects.toThrow(message);
      return { sets, entries, message };
    };

    it('writes a failure receipt and logs an error when the sweep throws', async () => {
      const { sets, entries, message } = await failedRun({});

      expect(sets).toHaveLength(1);
      expect(sets[0]?.key).toBe('retention:receipt:audit-prune');
      expect(JSON.parse(sets[0]?.value ?? '{}')).toEqual({
        kind: 'audit-prune',
        ranAtMs: 1_715_000_000_000,
        ok: false,
        // Classified, never the driver's text: this string is served on a route
        // an anonymous visitor can read under LIVE_DEMO.
        error: 'the database was unreachable',
        deleted: 0,
        retentionDays: 90,
      });
      expect(sets[0]?.value ?? '').not.toContain('10.0.4.7');
      const errors = entries.filter((e) => e.level === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.ctx).toMatchObject({ err: expect.objectContaining({ message }) });
    });

    it('reports a null horizon when the run died before it could read one', async () => {
      const { sets } = await failedRun({
        resolveRetentionDays: async (): Promise<number> => {
          throw new Error('connect ECONNREFUSED 10.0.4.7:5432');
        },
      });

      expect(JSON.parse(sets[0]?.value ?? '{}')).toMatchObject({
        ok: false,
        retentionDays: null,
        deleted: 0,
      });
    });
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
