import {
  asAccountId,
  asProfileId,
  asUserId,
  type AccountId,
  type ProfileId,
  type UserId,
} from '@app/contracts';
import {
  assertTestDatabaseUrl,
  createBullMQConnection,
  createDb,
  createPool,
  migrate,
  profileKey,
  type ScopedRedis,
} from '@app/db';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type pino from 'pino';
import { pino as createPino } from 'pino';
import { afterAll } from 'vitest';
import { createMetricsRegistry } from '@app/observability';
import { createAuth } from '../src/auth.js';
import { authRouter } from '../src/routes/auth.js';
import { mountApiRouters } from '../src/routes/mount.js';
import { audit } from '../src/middleware/audit.js';
import { errorHandler } from '../src/middleware/error.js';
import { notifyProviders } from '../src/notifiers.js';
import { buildStrategyRegistry } from '@app/strategy-registry';
import { createApiStrategyRegistry } from '../src/strategies/registry.js';
import type { DI } from '../src/di.js';
import { createApiHono, type ApiHono } from '../src/types.js';

export const TEST_DB_URL = process.env['DATABASE_TEST_URL'];
export const TEST_REDIS_URL = process.env['REDIS_TEST_URL'] ?? 'redis://127.0.0.1:6390/15';

// These integration suites need real Postgres + Redis. Two ways to get them:
//  - DATABASE_TEST_URL (+ REDIS_TEST_URL) point at an already-running stack
//    (the dev fast path, and the CI integration job's service containers).
//  - TESTCONTAINERS=1 auto-provisions a hermetic stack via @app/testcontainers
//    (Docker required), so a plain checkout runs them without standing up a DB.
// Neither set (the no-Docker unit job) → the suites `describe.skip`, unchanged.
export const HAS_INFRA = Boolean(TEST_DB_URL) || process.env['TESTCONTAINERS'] === '1';

/** Resolved connection strings plus a teardown hook for any spawned containers. */
interface ResolvedInfra {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly stop: () => Promise<void>;
}

// One container pair is provisioned on the first setupApp and reused by this isolated test file. The root afterAll below stops the stack after it resolves; when DATABASE_TEST_URL is set, this module uses it directly and spawns nothing.
let infraPromise: Promise<ResolvedInfra> | null = null;

const resolveInfra = (): Promise<ResolvedInfra> => {
  if (!infraPromise) {
    infraPromise = (async (): Promise<ResolvedInfra> => {
      if (TEST_DB_URL) {
        // Pre-existing stack (dev / CI service containers). setupApp TRUNCATEs
        // this DB, so refuse a non-`_test` target — a DATABASE_TEST_URL aimed at
        // the live `binance_trading_bot` would wipe real data.
        assertTestDatabaseUrl(TEST_DB_URL);
        // migrate is checksum-idempotent, so applying it here guarantees the
        // schema is current without a separate setup step.
        await migrate({ connectionString: TEST_DB_URL, log: () => undefined });
        return { databaseUrl: TEST_DB_URL, redisUrl: TEST_REDIS_URL, stop: async () => undefined };
      }
      // Dynamic import so the heavy testcontainers dep is pulled in only on the
      // provision path. _helpers is imported by every api suite including the
      // Docker-free unit lane; a static import would force them all to resolve
      // testcontainers (and fail in vite's import-analysis).
      const { withPostgres, withRedis } = await import('@app/testcontainers');
      // Tighter than the wrapper's 90s default because this project's hookTimeout is 60s: on the default a stalled provision would blow the hook first and report "beforeAll timed out" instead of naming the daemon.
      //
      // One budget for the PAIR, not one each. Two independent 45s deadlines can run to 90s between them: Postgres taking 30s and Redis then stalling blows the hook at 60s while Redis's own deadline is not due until 75s, handing back exactly the undiagnosable message this path exists to replace. Only the first start would ever have been blamed correctly, and on a contended daemon — the one case this targets — both being slow is the normal shape, not the exotic one.
      //
      // The budget covers the two starts only. migrate() runs after it and is deliberately not deadline-guarded: 45s of the hook's 60s leaves it headroom, and a migrate slow enough to blow the rest still fails self-describingly because the runner names the file it is applying. A stalled daemon does not, which is the whole reason the starts are wrapped and this is not.
      const PROVISION_BUDGET_MS = 45_000;
      const provisionDeadlineAt = Date.now() + PROVISION_BUDGET_MS;
      const pg = await withPostgres({ startTimeoutMs: PROVISION_BUDGET_MS });
      // Everything after the first successful start is wrapped, because until the `stop` closure below exists that container's only handle is this local binding. A rejected `withRedis` or a throwing `migrate` would otherwise return through this frame and strand a RUNNING Postgres with nothing left holding it — and the deadline reaper in `@app/testcontainers` owns only the starts it timed out, not a sibling that succeeded. Ryuk still reaps it at session exit, so this bounds the leak to the run rather than removing it, which matters most on the contended daemon where the redis start is likeliest to reject.
      try {
        // Floored above zero because a fully spent budget is a deadline that has already expired: passed as 0 it rejects before the container is asked for, blaming the daemon for a delay that happened above this line. The floor buys one second to fail on its own merits.
        const redis = await withRedis({
          startTimeoutMs: Math.max(1_000, provisionDeadlineAt - Date.now()),
        });
        try {
          await migrate({ connectionString: pg.databaseUrl, log: () => undefined });
        } catch (error) {
          await redis.stop().catch(() => undefined);
          throw error;
        }
        return {
          databaseUrl: pg.databaseUrl,
          redisUrl: redis.redisUrl,
          // Both stops are STARTED before either is awaited. Sequenced, a rejecting `pg.stop()` returns from this closure with the Redis container still running for the rest of the session; `Promise.all` still rejects with the first failure, so nothing is swallowed.
          stop: async () => {
            await Promise.all([pg.stop(), redis.stop()]);
          },
        };
      } catch (error) {
        await pg.stop().catch(() => undefined);
        throw error;
      }
    })();
  }
  return infraPromise;
};

