// Worker-tick + audit-drain end-to-end integration test.
//
// Drives the full production wire path with a stub strategy that emits a
// single `place-order` decision per tick: enqueue tick on the real BullMQ
// queue → tick handler resolves the bindings via the real `resolveProfile`
// (DB-backed) → LiveExecutor places the order through nocked Binance →
// row persists through the typed repo → emit-event fires PUBLISH +
// events-stream XADD → tickHandler XADDs the audit entry → AuditDrainer
// COPYs the audit batch into action_logs via INSERT. The stub strategy
// (rather than `trailing-trade`) is what makes the test deterministic: TT
// will only emit a buy when its preconditions align, and threading that
// through testcontainers is not the contract we want to exercise here.
//
// Runs under TESTCONTAINERS=1 (local Docker) or DATABASE_TEST_URL+REDIS_TEST_URL
// (the CI worker-integration service containers); a leg with neither resolves
// the suite as `describe.skip` (matches the sibling integration suites).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { pino } from 'pino';
import nock from 'nock';
import { z } from 'zod';

import type { MarketDataPort } from '@app/binance';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import {
  accountRepo,
  createDb,
  migrate,
  profileRepo,
  type Database,
  type ProfileScope,
} from '@app/db';
import {
  withPostgres,
  withRedis,
  type PostgresFixture,
  type RedisFixture,
} from '@app/testcontainers';
import {
  createRegistry,
  type AccountSnapshot,
  type OpenOrder,
  type Strategy,
  type StrategyRegistry,
  type SymbolInfo,
} from '@app/strategy-core';
import { createNotifyRegistry } from '@app/notify';
import { Decimal } from '@app/money';

import { createChainByKey } from '../../src/lib/chain-by-key.js';
import { createStatePort } from '../../src/state/state-port.js';
import { createTickHandler } from '../../src/tick/tick-handler.js';
import type { ProfileTickContext } from '../../src/tick/build-tick-input.js';
import type { SnapshotColdLoad } from '../../src/tick/snapshot-loader.js';
import { createAuditShipper, createAuditDrainer } from '../../src/audit-shipper/audit-shipper.js';
import { createLiveExecutor } from '../../src/executor/live-executor.js';
import { createPlacementDedup, type PlacementDedup } from '../../src/executor/placement-dedup.js';
import { buildProfileBindings } from '../../src/profile-bindings/index.js';
import {
  buildAuditStreamKey,
  buildEventsChannel,
  buildEventsStreamKey,
} from '../../src/executor/redis-namespace.js';
import { tickJobId, QUEUE_NAMES, QUEUE_SPECS } from '../../src/queues/queue-names.js';
import type { TickJobData } from '../../src/queues/job-payloads.js';
import { errorMessage } from '@app/core/error';

// Needs BOTH Postgres and Redis: gate on both URLs so a partial local env skips
// cleanly rather than admitting the suite and then failing in withRedis() when it
// falls through to spinning a container with no Docker socket.
const HAS_INFRA =
  process.env['TESTCONTAINERS'] === '1' ||
  (Boolean(process.env['DATABASE_TEST_URL']) && Boolean(process.env['REDIS_TEST_URL']));
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const TEST_USER_ID = '00000000-0000-0000-0000-000000000abc';
const TEST_ACCOUNT_ID = '00000000-0000-0000-0000-0000000000ac';
const TEST_PROFILE_ID = '00000000-0000-0000-0000-000000000def';
const SYMBOL = 'BTCUSDT';
const TESTNET_HOST = 'https://testnet.binance.vision';

const USER = asUserId(TEST_USER_ID);
const ACCOUNT = asAccountId(TEST_ACCOUNT_ID);
const PROFILE = asProfileId(TEST_PROFILE_ID);

interface StubState {
  readonly tickCount: number;
}

