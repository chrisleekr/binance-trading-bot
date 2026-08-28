// Characterization lock for the public DI surface `buildBootContext` returns.
//
// This pins the observable contract — the exact set of exposed fields, the
// passthrough of `liveDemo`/`publicWebUrl`, and the invariant that the audit
// drainer holds its OWN Redis connection (a blocking XREADGROUP must not share
// the shared client) — so a construction-order decomposition can be proven a
// no-op against real Postgres + Redis rather than a mocked constructor.

import { afterAll, beforeAll, expect, it } from 'vitest';

import { migrate } from '@app/db';
import { withPostgres, withRedis } from '@app/testcontainers';

import { buildBootContext, type BootContext, type BootEnv } from '../../src/boot/boot-context.js';

import { describeInfra } from './_infra-gate.js';

// The exact public field set, sorted. Captured from a real `buildBootContext`
// run; the decomposition must leave every one of these — and no more — in place.
const EXPECTED_FIELDS = [
  'accountNotify',
  'accountNotifyBatch',
  'accountSnapshotStore',
  'auditDrainer',
  'auditDrainerRedis',
  'chain',
  'db',
  'enabledSetReconciler',
  'enqueueSymbolReconcile',
  'evictProfileContext',
  'exchangeInfoRefresh',
  'fillAdopter',
  'fillBackfiller',
  'getAssetPolicy',
  'getSymbolAdmission',
  'getSymbolInfo',
  'lifecycles',
  'listActive',
  'liveDemo',
  'liveExecutor',
  'logger',
  'marketDataPort',
  'metrics',
  'metricsRegistry',
  'notifierGapThrottle',
  'notifyEvent',
  'notifyProviders',
  'persistMigratedProfileState',
  'pool',
  'profileManager',
  'publicWebUrl',
  'queueSet',
  'reconcileDeps',
  'redis',
  'resolveBinanceClient',
  'resolveBinanceWithMode',
  'statePort',
  'strategies',
  'subscriptionOwnership',
  'symbolStateDeps',
  'tickHandler',
  'weightGovernor',
  'workerEnv',
];

const PUBLIC_WEB_URL = 'https://demo.example.test';

describeInfra('both', 'buildBootContext — public DI surface', () => {
  let ctx: BootContext;
  let stopPg: () => Promise<void>;
  let stopRedis: () => Promise<void>;
  // buildBootContext's internal `loadWorkerEnv()` reads DATABASE_URL/REDIS_URL
  // from process.env; snapshot so afterAll restores the ambient environment.
  const priorEnv = {
    DATABASE_URL: process.env['DATABASE_URL'],
    REDIS_URL: process.env['REDIS_URL'],
  };

  beforeAll(async () => {
    const pg = await withPostgres();
    const rd = await withRedis();
    stopPg = pg.stop;
    stopRedis = rd.stop;

    await migrate({ connectionString: pg.databaseUrl, log: () => undefined });

    process.env['DATABASE_URL'] = pg.databaseUrl;
    process.env['REDIS_URL'] = rd.redisUrl;

    // Characterise the normal (non-demo) worker boot — the production path. A
    // demo box (liveDemo:true) would run the live-account guard, which depends on
    // DB contents and so is fragile when the infra DB is shared across the
    // integration suite; the guard is not part of the DI-surface contract this
    // test locks.
    const env: BootEnv = {
      pgUrl: pg.databaseUrl,
      redisUrl: rd.redisUrl,
      liveDemo: false,
      publicWebUrl: PUBLIC_WEB_URL,
    };
    ctx = await buildBootContext(env);
  }, 180_000);

  afterAll(async () => {
    // Close everything construction opened so the process does not hang: the
    // BullMQ workers, the audit drainer's dedicated connection, the shared
    // client, and the pg pool. Lifecycles are never started, so no start()ed
    // subsystem needs stopping.
    //
    // Each close is swallowed individually, following `tick-tv-bundle`: sequenced bare, the first rejection returns from this hook and leaves BOTH containers running for the rest of the session. A close that fails here is not the suite's result — the assertions have already run — but a stranded container degrades every suite after it.
    const swallow = (): void => undefined;
    await ctx?.queueSet.closeAll().catch(swallow);
    await ctx?.auditDrainerRedis.quit().catch(swallow);
    await ctx?.redis.quit().catch(swallow);
    await ctx?.pool.end().catch(swallow);
    if (stopRedis) await stopRedis().catch(swallow);
    if (stopPg) await stopPg().catch(swallow);

    process.env['DATABASE_URL'] = priorEnv.DATABASE_URL;
    process.env['REDIS_URL'] = priorEnv.REDIS_URL;
  });

  it('exposes exactly the pinned public field set', () => {
    expect(Object.keys(ctx).sort()).toEqual(EXPECTED_FIELDS);
  });

  it('returns a non-empty lifecycles array of start/stop components', () => {
    expect(Array.isArray(ctx.lifecycles)).toBe(true);
    expect(ctx.lifecycles.length).toBeGreaterThan(0);
    for (const c of ctx.lifecycles) {
      expect(typeof c.start).toBe('function');
      expect(typeof c.stop).toBe('function');
    }
  });

  it('passes liveDemo and publicWebUrl straight through from env', () => {
    expect(ctx.liveDemo).toBe(false);
    expect(ctx.publicWebUrl).toBe(PUBLIC_WEB_URL);
  });

  it('gives the audit drainer its own Redis connection, distinct from the shared client', () => {
    expect(ctx.auditDrainerRedis).not.toBe(ctx.redis);
  });

  it('wires the metrics registry and the chain', () => {
    expect(ctx.metricsRegistry).toBeDefined();
    expect(ctx.chain).toBeDefined();
  });

  it('hands the reconcile dep bag the SAME sink the process exports', () => {
    // The reconcile counters are the only machine-readable record that a sweep deleted a position. Every unit test around them injects its own stub sink, so none of them can observe the construction site forgetting to pass one; this asserts the real bag the real boot builds.
    expect(ctx.reconcileDeps.metrics).toBe(ctx.metrics);
  });
});