/**
 * Stops a successfully resolved infrastructure stack owned by this isolated test file. The root hook below runs in the same module context as `infraPromise`; Vitest global setup runs separately and cannot reach it.
 *
 * @returns A promise that settles after the resolved stack's stop callback completes.
 */
export const stopSharedInfra = async (): Promise<void> => {
  const pending = infraPromise;
  if (!pending) return;
  infraPromise = null;
  // Swallowed rather than awaited bare, matching `packages/db/__tests__/_infra.ts`: a provision that never resolved leaves nothing to stop, and rethrowing here would replace the real setup failure in the report with a teardown one. Clearing the memo before awaiting also keeps a rejected provision from being retained and re-awaited.
  const infra = await pending.catch(() => null);
  await infra?.stop();
};

afterAll(stopSharedInfra);

// RFC-4122 v4 conformant (version nibble 4, variant nibble 8). Postgres accepts
// any uuid text, but the route param schemas use zod v4 `z.uuid()`, which
// enforces the version/variant bits. Production ids come from the DB's v4
// generator, so the fixtures must conform or every uuid-param route 422s.
const ALICE_USER = asUserId('00000000-0000-4000-8000-00000000a001');
const ALICE_ACCOUNT = asAccountId('00000000-0000-4000-8000-00000000a201');
const ALICE_PROFILE = asProfileId('00000000-0000-4000-8000-00000000a101');
const BOB_USER = asUserId('00000000-0000-4000-8000-00000000b001');
const BOB_ACCOUNT = asAccountId('00000000-0000-4000-8000-00000000b201');
const BOB_PROFILE = asProfileId('00000000-0000-4000-8000-00000000b101');

/**
 * The `trailing-trade` version the registry actually serves. The seed used to
 * hardcode `1.0.0` while the plugin shipped `2.0.0`, so the seeded profile
 * resolved as version-skewed and every route behind the strategy-enablement
 * gate rejected it. Reading it from the registry keeps the fixture correct
 * across plugin version bumps instead of rotting into a second skew.
 */
export const TRAILING_TRADE_VERSION: string = ((): string => {
  const plugin = buildStrategyRegistry().get('trailing-trade');
  if (!plugin) throw new Error('trailing-trade is not registered');
  return plugin.version;
})();

export interface ApiFixture {
  // `OpenAPIHono`, not the narrower `Hono`, because the fixture app IS one: a suite that asserts on the generated OpenAPI document reaches `getOpenAPIDocument` through here.
  app: ApiHono;
  di: DI;
  // The resolved Redis URL the app's DI client is wired to. A suite that opens
  // its own client to assert on cache side effects MUST use this, not a
  // hardcoded env default: under TESTCONTAINERS the app talks to a provisioned
  // container on a random port, so a client pointed at the default 6390 would
  // read a different Redis and see the app's writes as no-ops.
  redisUrl: string;
  alice: { userId: UserId; accountId: AccountId; profileId: ProfileId };
  bob: { userId: UserId; accountId: AccountId; profileId: ProfileId };
  cleanup: () => Promise<void>;
}