const buildStubStrategy = (): Strategy<unknown, StubState> => {
  const stateSchema = z.object({ tickCount: z.number() }) as unknown as z.ZodType<StubState>;
  const empty = z.object({});
  return {
    name: 'stub-place-buy',
    version: '1.0.0',
    displayName: 'Stub place-buy',
    description: 'integration-test strategy that emits one place-order per tick',
    capabilities: { candleIntervals: ['1h'] },
    configSchema: empty as unknown as z.ZodType<unknown>,
    stateSchema,
    bundleSchema: empty as unknown as z.ZodType<Readonly<Record<string, never>>>,
    events: {},
    initialState: () => ({ tickCount: 0 }),
    tick: (input) => {
      const next: StubState = { tickCount: input.state.tickCount + 1 };
      const cid = `cid-tick-${next.tickCount}`;
      // `intent.reason` is persisted in the `orders.intent` column, which
      // is CHECK-constrained to grid-buy / grid-sell / grid-stop-loss /
      // manual. Anything else trips orders_intent_chk and the post-submit
      // bookkeeping path returns ok:false (no emit), so the test would
      // never reach the PUBLISH/events-stream assertions.
      return {
        nextState: next,
        decisions: [
          {
            type: 'place-order' as const,
            intent: {
              symbol: SYMBOL,
              side: 'BUY' as const,
              reason: 'grid-buy',
              clientOrderId: cid,
            },
            params: { type: 'MARKET' as const, quantity: '0.001' },
          },
        ],
        logs: [],
        metrics: [],
      };
    },
  };
};

interface Harness {
  readonly db: Database;
  readonly pool: Pool;
  readonly redis: Redis;
  readonly subscriber: Redis;
  readonly tickQueue: Queue<TickJobData>;
  readonly tickWorker: Worker<TickJobData>;
  readonly connection: ConnectionOptions;
  readonly pgFx: PostgresFixture;
  readonly redisFx: RedisFixture;
  readonly registry: StrategyRegistry;
  readonly notifyRegistry: ReturnType<typeof createNotifyRegistry>;
  readonly placementDedup: PlacementDedup;
  stop(): Promise<void>;
}

const seedOwner = async (pool: Pool): Promise<void> => {
  await pool.query(
    `truncate table api_keys, profile_notifiers, profiles, accounts, users, orders, action_logs restart identity cascade`,
  );
  await pool.query(`insert into users (id, email) values ($1, 'owner-134@local')`, [TEST_USER_ID]);
  // Credentials + binance_mode are per-account now; the profile hangs off the account.
  await pool.query(
    `insert into accounts (id, owner_id, name, binance_mode) values ($1, $2, 'integration-acct', 'test')`,
    [TEST_ACCOUNT_ID, TEST_USER_ID],
  );
  await pool.query(
    `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
     values ($1, $2, 'integration', 'stub-place-buy', '1.0.0', '{}'::jsonb, '{}'::jsonb)`,
    [TEST_PROFILE_ID, TEST_ACCOUNT_ID],
  );
  await pool.query(
    `insert into api_keys (account_id, key, secret, last4) values ($1, 'pk', 'sk', '1234')`,
    [TEST_ACCOUNT_ID],
  );
};

const SYMBOL_INFO: SymbolInfo = {
  symbol: SYMBOL,
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: {
    minNotional: '5',
    tickSize: '0.01',
    stepSize: '0.00001',
    minQty: '0.00001',
    maxQty: '9000',
    minPrice: '0.01',
    maxPrice: '1000000',
  },
};

const buildColdLoad = (): SnapshotColdLoad => {
  const account: AccountSnapshot = {
    balances: {
      USDT: { asset: 'USDT', free: new Decimal('10000'), locked: new Decimal(0) },
      BTC: { asset: 'BTC', free: new Decimal('0.5'), locked: new Decimal(0) },
    },
    readable: true,
  };
  return {
    loadAccount: async () => account,
    loadAccountDeployedQuote: async () => '0',
    loadOpenOrders: async (): Promise<readonly OpenOrder[]> => [],
    loadSymbolState: async () => null,
  };
};

// Stub MarketDataPort for the integration tick test. The tick path now reads
// candle windows via `port.loadWindow`; for the noop happy-path the stub
// returns an empty window, mirroring the prior `loadLatestCandles: () => []`.
const buildStubMarketDataPort = (): MarketDataPort => ({
  subscribeKlines: () => ({
    stream: {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true, value: undefined as never }),
      }),
    },
    unsubscribe: () => undefined,
  }),
  subscribeMiniTicker: () => ({
    stream: {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true, value: undefined as never }),
      }),
    },
    unsubscribe: () => undefined,
  }),
  loadWindow: async () => [],
});

