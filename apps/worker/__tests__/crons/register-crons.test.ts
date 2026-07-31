import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { Job, Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { registerCrons } from '../../src/crons/register-crons.js';
import { defineCron, type CronDef } from '../../src/crons/define.js';
import { accountSnapshotSafetyHandler } from '../../src/crons/account-snapshot-safety.cron.js';
import { actionLogPruneHandler } from '../../src/crons/action-log-prune.cron.js';
import { aliveHandler } from '../../src/crons/alive.cron.js';
import { auditPruneHandler } from '../../src/crons/audit-prune.cron.js';
import { dailyAthHandler } from '../../src/crons/daily-ath.cron.js';
import { dustSnapshotHandler } from '../../src/crons/dust-snapshot.cron.js';
import { orphanOrdersDetectHandler } from '../../src/crons/orphan-orders-detect.cron.js';
import { exchangeInfoRefreshHandler } from '../../src/crons/exchange-info-refresh.cron.js';
import { technicalsComputeHandler } from '../../src/crons/technicals-compute.cron.js';
import type { QueueSet } from '../../src/queues/queue-set.js';
import { QUEUE_NAMES } from '../../src/queues/queue-names.js';
import type { ActiveProfile } from '../../src/profile-manager/profile-manager.js';

const silentLogger = pino({ level: 'silent' });

// Stub Redis for the retention-receipt write step. The handler only calls
// `.set(key, value)` so a no-op stub is enough for the wiring assertions.
const stubRedis = (): Redis => ({ set: vi.fn(async () => 'OK') }) as unknown as Redis;

// Stub Redis passed to registerCrons itself: the cron-status recorder wraps each
// handler and writes its outcome via `.hset`. A no-op stub suffices here.
const opsRedis: Redis = { hset: vi.fn(async () => 1) } as unknown as Redis;

const buildStubQueueSet = (
  queueNames: readonly string[],
): {
  queueSet: QueueSet;
  upserts: { name: string; pattern: string }[];
  registeredWorkers: { name: string; handler: (job: Job) => Promise<void> }[];
  removedSchedulers: string[];
  added: { queue: string; delay: number }[];
  workerListeners: Record<string, Record<string, ((job: unknown) => void) | undefined>>;
  pendingCount: Record<string, number>;
} => {
  const upserts: { name: string; pattern: string }[] = [];
  const registeredWorkers: { name: string; handler: (job: Job) => Promise<void> }[] = [];
  const removedSchedulers: string[] = [];
  const added: { queue: string; delay: number }[] = [];
  const workerListeners: Record<string, Record<string, ((job: unknown) => void) | undefined>> = {};
  // Per-queue count returned by the pending-count getters; 0 unless a test sets it.
  const pendingCount: Record<string, number> = {};
  const queues: Record<string, Queue> = {};
  for (const name of new Set(queueNames)) {
    queues[name] = {
      upsertJobScheduler: vi.fn(async (id: string, opts: { pattern: string }) => {
        upserts.push({ name: id, pattern: opts.pattern });
      }),
      removeJobScheduler: vi.fn(async (id: string) => {
        removedSchedulers.push(id);
        return true;
      }),
      clean: vi.fn(async () => []),
      add: vi.fn(async (_jobName: string, _data: unknown, opts: { delay: number }) => {
        added.push({ queue: name, delay: opts.delay });
        return { id: 'job' };
      }),
      getActiveCount: vi.fn(async () => pendingCount[name] ?? 0),
      getWaitingCount: vi.fn(async () => 0),
      getDelayedCount: vi.fn(async () => 0),
    } as unknown as Queue;
  }
  const queueSet: QueueSet = {
    queues: queues as QueueSet['queues'],
    workers: [],
    enqueueDlq: vi.fn(async () => undefined),
    registerWorker: vi.fn((name: string, handler: (job: Job) => Promise<void>) => {
      registeredWorkers.push({ name, handler });
      const listeners: Record<string, ((job: unknown) => void) | undefined> = {};
      workerListeners[name] = listeners;
      return {
        on: vi.fn((event: string, cb: (job: unknown) => void) => {
          listeners[event] = cb;
        }),
      } as unknown as Worker;
    }) as unknown as QueueSet['registerWorker'],
    closeAll: vi.fn(async () => undefined),
  };
  return {
    queueSet,
    upserts,
    registeredWorkers,
    removedSchedulers,
    added,
    workerListeners,
    pendingCount,
  };
};

// Production-shaped cron set built at the call site (mirrors what
// `apps/worker/src/index.ts` constructs at boot). Tests can pass overrides
// for individual entries via `mergeCron(name, overrides)` if needed.
const buildCrons = (overrides?: Partial<Record<string, Partial<CronDef>>>): readonly CronDef[] => {
  const base: CronDef[] = [
    defineCron({
      name: 'exchange-info-refresh',
      queue: QUEUE_NAMES.exchangeInfoRefresh,
      pattern: '0 */5 * * * *',
      handler: exchangeInfoRefreshHandler({
        logger: silentLogger,
        run: vi.fn(async () => undefined),
      }),
    }),
    defineCron({
      name: 'action-log-prune',
      queue: QUEUE_NAMES.actionLogPrune,
      pattern: '0 30 3 * * *',
      handler: actionLogPruneHandler({
        logger: silentLogger,
        redis: stubRedis(),
        retentionDays: 30,
        prune: vi.fn(async () => 0),
      }),
    }),
    defineCron({
      name: 'audit-prune',
      queue: QUEUE_NAMES.auditPrune,
      pattern: '0 35 3 * * *',
      handler: auditPruneHandler({
        logger: silentLogger,
        redis: stubRedis(),
        retentionDays: 90,
        pruneOlderThan: vi.fn(async () => 0),
      }),
    }),
    defineCron({
      name: 'alive',
      queue: QUEUE_NAMES.alive,
      pattern: '0 0 9 * * *',
      handler: aliveHandler({
        logger: silentLogger,
        listActive: () => [],
        sendDigest: vi.fn(async () => undefined),
      }),
    }),
    defineCron({
      name: 'technicals-compute',
      queue: QUEUE_NAMES.technicalsCompute,
      selfReschedulePeriodMs: 30_000,
      handler: technicalsComputeHandler({
        logger: silentLogger,
        listActive: () => [],
        fetchAndCache: vi.fn(async () => undefined),
      }),
    }),
    defineCron({
      name: 'daily-ath',
      queue: QUEUE_NAMES.dailyAth,
      pattern: '0 0 0 * * *',
      handler: dailyAthHandler({
        logger: silentLogger,
        listActive: () => [],
        refreshAth: vi.fn(async () => undefined),
      }),
    }),
    defineCron({
      name: 'account-snapshot-safety',
      queue: QUEUE_NAMES.accountSnapshotSafety,
      pattern: '*/5 * * * * *',
      handler: accountSnapshotSafetyHandler({
        logger: silentLogger,
        listActive: () => [],
        resolveBinance: vi.fn(async () => null),
        persistAccount: vi.fn(async () => undefined),
        lastWsEventMs: vi.fn(async () => null),
      }),
    }),
    defineCron({
      name: 'dust-snapshot',
      queue: QUEUE_NAMES.dustSnapshot,
      pattern: '0 */5 * * * *',
      handler: dustSnapshotHandler({
        logger: silentLogger,
        listActive: () => [],
        resolveBinance: vi.fn(async () => null),
        persistDust: vi.fn(async () => undefined),
        listPendingDustTransfers: vi.fn(async () => []),
        claimAction: vi.fn(async () => true),
        finalize: vi.fn(async () => true),
        releaseClaim: vi.fn(async () => undefined),
        reapStaleProcessing: vi.fn(async () => 0),
      }),
    }),
    defineCron({
      name: 'orphan-orders-detect',
      queue: QUEUE_NAMES.orphanOrdersDetect,
      pattern: '0 */10 * * * *',
      handler: orphanOrdersDetectHandler({
        logger: silentLogger,
        listActive: () => [],
        resolveBinance: vi.fn(async () => null),
        listTrackedLiveOrderIds: vi.fn(async () => []),
        computeNewOrphans: vi.fn(async () => []),
        commitAlerted: vi.fn(async () => undefined),
        resolveNotifiers: vi.fn(async () => []),
        notifyProviders: { get: () => undefined } as unknown as Parameters<
          typeof orphanOrdersDetectHandler
        >[0]['notifyProviders'],
      }),
    }),
  ];
  if (!overrides) return base;
  return base.map((def) =>
    overrides[def.name] ? defineCron({ ...def, ...overrides[def.name] }) : def,
  );
};

describe('registerCrons', () => {
  it('upserts a scheduler for every pattern cron + registers a worker for every CronDef', async () => {
    const crons = buildCrons();
    const { queueSet, upserts, registeredWorkers } = buildStubQueueSet(crons.map((c) => c.queue));

    await registerCrons({ queueSet, logger: silentLogger, redis: opsRedis, crons });

    // Self-rescheduling crons (technicals-compute) do not upsert a scheduler.
    const patternCrons = crons.filter((c) => c.selfReschedulePeriodMs === undefined);
    expect(upserts.map((u) => u.name).sort()).toEqual(
      patternCrons
        .map((c) => c.name)
        .slice()
        .sort(),
    );
    // Every cron, pattern or self-rescheduling, still registers a worker.
    expect(registeredWorkers.map((w) => w.name).sort()).toEqual(
      crons
        .map((c) => c.queue)
        .slice()
        .sort(),
    );
    for (const u of upserts) {
      const def = crons.find((c) => c.name === u.name);
      expect(u.pattern).toBe(def?.pattern);
    }
  });

  it('self-rescheduling cron removes any stale scheduler and seeds the loop when idle', async () => {
    const crons = buildCrons();
    const { queueSet, upserts, removedSchedulers, added } = buildStubQueueSet(
      crons.map((c) => c.queue),
    );

    await registerCrons({ queueSet, logger: silentLogger, redis: opsRedis, crons });

    // Recovery: the prior fixed-cadence scheduler is removed so a restart heals
    // a wedged deployment, and technicals-compute never upserts a new one.
    expect(removedSchedulers).toContain('technicals-compute');
    expect(upserts.map((u) => u.name)).not.toContain('technicals-compute');
    // Nothing pending → seed exactly one run immediately.
    const seeded = added.filter((a) => a.queue === 'technicals-compute');
    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.delay).toBe(0);
  });

  it('self-rescheduling cron does not seed when a run is already pending', async () => {
    const crons = buildCrons();
    const stub = buildStubQueueSet(crons.map((c) => c.queue));
    stub.pendingCount['technicals-compute'] = 1; // a prior run is still in flight

    await registerCrons({ queueSet: stub.queueSet, logger: silentLogger, redis: opsRedis, crons });

    expect(stub.added.filter((a) => a.queue === 'technicals-compute')).toHaveLength(0);
  });

  it('self-rescheduling cron re-arms on terminal events, holding the start-to-start period', async () => {
    const crons = buildCrons();
    const stub = buildStubQueueSet(crons.map((c) => c.queue));
    stub.pendingCount['technicals-compute'] = 1; // suppress the boot seed for clarity

    await registerCrons({ queueSet: stub.queueSet, logger: silentLogger, redis: opsRedis, crons });
    const listeners = stub.workerListeners['technicals-compute'];
    if (!listeners?.completed || !listeners.failed) throw new Error('listeners not attached');

    // A 5s run leaves 25s of the 30s period → next is delayed 25s.
    listeners.completed({ processedOn: 1_000, finishedOn: 6_000 });
    // A run that overruns the period collapses to back-to-back (delay 0).
    listeners.completed({ processedOn: 1_000, finishedOn: 41_000 });
    // A terminal failure (retry budget spent) still re-arms so the loop cannot
    // silently stop. technicals-compute uses attempts 1, so the first failure is
    // terminal.
    listeners.failed({
      processedOn: 1_000,
      finishedOn: 2_000,
      attemptsMade: 1,
      opts: { attempts: 1 },
    });

    const delays = stub.added.filter((a) => a.queue === 'technicals-compute').map((a) => a.delay);
    expect(delays).toEqual([25_000, 0, 29_000]);
  });

  it('self-rescheduling cron does NOT re-arm on a non-terminal (will-retry) failure', async () => {
    // BullMQ emits `failed` on every attempt and then retries; re-arming on a
    // non-terminal attempt would double-arm the loop and reintroduce a backlog.
    const crons = buildCrons();
    const stub = buildStubQueueSet(crons.map((c) => c.queue));
    stub.pendingCount['technicals-compute'] = 1; // suppress the boot seed

    await registerCrons({ queueSet: stub.queueSet, logger: silentLogger, redis: opsRedis, crons });
    const listeners = stub.workerListeners['technicals-compute'];
    if (!listeners?.failed) throw new Error('failed listener not attached');

    // attemptsMade 1 of 3 → BullMQ will retry → must NOT re-arm.
    listeners.failed({
      processedOn: 1_000,
      finishedOn: 2_000,
      attemptsMade: 1,
      opts: { attempts: 3 },
    });
    expect(stub.added.filter((a) => a.queue === 'technicals-compute')).toHaveLength(0);

    // The terminal attempt re-arms exactly once.
    listeners.failed({
      processedOn: 1_000,
      finishedOn: 2_000,
      attemptsMade: 3,
      opts: { attempts: 3 },
    });
    expect(stub.added.filter((a) => a.queue === 'technicals-compute')).toHaveLength(1);
  });

  it('exchange-info-refresh worker invokes the injected run function', async () => {
    const run = vi.fn(async () => ({ fetched: 100, written: 95, skipped: 5 }));
    const crons = buildCrons({
      'exchange-info-refresh': {
        handler: exchangeInfoRefreshHandler({ logger: silentLogger, run }),
      },
    });
    const { queueSet, registeredWorkers } = buildStubQueueSet(crons.map((c) => c.queue));

    await registerCrons({ queueSet, logger: silentLogger, redis: opsRedis, crons });

    const eir = registeredWorkers.find((w) => w.name === 'exchange-info-refresh');
    if (!eir) throw new Error('test setup: exchange-info-refresh worker not registered');
    await eir.handler({ id: 'job-1', data: {} } as unknown as Job);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('throws when a CronDef references a queue not in QUEUE_NAMES', async () => {
    const crons = buildCrons();
    const { queueSet } = buildStubQueueSet(crons.map((c) => c.queue));
    delete (queueSet.queues as Record<string, unknown>)['exchange-info-refresh'];

    await expect(
      registerCrons({ queueSet, logger: silentLogger, redis: opsRedis, crons }),
    ).rejects.toThrow(
      /queueSet is missing queue "exchange-info-refresh" for cron "exchange-info-refresh"/,
    );
  });

  it('every cron worker runs its real handler without throwing (no DLQ accumulation)', async () => {
    const crons = buildCrons();
    const { queueSet, registeredWorkers } = buildStubQueueSet(crons.map((c) => c.queue));

    await registerCrons({ queueSet, logger: silentLogger, redis: opsRedis, crons });

    expect(registeredWorkers).toHaveLength(crons.length);
    for (const w of registeredWorkers) {
      await expect(w.handler({ id: 'job-1', data: {} } as unknown as Job)).resolves.toBeUndefined();
    }
  });

  it('alive worker enumerates active profiles and sends a digest each', async () => {
    const sendDigest = vi.fn(async () => undefined);
    const crons = buildCrons({
      alive: {
        handler: aliveHandler({
          logger: silentLogger,
          listActive: (): readonly ActiveProfile[] => [
            {
              profileId: 'p1',
              userId: 'u1',
              candleInterval: '1h',
              symbols: ['BTCUSDT'],
            } as unknown as ActiveProfile,
          ],
          sendDigest,
        }),
      },
    });
    const { queueSet, registeredWorkers } = buildStubQueueSet(crons.map((c) => c.queue));

    await registerCrons({ queueSet, logger: silentLogger, redis: opsRedis, crons });

    const w = registeredWorkers.find((r) => r.name === 'alive');
    if (!w) throw new Error('test setup: alive worker not registered');
    await w.handler({ id: 'job-1', data: {} } as unknown as Job);
    expect(sendDigest).toHaveBeenCalledTimes(1);
  });

  it('action-log-prune worker invokes the injected pruner', async () => {
    const prune = vi.fn(async () => 7);
    const crons = buildCrons({
      'action-log-prune': {
        handler: actionLogPruneHandler({
          logger: silentLogger,
          redis: stubRedis(),
          retentionDays: 30,
          prune,
        }),
      },
    });
    const { queueSet, registeredWorkers } = buildStubQueueSet(crons.map((c) => c.queue));

    await registerCrons({ queueSet, logger: silentLogger, redis: opsRedis, crons });

    const w = registeredWorkers.find((r) => r.name === 'action-log-prune');
    if (!w) throw new Error('test setup: action-log-prune worker not registered');
    await w.handler({ id: 'job-1', data: { isoDate: '2026-05-14' } } as unknown as Job);
    expect(prune).toHaveBeenCalledTimes(1);
  });

  it('audit-prune worker invokes the injected pruner with retentionDays', async () => {
    const pruneOlderThan = vi.fn(async () => 3);
    const crons = buildCrons({
      'audit-prune': {
        handler: auditPruneHandler({
          logger: silentLogger,
          redis: stubRedis(),
          retentionDays: 45,
          pruneOlderThan,
        }),
      },
    });
    const { queueSet, registeredWorkers } = buildStubQueueSet(crons.map((c) => c.queue));

    await registerCrons({ queueSet, logger: silentLogger, redis: opsRedis, crons });

    const w = registeredWorkers.find((r) => r.name === 'audit-prune');
    if (!w) throw new Error('test setup: audit-prune worker not registered');
    await w.handler({ id: 'job-1', data: { isoDate: '2026-05-14' } } as unknown as Job);
    expect(pruneOlderThan).toHaveBeenCalledWith(45);
  });
});