const unwiredMarketData = (): never => {
  throw new Error('di.marketData is not wired in the api test fixture');
};

const createTestDI = (logger: pino.Logger, infra: ResolvedInfra): DI => {
  const pool = createPool({ kind: 'api', connectionString: infra.databaseUrl });
  const db = createDb(pool);
  const connection = createBullMQConnection({ url: infra.redisUrl });
  const queue = new Queue('pipeline-test', { connection });
  // The override accept path enqueues a re-evaluation tick through `tickQueue`
  // (deliberately NOT the pipeline queue — see `enqueueTick`). Absent from the
  // fixture, every accepted operator action died on `undefined.add` and 500'd,
  // so a test could only ever assert "the route did not answer 409".
  const tickQueue = new Queue('tick-test', { connection });
  const backtestQueue = new Queue('backtest-test', { connection });
  const advisorQueue = new Queue('advisor-test', { connection });
  const diagnosisQueue = new Queue('profile-diagnosis-test', { connection });
  // A REAL profile-scoped writer, not a thrower. The operator-override accept
  // path writes through `forProfile`, so a stub that throws turns every accepted
  // override into a 500 — which silently downgrades "the daily-loss breaker let
  // this exit through" into the far weaker "the route did not answer 409", and a
  // route that 500s on every accept would still pass that. `profileKey` is the
  // same builder `createRedis().forProfile` uses, so the bytes match production.
  const scopedRedis = new Redis(infra.redisUrl);
  // Annotated as the real `ScopedRedis` rather than an untyped literal so the key-name and key-param generics bind: an inline `never`-typed stand-in accepts any name, which is exactly the drift a fixture must not hide.
  const redis: ScopedRedis = {
    // The raw accessor borrows the fixture-owned connection; only di.shutdown() or fx.cleanup() terminates it.
    raw: () => scopedRedis,
    forProfile: (scope) => ({
      async get(name, ...params) {
        return scopedRedis.get(profileKey(scope, name, ...params));
      },
      async set(name, value, options, ...params) {
        const key = profileKey(scope, name, ...params);
        return options.ttlSeconds === undefined
          ? scopedRedis.set(key, value)
          : scopedRedis.set(key, value, 'EX', options.ttlSeconds);
      },
      async del(name, ...params) {
        return scopedRedis.del(profileKey(scope, name, ...params));
      },
      async getdel(name, ...params) {
        return scopedRedis.getdel(profileKey(scope, name, ...params));
      },
    }),
    forGlobal: () => {
      throw new Error('not used in tests');
    },
    quit: async () => scopedRedis.quit(),
  };
  // Build a real Better Auth instance so integration tests can drive the
  // sign-up / sign-in / change-password / reset-password flows end-to-end.
  // Cheap to construct (no I/O until $context is awaited); the prior `{}`
  // placeholder existed only because no test exercised auth via this fixture.
  const auth = createAuth({
    db,
    webOrigins: ['http://localhost:5173'],
    authSecret: 'x'.repeat(32),
    isProduction: false,
  });
  return {
    env: {
      NODE_ENV: 'test',
      PORT: 0,
      ADMIN_PORT: 9100,
      ADMIN_HOST: '127.0.0.1',
      WEB_DIST_DIR: 'apps/web/dist',
      WEB_ORIGIN: ['http://localhost:5173'],
      DATABASE_URL: infra.databaseUrl,
      REDIS_URL: infra.redisUrl,
      AUTH_SECRET: 'x'.repeat(32),
      PGSSLMODE: 'prefer',
      BACKUP_DIR: process.env['BACKUP_DIR'] ?? '/backups',
      GIT_SHA: 'testsha',
      LIVE_DEMO: false,
    },
    pool,
    db,
    redis,
    queue,
    tickQueue,
    backtestQueue,
    advisorQueue,
    diagnosisQueue,
    logger,
    auth,
    strategies: createApiStrategyRegistry(buildStrategyRegistry()),
    notifyProviders,
    metrics: createMetricsRegistry({ service: 'api-test' }),
    // Deliberately unwired: no api suite drives the market-data endpoints in `routes/orders.ts`, and a real REST client here would let a test reach Binance over the network. Throwing names the gap the moment a suite needs it, instead of the `undefined.getKlines` TypeError this fixture used to produce.
    marketData: {
      getKlines: unwiredMarketData,
      getTicker24hr: unwiredMarketData,
      getRecentTrades: unwiredMarketData,
      getDepth: unwiredMarketData,
    },
    // Default available LLM stub returning canned structured output; route
    // tests reassign fx.di.resolveLlm to flip availability or capture inputs.
    resolveLlm: async () => ({
      available: true,
      improveConfig: async () => ({ summary: '', suggestions: [] }),
    }),
    gitSha: 'testsha',
    bootedAt: '2026-01-01T00:00:00.000Z',
    demoOperatorId: null,
    shutdown: async () => {
      await backtestQueue.close();
      await advisorQueue.close();
      await diagnosisQueue.close();
      await queue.close();
      await tickQueue.close();
      await scopedRedis.quit();
      await pool.end();
    },
  };
};