const buildHarness = async (): Promise<Harness> => {
  const pgFx = await withPostgres();
  const redisFx = await withRedis();

  await migrate({ connectionString: pgFx.databaseUrl, log: () => undefined });
  const pool = new Pool({ connectionString: pgFx.databaseUrl });
  const db = createDb(pool);
  await seedOwner(pool);

  const redis = new Redis(redisFx.redisUrl, { maxRetriesPerRequest: null });
  // Drop a prior run's audit stream (and its consumer group) under the fixed
  // account/profile key. The CI Redis is fresh, but a local re-run against a
  // reused Redis would otherwise let the drainer redeliver stale pending
  // entries into `action_logs` and break the exact-count assertions.
  await redis.del(buildAuditStreamKey(ACCOUNT, PROFILE));
  const subscriber = new Redis(redisFx.redisUrl, { maxRetriesPerRequest: null });
  const redisUrlParsed = new URL(redisFx.redisUrl);
  const connection: ConnectionOptions = {
    host: redisUrlParsed.hostname,
    port: Number(redisUrlParsed.port),
  };
  const logger = pino({ level: 'silent' });

  const registry: StrategyRegistry = createRegistry();
  registry.register(buildStubStrategy());
  const notifyRegistry = createNotifyRegistry();

  const chain = createChainByKey();
  // Injected so tests can clear it between cases: the dedup persists across ticks
  // by design, and these cases deliberately re-place the same stub clientOrderId.
  const placementDedup = createPlacementDedup();
  const liveExecutor = createLiveExecutor({
    redis,
    notifyRegistry,
    strategies: registry,
    logger,
    placementDedup,
    resolveProfile: (operatorId, accountId, profileId) =>
      buildProfileBindings({ db, logger }, operatorId, accountId, profileId),
  });
  const auditShipper = createAuditShipper({ redis, logger });
  const coldLoad = buildColdLoad();
  const statePort = createStatePort({
    redis,
    logger,
    registry,
    coldLoad,
    persistSymbolState: async () => undefined,
  });

  const handler = createTickHandler({
    redis,
    registry,
    executor: liveExecutor,
    chain,
    logger,
    coldLoad,
    symbolInfoCache: { get: async () => SYMBOL_INFO },
    statePort,
    marketDataPort: buildStubMarketDataPort(),
    resolveProfile: async (
      operatorId,
      accountId,
      profileId,
      symbol,
    ): Promise<ProfileTickContext | null> => ({
      operatorId,
      accountId,
      profileId,
      // Proven scope threaded into the StatePort; the stubbed cold-load /
      // no-op persist never read `scope.db`, so the id triple suffices.
      scope: { operatorId, accountId, profileId } as unknown as ProfileScope,
      symbol,
      strategyName: 'stub-place-buy',
      strategyVersion: '2.0.0',
      config: {},
      bundleProvider: async () => ({ bundle: {} }),
      binanceMode: 'test',
      quoteAsset: 'USDT',
      weightLimit1m: 1200,
      candleInterval: '1h',
      technicalsConfig: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy' },
      needsAccountDeployedQuote: false,
      reserveBaseQuantity: null,
    }),
    auditShipper,
  });

  const tickQueue = new Queue<TickJobData>(QUEUE_NAMES.tick, { connection });
  // Drop any residual jobs a prior run left in the shared tick queue before the
  // worker attaches. The worker integration job's Redis is fresh, but a local
  // re-run against a persistent Redis would otherwise replay stale ticks into
  // this suite's worker (and hang it).
  await tickQueue.obliterate({ force: true });
  const tickWorker = new Worker<TickJobData>(QUEUE_NAMES.tick, handler, {
    connection,
    concurrency: QUEUE_SPECS.tick.concurrency,
  });

  await tickWorker.waitUntilReady();
  await tickQueue.waitUntilReady();

  return {
    db,
    pool,
    redis,
    subscriber,
    tickQueue,
    tickWorker,
    connection,
    pgFx,
    redisFx,
    registry,
    notifyRegistry,
    placementDedup,
    async stop() {
      await tickWorker.close();
      await tickQueue.close();
      await subscriber.quit().catch(() => undefined);
      await redis.quit().catch(() => undefined);
      await pool.end().catch(() => undefined);
      await redisFx.stop();
      await pgFx.stop();
    },
  };
};

const enqueueTick = async (queue: Queue<TickJobData>, cidSuffix: string): Promise<TickJobData> => {
  const data: TickJobData = {
    userId: TEST_USER_ID,
    accountId: TEST_ACCOUNT_ID,
    profileId: TEST_PROFILE_ID,
    symbol: SYMBOL,
    event: 'mini-ticker',
    enqueuedAtMs: Date.now(),
    payload: {},
  };
  await queue.add('tick', data, {
    jobId: tickJobId(TEST_PROFILE_ID, `${SYMBOL}:${cidSuffix}`),
  });
  return data;
};

const waitForCount = async (
  read: () => Promise<number>,
  target: number,
  timeoutMs = 30_000,
): Promise<number> => {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    last = await read();
    if (last >= target) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for count >= ${target}; last=${last}`);
};

describeIfInfra('worker tick + audit-drain integration', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await buildHarness();
  }, 180_000);

  afterAll(async () => {
    nock.cleanAll();
    nock.enableNetConnect();
    if (h) await h.stop();
  });

  beforeEach(() => {
    nock.disableNetConnect();
    nock.enableNetConnect((host) => host.includes('127.0.0.1') || host.startsWith('localhost'));
    // The executor's MARKET-placement dedup persists across ticks by design; the
    // stub emits a constant clientOrderId, so clear this symbol's records between
    // cases or a prior test's placement would suppress this one's.
    h.placementDedup.forgetSymbol(`${ACCOUNT}:${SYMBOL}`, Date.now());
  });

  afterEach(() => {
    // Surface any HTTP interceptor that the executor failed to hit instead
    // of silently dropping it. `nock.cleanAll()` otherwise masks a missed
    // expectation as a passing test.
    const pending = nock.pendingMocks();
    nock.cleanAll();
    if (pending.length > 0) {
      throw new Error(`unmet nock interceptors: ${JSON.stringify(pending)}`);
    }
  });

  it('happy path: one tick produces orders row + 1 PUBLISH + 1 audit XADD; drainer COPies into action_logs', async () => {
    const seededOrderId = 1_000_000_000_001;
    nock(TESTNET_HOST)
      .post('/api/v3/order')
      .query(true)
      .reply(
        200,
        {
          orderId: seededOrderId,
          clientOrderId: 'cid-tick-1',
          status: 'FILLED',
          fills: [{ price: '30000', qty: '0.001' }],
        },
        { 'X-MBX-USED-WEIGHT-1M': '10' },
      );

    // Subscribe BEFORE enqueuing the tick so the PUBLISH race is impossible.
    // Attach the listener FIRST so even a synchronous emit on the subscriber
    // connection cannot land before our handler is registered.
    const events: { channel: string; body: string }[] = [];
    const onMessage = (channel: string, body: string): void => {
      events.push({ channel, body });
    };
    h.subscriber.on('message', onMessage);
    const channel = buildEventsChannel(ACCOUNT, PROFILE);
    const subCount = await h.subscriber.subscribe(channel);
    expect(subCount).toBe(1);

    const auditStreamKey = buildAuditStreamKey(ACCOUNT, PROFILE);
    const eventsStreamKey = buildEventsStreamKey(ACCOUNT, PROFILE);

    try {
      // Pre-create the audit drainer consumer group so the tick's XADD
      // lands after `$`; otherwise drainOnce would skip the existing
      // entry. Mirror production's tolerance for BUSYGROUP (the group
      // exists from an earlier run on the shared stream) while letting
      // any other error surface immediately.
      try {
        await h.redis.xgroup('CREATE', auditStreamKey, 'audit-drainers', '$', 'MKSTREAM');
      } catch (err) {
        if (!errorMessage(err).includes('BUSYGROUP')) throw err;
      }

      // Capture baselines so the assertion is order-independent — vitest's
      // `sequence` mode can reorder without warning, and absolute counts
      // would silently pass against streams polluted by sibling tests.
      const beforeAuditLen = Number(await h.redis.xlen(auditStreamKey));
      const beforeEventsLen = Number(await h.redis.xlen(eventsStreamKey));

      const tickStartMs = Date.now();
      await enqueueTick(h.tickQueue, 'happy');

      await waitForCount(
        async () => Number(await h.redis.xlen(auditStreamKey)) - beforeAuditLen,
        1,
      );
      await waitForCount(
        async () => Number(await h.redis.xlen(eventsStreamKey)) - beforeEventsLen,
        1,
      );
      await waitForCount(async () => events.length, 1);

      // Exactly one new frame per tick — no duplicates from BullMQ
      // re-delivery or any other path. AC "XADD count matches tick count
      // exactly" for a single tick.
      expect(Number(await h.redis.xlen(auditStreamKey)) - beforeAuditLen).toBe(1);
      expect(Number(await h.redis.xlen(eventsStreamKey)) - beforeEventsLen).toBe(1);

      expect(events).toHaveLength(1);
      expect(events[0]?.channel).toBe(channel);
      // The events-channel envelope is `{ seq, topic, ts, payload }` (see
      // event-emitter.ts); the place-order handler emits on the `orders`
      // topic carrying the placed order's clientOrderId + status.
      const parsed = JSON.parse(events[0]?.body ?? '{}') as {
        topic?: string;
        payload?: { clientOrderId?: string; status?: string };
      };
      expect(parsed.topic).toBe('orders');
      expect(parsed.payload?.clientOrderId).toBe('cid-tick-1');
      expect(parsed.payload?.status).toBe('FILLED');

      // Seek-by-Binance-id is account-scoped: a Binance order id is unique per
      // account, so this lookup lives on the account repo, not the profile one.
      const a = await accountRepo(h.db, USER, ACCOUNT);
      const order = await a.orders.findByBinanceOrderId(BigInt(seededOrderId));
      expect(order).not.toBeNull();
      expect(order?.symbol).toBe(SYMBOL);
      expect(order?.status).toBe('FILLED');

      const drainer = createAuditDrainer({
        redis: h.redis,
        logger: pino({ level: 'silent' }),
        persistBatch: async (rows) => {
          for (const r of rows) {
            const rp = await profileRepo(h.db, USER, r.accountId, r.profileId);
            await rp.actionLogs.append({
              time: new Date(r.ts),
              symbol: r.symbol,
              level: 'info',
              msg: r.event,
              ctx: {
                decisionTypes: r.decisionTypes,
                clientOrderIds: r.clientOrderIds,
                latencyMs: r.latencyMs,
              },
            });
          }
        },
        enabledStreams: async () => [auditStreamKey],
        blockMs: 50,
      });

      const summary = await drainer.drainOnce();
      expect(summary.batched).toBe(1);

      // Scope the assertion to the cid this tick emitted so the row
      // count is not coupled to whatever the rest of the suite has
      // accumulated in `action_logs`. Without the cid filter, this
      // happy-path assertion would silently drift as siblings/extra
      // tests land.
      const rows = await h.pool.query<{
        profile_id: string;
        symbol: string;
        level: string;
        msg: string;
        ctx: Record<string, unknown>;
        time: Date;
      }>(
        `select profile_id, symbol, level, msg, ctx, time from action_logs
           where profile_id = $1
             and ctx -> 'clientOrderIds' @> '["cid-tick-1"]'::jsonb`,
        [TEST_PROFILE_ID],
      );
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0];
      if (!row) throw new Error('expected one action_logs row for cid-tick-1');
      expect(row.profile_id).toBe(TEST_PROFILE_ID);
      expect(row.symbol).toBe(SYMBOL);
      expect(row.level).toBe('info');
      expect(row.msg).toBe('mini-ticker');
      const ctx = row.ctx as {
        decisionTypes?: readonly string[];
        clientOrderIds?: readonly string[];
        latencyMs?: number;
      };
      expect(ctx.decisionTypes).toContain('place-order');
      expect(ctx.clientOrderIds).toContain('cid-tick-1');
      expect(typeof ctx.latencyMs).toBe('number');
      expect((ctx.latencyMs ?? -1) >= 0).toBe(true);
      // `time` should be within the recent tick window — catches a
      // clock-skew regression where the audit shipper writes `0` or
      // future-dated timestamps.
      const ageMs = Date.now() - row.time.getTime();
      expect(ageMs).toBeGreaterThanOrEqual(0);
      expect(ageMs).toBeLessThan(Date.now() - tickStartMs + 30_000);
    } finally {
      // Tear down the listener and channel subscription regardless of
      // whether assertions threw — otherwise a failure here would leak
      // pub/sub noise into every subsequent test on the shared subscriber.
      h.subscriber.off('message', onMessage);
      await h.subscriber.unsubscribe(channel);
    }
  }, 60_000);

  it('failure path: non-retryable Binance error skips persistence but still produces one audit XADD', async () => {
    // -2010 NEW_ORDER_REJECTED is non-retryable per the executor classifier.
    nock(TESTNET_HOST)
      .post('/api/v3/order')
      .query(true)
      .reply(
        400,
        { code: -2010, msg: 'Account has insufficient balance for requested action.' },
        { 'X-MBX-USED-WEIGHT-1M': '11' },
      );

    const auditStreamKey = buildAuditStreamKey(ACCOUNT, PROFILE);
    const beforeLen = Number(await h.redis.xlen(auditStreamKey));
    const beforeOrders = await h.pool.query<{ count: string }>(
      `select count(*)::text as count from orders where profile_id = $1`,
      [TEST_PROFILE_ID],
    );
    const beforeOrderCount = Number(beforeOrders.rows[0]?.count ?? '0');

    await enqueueTick(h.tickQueue, 'fail');
    await waitForCount(async () => Number(await h.redis.xlen(auditStreamKey)) - beforeLen, 1);

    const afterLen = Number(await h.redis.xlen(auditStreamKey));
    expect(afterLen - beforeLen).toBe(1);

    // No new orders row landed (placeOrder rejected before persistOrder).
    // Asserting count-delta keeps the check stable against unrelated test
    // ordering and avoids encoding a fragile `cid-tick-N` prefix.
    const afterOrders = await h.pool.query<{ count: string }>(
      `select count(*)::text as count from orders where profile_id = $1`,
      [TEST_PROFILE_ID],
    );
    expect(Number(afterOrders.rows[0]?.count ?? '0') - beforeOrderCount).toBe(0);
  }, 60_000);

  it('runtime no-locks invariant: 100 ticks back-to-back leave zero redlock or intents keys', async () => {
    // Only ONE placement reaches Binance: the stub emits a constant
    // clientOrderId, so the MARKET-placement dedup suppresses the other 99
    // re-emits (a second POST would hit an unmocked interceptor and fail).
    nock(TESTNET_HOST)
      .post('/api/v3/order')
      .query(true)
      .times(1)
      .reply(
        200,
        (_uri, requestBody: string) => {
          const cidMatch = /newClientOrderId=([^&]+)/.exec(String(requestBody));
          const cid = cidMatch?.[1] ?? `cid-bulk-${Date.now()}`;
          return {
            orderId: Number(`${Date.now()}${Math.floor(Math.random() * 1000)}`),
            clientOrderId: cid,
            status: 'FILLED',
            fills: [{ price: '30000', qty: '0.001' }],
          };
        },
        { 'X-MBX-USED-WEIGHT-1M': '15' },
      );

    const auditStreamKey = buildAuditStreamKey(ACCOUNT, PROFILE);
    const beforeLen = Number(await h.redis.xlen(auditStreamKey));

    for (let i = 0; i < 100; i += 1) {
      await enqueueTick(h.tickQueue, `bulk-${i}`);
    }

    await waitForCount(
      async () => Number(await h.redis.xlen(auditStreamKey)) - beforeLen,
      100,
      120_000,
    );

    const lockKeys = await h.redis.keys('redlock:*');
    expect(lockKeys).toEqual([]);
    const intentKeys = await h.redis.keys('intents:*');
    expect(intentKeys).toEqual([]);

    // Exactly 100 audit XADDs for 100 ticks. The audit shipper fires once
    // per tick regardless of place-order outcome, so this asserts the
    // BullMQ tick processor ran exactly 100 times (no retries, no
    // re-deliveries). The first tick places; the other 99 emit the same
    // MARKET clientOrderId and are suppressed by the placement dedup (a
    // duplicate MARKET buy freed its id at Binance and would fill again),
    // so they return ok:true without a Binance call — the tick, and its
    // audit XADD, still run. `nock.times(1)` above pins that exactly one
    // placement reached the exchange.
    const afterLen = Number(await h.redis.xlen(auditStreamKey));
    expect(afterLen - beforeLen).toBe(100);
  }, 240_000);
});