// Anything that can run SQL: a `Pool` (autocommit per call) or a `PoolClient`
// (so the reset steps can share one transaction under an advisory lock).
type Queryable = Pick<Pool, 'query'>;

const truncate = async (db: Queryable): Promise<void> => {
  await db.query(/* sql */ `truncate table
    audit_logs, profile_state_history, override_actions,
    trade_archive, avg_entry_prices, manual_orders, orders,
    profile_notifiers, profile_symbols, api_keys, profiles, accounts, users,
    "user", account, session, verification
    restart identity cascade`);
};

/**
 * Restore every global `id = 1` singleton to its migration defaults.
 *
 * These rows cannot be truncated: each repo throws when the row is missing, so
 * they are reset in place. Nothing reset them before, so a test that flipped
 * `backup_config.enabled`, muted an ops category, or switched the AI provider
 * leaked that state into every later test — and, against a persistent
 * `DATABASE_TEST_URL`, into every later *run*.
 *
 * Keep in step with any new `check (id = 1)` table.
 */
const resetSingletons = async (db: Queryable): Promise<void> => {
  await db.query(/* sql */ `insert into backup_config (id) values (1)
    on conflict (id) do update set
      enabled = false, interval_hours = 24, retention_count = 14, last_backup_at = null`);
  await db.query(/* sql */ `insert into ops_notify_config (id) values (1)
    on conflict (id) do update set events = '{}'::jsonb`);
  await db.query(/* sql */ `insert into retention_config (id) values (1)
    on conflict (id) do update set
      action_log_days = 1, action_log_max_rows = 200000,
      audit_log_days = 90, audit_stream_maxlen = 100000,
      debug_capture_profile_id = null, debug_capture_until = null`);
  await db.query(/* sql */ `insert into ai_provider_config (id) values (1)
    on conflict (id) do update set
      provider = 'anthropic',
      anthropic_api_key = '', anthropic_oauth_token = '', anthropic_model = 'claude-sonnet-5',
      openai_base_url = 'http://host.docker.internal:11434/v1',
      openai_api_key = '', openai_model = ''`);
};

/**
 * Redis carries read-through caches (exchange-info, discovery scoreboards) keyed
 * globally, not per test. Nothing cleared them, so a value cached by one suite
 * satisfied the next suite's "fresh profile returns null" assertion — and
 * survived across runs against a persistent `REDIS_TEST_URL`.
 */
const flushRedis = async (redisUrl: string): Promise<void> => {
  const client = new Redis(redisUrl);
  try {
    await client.flushdb();
  } finally {
    await client.quit();
  }
};

const seed = async (db: Queryable): Promise<void> => {
  await db.query(`insert into users (id, email) values ($1,'alice@local'), ($2,'bob@local')`, [
    ALICE_USER,
    BOB_USER,
  ]);
  // One Binance account per operator holds the key pair + trading environment;
  // profiles hang off the account. binance_mode lives on the account now.
  await db.query(
    `insert into accounts (id, owner_id, name, binance_mode)
     values ($1, $2, 'Main', 'test'), ($3, $4, 'Main', 'test')`,
    [ALICE_ACCOUNT, ALICE_USER, BOB_ACCOUNT, BOB_USER],
  );
  await db.query(
    `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
     values ($1, $2, 'demo', 'trailing-trade', $5, '{}', '{}'),
            ($3, $4, 'demo', 'trailing-trade', $5, '{}', '{}')`,
    [ALICE_PROFILE, ALICE_ACCOUNT, BOB_PROFILE, BOB_ACCOUNT, TRAILING_TRADE_VERSION],
  );
};

// Two resets on independent sessions must not interleave. Unserialised they
// corrupt each other two ways: one session's truncate wipes another's freshly
// seeded rows mid-reset (FK violation on the next insert), and the truncate
// CASCADE locks the FK graph profiles -> ... -> accounts -> users while seed
// inserts lock it users -> accounts -> profiles, so an opposing-order overlap is
// a lock cycle Postgres kills with `deadlock detected`. In-process `resetChain`
// only orders resets within one worker; the full suite runs workers (sessions)
// in parallel against the same DB, so the ordering must live at the DB.
//
// The wrapping TRANSACTION is what serialises: its first statement, the wide
// TRUNCATE, takes ACCESS EXCLUSIVE on every reset table and holds it until
// commit, so a second session's reset blocks until the first commits — and
// because every session runs the identical statement order there is no
// opposing-order cycle to deadlock on. `pg_advisory_xact_lock` on the same
// pooled client is order-independent defence-in-depth on top of that: it would
// still serialise if a future edit reordered the steps so a non-TRUNCATE
// statement ran first, but it is not what provides the serialisation today.
// Both release at transaction end (commit or rollback). The key is an arbitrary
// fixed integer; every session must use the same one to share the lock.
const RESET_LOCK_KEY = 918_273;

/**
 * Run the whole reset (truncate + singleton restore + optional seed) as one
 * transaction, so concurrent resets on independent connections serialise on the
 * truncate's ACCESS EXCLUSIVE locks instead of clobbering each other's rows or
 * deadlocking on opposing FK-graph lock order. The advisory lock is
 * order-independent defence-in-depth (see {@link RESET_LOCK_KEY}). Redis is
 * flushed by the caller, outside this transaction.
 */
export const resetDatabase = async (pool: Pool, opts: SetupAppOptions = {}): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock($1)', [RESET_LOCK_KEY]);
    await truncate(client);
    await resetSingletons(client);
    if (opts.seed !== false) await seed(client);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
};

/**
 * Options for {@link setupApp}. `seed: false` skips the default Alice + Bob
 * row seed so a test can exercise the onboarding sign-up path (which 403s
 * once any user exists).
 */
export interface SetupAppOptions {
  readonly seed?: boolean;
}

// Serialises the global truncate+seed across all setupApp calls in a process.
// See the comment at the call site for why interleaving is unsafe.
let resetChain: Promise<void> = Promise.resolve();

// Test app composer. Replaces the real session resolver with a header reader
// that lets each request set X-Test-User-Id explicitly.
export const setupApp = async (opts: SetupAppOptions = {}): Promise<ApiFixture> => {
  const infra = await resolveInfra();
  const logger = createPino({ level: 'silent' });
  const di = createTestDI(logger, infra);
  // All fixtures share one container DB and the reset is global. Sibling
  // describe beforeAll hooks (vitest runs same-suite hooks in parallel) can
  // otherwise interleave one fixture's truncate between another's seed and its
  // first query, dropping the seeded rows mid-test. `resetDatabase` wraps the
  // truncate+seed in one transaction, so its truncate's ACCESS EXCLUSIVE locks
  // also serialise resets on OTHER sessions/workers; this in-process chain keeps
  // same-worker resets ordered as belt-and-suspenders. flushRedis stays outside
  // the transaction.
  resetChain = resetChain.then(async () => {
    await resetDatabase(di.pool, opts);
    await flushRedis(infra.redisUrl);
  });
  await resetChain;

  const app = createApiHono();

  app.use('*', async (c, next) => {
    const u = c.req.header('x-test-user-id');
    if (u) c.set('userId', asUserId(u));
    await next();
  });
  app.use('*', audit(di));
  // Register as Hono's onError, not a wrapping middleware. The legacy
  // `errorEnvelope` try/await-next form does not see errors thrown inside
  // @hono/zod-openapi's validator wrappers (they reject before the outer
  // middleware's await resolves), so an HttpError would surface as a plain 500.
  // onError fires for the whole chain, matching production wiring.
  app.onError(errorHandler(logger));

  app.route('/api/auth', authRouter(di));
  // The same mount list production uses, so no router can be reachable in one
  // and absent from the other. The WS upgrade router is excluded there too:
  // hono/bun depends on the Bun global, which Vitest does not provide under
  // Node. WS upgrade rejection is covered by __tests__/ws-upgrade.test.ts,
  // which runs under bun and skips otherwise.
  mountApiRouters(app, di);

  return {
    app,
    di,
    redisUrl: infra.redisUrl,
    alice: { userId: ALICE_USER, accountId: ALICE_ACCOUNT, profileId: ALICE_PROFILE },
    bob: { userId: BOB_USER, accountId: BOB_ACCOUNT, profileId: BOB_PROFILE },
    cleanup: async () => {
      await di.shutdown();
    },
  };
};

export const asBob = (req: { headers: Headers }, fx: ApiFixture): Headers => {
  const h = new Headers(req.headers);
  h.set('x-test-user-id', fx.bob.userId);
  return h;
};
