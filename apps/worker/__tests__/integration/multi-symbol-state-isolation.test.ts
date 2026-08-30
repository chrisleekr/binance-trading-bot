// Multi-symbol state isolation integration test.
//
// Drives three concurrent ticks through the real tick handler against
// real Postgres + Redis (testcontainers). Each tick is for a different
// symbol on the same profile; the stub strategy returns a per-symbol
// next-state body marked with the symbol it received. The test then
// asserts each `symbol_states` row carries its own marker — locking the
// per-(profile, symbol) storage invariant.
//
// Pre-cutover (flat per-profile state) this test would fail: all three
// ticks would clobber a single row and only one symbol's marker would
// survive. Post-cutover the rows are independent and all three markers
// land.

import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { pino } from 'pino';
import { z } from 'zod';

import type { MarketDataPort } from '@app/binance';
import { asAccountId, asProfileId } from '@app/contracts';
import { migrate, type ProfileScope } from '@app/db';
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
import { Decimal } from '@app/money';

import { createChainByKey } from '../../src/lib/chain-by-key.js';
import { createStatePort } from '../../src/state/state-port.js';
import { createTickHandler } from '../../src/tick/tick-handler.js';
import type { ProfileTickContext } from '../../src/tick/build-tick-input.js';
import type { SnapshotColdLoad } from '../../src/tick/snapshot-loader.js';
import { createAuditShipper } from '../../src/audit-shipper/audit-shipper.js';
import { buildSymbolStateKey } from '../../src/executor/redis-namespace.js';
import { tickJobId, QUEUE_NAMES, QUEUE_SPECS } from '../../src/queues/queue-names.js';
import type { TickJobData } from '../../src/queues/job-payloads.js';

import { describeInfra } from './_infra-gate.js';

const TEST_USER_ID = '00000000-0000-0000-0000-0000000000a1';
const TEST_ACCOUNT_ID = '00000000-0000-0000-0000-0000000000c1';
const TEST_PROFILE_ID = '00000000-0000-0000-0000-0000000000b1';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const;

// Stub strategy: each tick returns a next-state body that records the
// symbol the strategy saw on `input.market.symbol` and a per-symbol
// price marker (so a cross-symbol leak shows up as a price mismatch in
// addition to the symbol marker). No side-effects — the contract under
// test is purely the per-symbol persist path.
interface SymbolMarkerState {
  readonly schemaVersion: '2.0.0';
  readonly markerSymbol: string | null;
  readonly markerPrice: string | null;
  readonly tickCount: number;
}

const buildStubStrategy = (): Strategy<unknown, SymbolMarkerState> => {
  const stateSchema = z.object({
    schemaVersion: z.literal('2.0.0'),
    markerSymbol: z.string().nullable(),
    markerPrice: z.string().nullable(),
    tickCount: z.number(),
  }) as unknown as z.ZodType<SymbolMarkerState>;
  const empty = z.object({});
  return {
    name: 'symbol-marker-stub',
    version: '2.0.0',
    displayName: 'Symbol-marker stub',
    description: 'integration-test strategy that stamps the per-symbol slice with its symbol',
    capabilities: {
      candleIntervals: ['1h'],
      needsUserDataStream: false,
      needsMiniTicker: false,
      bundleProviders: [],
      operatorActions: [],
    },
    configSchema: empty,
    overrideConfigSchema: empty,
    stateSchema,
    bundleSchema: empty as unknown as z.ZodType<Readonly<Record<string, never>>>,
    events: {},
    defaultConfig: {},
    previewLevels: () => ({ sections: [] }),
    initialState: () => ({
      schemaVersion: '2.0.0',
      markerSymbol: null,
      markerPrice: null,
      tickCount: 0,
    }),
    tick: (input) => {
      const prior = input.state;
      const next: SymbolMarkerState = {
        schemaVersion: '2.0.0',
        markerSymbol: input.market.symbol,
        // currentPrice comes from the candle window we seed below; the
        // marker would equal '0' if the handler routed the wrong
        // symbol's candles to this tick.
        markerPrice: input.market.currentPrice,
        tickCount: prior.tickCount + 1,
      };
      return { nextState: next, decisions: [], logs: [], metrics: [] };
    },
  };
};

// Per-symbol symbol-info. Keyed by the symbol the tick handler passes in
// so a stuck tick cannot pull another symbol's symbol_info (which would
// mask a routing bug).
const infoFor = (symbol: string): SymbolInfo => ({
  symbol,
  baseAsset: symbol.replace('USDT', ''),
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
});

const buildColdLoad = (): SnapshotColdLoad => {
  const account: AccountSnapshot = {
    balances: {
      USDT: { asset: 'USDT', free: new Decimal('100000'), locked: new Decimal(0) },
    },
    readable: true,
  };
  return {
    loadAccount: async () => account,
    loadAccountDeployedQuote: async () => '0',
    loadOpenOrders: async (): Promise<readonly OpenOrder[]> => [],
    loadSymbolState: async () => null,
    loadProfileKv: async () => ({}),
  };
};

// Per-symbol candle window keyed by the symbol the tick handler passes
// in. Each symbol gets a distinct closing price so the strategy's
// `markerPrice` write per-row reveals a routing leak.
const PRICE_BY_SYMBOL: Readonly<Record<string, string>> = {
  BTCUSDT: '70000',
  ETHUSDT: '3500',
  SOLUSDT: '150',
};

const buildMarketDataPort = (): MarketDataPort => ({
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
  loadWindow: async (symbol) => {
    const close = PRICE_BY_SYMBOL[symbol] ?? '0';
    // Single candle is enough — strategy reads currentPrice off the
    // most-recent close, not a window aggregate.
    return [
      {
        openTimeMs: 1_700_000_000_000,
        closeTimeMs: 1_700_000_000_000 + 60_000,
        open: close,
        high: close,
        low: close,
        close,
        volume: '1',
        isClosed: true as const,
      },
    ];
  },
});

interface Harness {
  readonly pool: Pool;
  readonly redis: Redis;
  readonly tickQueue: Queue<TickJobData>;
  readonly tickWorker: Worker<TickJobData>;
  readonly connection: ConnectionOptions;
  readonly pgFx: PostgresFixture;
  readonly redisFx: RedisFixture;
  readonly registry: StrategyRegistry;
}

const seedOwner = async (pool: Pool): Promise<void> => {
  // Truncate any prior fixtures so re-runs are deterministic. Cascade from
  // `accounts` covers child rows in `profiles`, `symbol_states`, and `api_keys`.
  await pool.query(
    `truncate table api_keys, profile_notifiers, symbol_states, profiles, accounts, users, orders, action_logs restart identity cascade`,
  );
  await pool.query(`insert into users (id, email) values ($1, 'owner-msi@local')`, [TEST_USER_ID]);
  // `binance_mode` and the API key pair live on the account; profiles hang off it.
  await pool.query(
    `insert into accounts (id, owner_id, name, binance_mode) values ($1, $2, 'multi-symbol-acct', 'test')`,
    [TEST_ACCOUNT_ID, TEST_USER_ID],
  );
  await pool.query(
    `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
     values ($1, $2, 'multi-symbol-iso', 'symbol-marker-stub', '2.0.0', '{}'::jsonb, '{}'::jsonb)`,
    [TEST_PROFILE_ID, TEST_ACCOUNT_ID],
  );
  await pool.query(
    `insert into api_keys (account_id, key, secret, last4) values ($1, 'pk', 'sk', '1234')`,
    [TEST_ACCOUNT_ID],
  );
};

// Mirrors the production `persistSymbolState` writer (the `symbolStates.casUpsert`
// repo path) without dragging in the boot bootstrap. The version-aware CAS is the
// commit contract the tick relies on: `expectedVersion === null` seeds a fresh row
// at version 0 (a row that appeared concurrently makes the insert a no-op miss),
// otherwise it bumps `version = N + 1` only while the row is still at `N`. The
// boolean return is what `commitSymbolStateForTick` reads to decide `applied`; a
// void return would leave `applied` undefined and the Redis mirror unwritten.
// Replicating the SQL here keeps the test focused on the per-symbol routing
// invariant rather than the boot-context wiring. Reads only the profileId off the
// proven `scope` (this stub uses raw SQL, not `scope.db`).
const buildPersistSymbolState = (pool: Pool) => {
  return async (
    scope: ProfileScope,
    symbol: string,
    nextState: unknown,
    nextStrategyVersion: string,
    expectedVersion: number | null,
  ): Promise<boolean> => {
    if (expectedVersion === null) {
      const { rowCount } = await pool.query(
        `insert into symbol_states (profile_id, symbol, state, strategy_version, version)
         values ($1, $2, $3::jsonb, $4, 0)
         on conflict (profile_id, symbol) do nothing`,
        [scope.profileId, symbol, JSON.stringify(nextState), nextStrategyVersion],
      );
      return (rowCount ?? 0) > 0;
    }
    const { rowCount } = await pool.query(
      `update symbol_states
         set state = $3::jsonb, strategy_version = $4, version = $5 + 1, updated_at = now()
       where profile_id = $1 and symbol = $2 and version = $5`,
      [scope.profileId, symbol, JSON.stringify(nextState), nextStrategyVersion, expectedVersion],
    );
    return (rowCount ?? 0) > 0;
  };
};

// Every resource `buildHarness` opens is registered here the moment it exists, so a builder that throws part-way can still be unwound. Registering at construction rather than in the returned Harness is the whole point: a handle held only by a frame that unwinds is a container that runs for the rest of the session, and — worse — an ioredis client on `maxRetriesPerRequest: null` that reconnects forever and holds the vitest process open. That turns a legible `beforeAll` failure into a hang, the exact outcome this lane exists to remove. Ryuk still reaps the containers at session exit, so for those this bounds the leak to the run rather than removing it.
//
// It is also the only teardown order: newest-first unwinding derives from construction order, so a resource added later cannot be forgotten by a hand-maintained close list that no longer matches.
const opened: Array<() => Promise<void>> = [];

/**
 * Closes everything `buildHarness` opened, newest first, whether or not it ran to completion. Draining the stack makes a second call a no-op.
 *
 * @returns A promise that settles once every registered resource has been asked to close.
 */
const closeOpened = async (): Promise<void> => {
  for (let close = opened.pop(); close !== undefined; close = opened.pop()) {
    // Swallowed individually: sequenced bare, the first rejection returns from this loop and strands everything registered below it. A close that fails is not the suite's result — the assertions have already run.
    await close().catch(() => undefined);
  }
};

const buildHarness = async (): Promise<Harness> => {
  const pgFx = await withPostgres();
  opened.push(pgFx.stop);
  const redisFx = await withRedis();
  opened.push(redisFx.stop);

  await migrate({ connectionString: pgFx.databaseUrl, log: () => undefined });
  const pool = new Pool({ connectionString: pgFx.databaseUrl });
  opened.push(async () => {
    await pool.end();
  });
  await seedOwner(pool);

  const redis = new Redis(redisFx.redisUrl, { maxRetriesPerRequest: null });
  opened.push(async () => {
    await redis.quit();
  });
  const redisUrlParsed = new URL(redisFx.redisUrl);
  const connection: ConnectionOptions = {
    host: redisUrlParsed.hostname,
    port: Number(redisUrlParsed.port),
  };
  const logger = pino({ level: 'silent' });

  const registry: StrategyRegistry = createRegistry();
  registry.register(buildStubStrategy());

  const chain = createChainByKey();
  const auditShipper = createAuditShipper({ redis, logger });
  const coldLoad = buildColdLoad();
  const statePort = createStatePort({
    redis,
    logger,
    registry,
    coldLoad,
    persistSymbolState: buildPersistSymbolState(pool),
  });

  // Minimal executor: the stub strategy emits zero decisions so
  // `applyAll` only needs to return an empty array. A no-op keeps the
  // test surface scoped to state isolation; the Binance round-trip is
  // covered by `tick-and-audit-drain.test.ts`.
  const noopExecutor = {
    applyAll: async () => [] as const,
  } as unknown as Parameters<typeof createTickHandler>[0]['executor'];

  const handler = createTickHandler({
    redis,
    registry,
    executor: noopExecutor,
    chain,
    logger,
    coldLoad,
    symbolInfoCache: { get: async (symbol) => infoFor(symbol) },
    statePort,
    marketDataPort: buildMarketDataPort(),
    resolveProfile: async (
      operatorId,
      accountId,
      profileId,
      symbol,
    ): Promise<ProfileTickContext | null> => ({
      operatorId,
      accountId,
      profileId,
      // The proven scope the tick threads into the StatePort; this stub
      // skips the real ownership read, so the id triple is enough (the raw-SQL
      // persist + null cold-load never touch `scope.db`).
      scope: { operatorId, accountId, profileId } as unknown as ProfileScope,
      symbol,
      strategyName: 'symbol-marker-stub',
      strategyVersion: '2.0.0',
      config: {},
      bundleProvider: async () => ({ bundle: {} }),
      binanceMode: 'test',
      quoteAsset: 'USDT',
      weightLimit1m: 1200,
      candleInterval: '1h',
      technicalsConfig: {
        useOnlyWithinMin: 2,
        ifExpires: 'do-not-buy',
        entryConfirmReads: 1,
        intervals: [],
      },
      needsAccountDeployedQuote: false,
    }),
    auditShipper,
  });

  const tickQueue = new Queue<TickJobData>(QUEUE_NAMES.tick, { connection });
  opened.push(async () => {
    await tickQueue.close();
  });
  // Drop any residual jobs a prior run left in the shared tick queue before the
  // worker attaches. The worker integration job's Redis is fresh, but a local
  // re-run against a persistent Redis would otherwise replay stale ticks into
  // this suite's worker (and hang it).
  await tickQueue.obliterate({ force: true });
  // concurrency = SYMBOLS.length so the three jobs can actually run in
  // parallel. The handler's own per-(profile, symbol) chain keeps writes
  // for the same symbol serial; the test is exercising the cross-symbol
  // path, which BullMQ's concurrency=1 default would serialise out of.
  const tickWorker = new Worker<TickJobData>(QUEUE_NAMES.tick, handler, {
    connection,
    concurrency: Math.max(SYMBOLS.length, QUEUE_SPECS.tick.concurrency),
  });
  opened.push(async () => {
    await tickWorker.close();
  });

  await tickWorker.waitUntilReady();
  await tickQueue.waitUntilReady();

  return {
    pool,
    redis,
    tickQueue,
    tickWorker,
    connection,
    pgFx,
    redisFx,
    registry,
  };
};

const enqueueTick = async (
  queue: Queue<TickJobData>,
  symbol: string,
  cidSuffix: string,
): Promise<void> => {
  const data: TickJobData = {
    userId: TEST_USER_ID,
    accountId: TEST_ACCOUNT_ID,
    profileId: TEST_PROFILE_ID,
    symbol,
    event: 'mini-ticker',
    enqueuedAtMs: Date.now(),
    payload: {},
  };
  await queue.add('tick', data, {
    jobId: tickJobId(TEST_PROFILE_ID, `${symbol}:${cidSuffix}`),
  });
};

const waitForRowCount = async (pool: Pool, target: number, timeoutMs = 30_000): Promise<number> => {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text as count from symbol_states where profile_id = $1`,
      [TEST_PROFILE_ID],
    );
    last = Number(rows[0]?.count ?? '0');
    if (last >= target) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for symbol_states rows >= ${target}; last=${last}`);
};

describeInfra('both', 'multi-symbol state isolation — per-(profile, symbol) slice', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await buildHarness();
  }, 180_000);

  afterAll(async () => {
    await closeOpened();
  });

  beforeEach(async () => {
    // Reset symbol_states between runs so the row-count assertion
    // doesn't accumulate across describe-block re-runs in watch mode.
    await h.pool.query(`delete from symbol_states where profile_id = $1`, [TEST_PROFILE_ID]);
  });

  it('three concurrent ticks for BTC + ETH + SOL land three disjoint symbol_states rows', async () => {
    await Promise.all(SYMBOLS.map((sym, i) => enqueueTick(h.tickQueue, sym, `iso-${i}`)));

    await waitForRowCount(h.pool, SYMBOLS.length);

    const { rows } = await h.pool.query<{
      symbol: string;
      state: Record<string, unknown>;
      strategy_version: string;
    }>(
      `select symbol, state, strategy_version from symbol_states where profile_id = $1 order by symbol`,
      [TEST_PROFILE_ID],
    );

    expect(rows.map((r) => r.symbol).sort()).toEqual([...SYMBOLS].sort());

    for (const row of rows) {
      // Each row's body carries its OWN symbol marker. A flat-state
      // regression would land the last-tick's symbol on every row.
      expect(row.state['markerSymbol']).toBe(row.symbol);
      expect(row.state['markerPrice']).toBe(PRICE_BY_SYMBOL[row.symbol]);
      expect(row.state['schemaVersion']).toBe('2.0.0');
      expect(row.state['tickCount']).toBe(1);
      expect(row.strategy_version).toBe('2.0.0');
    }

    // Redis mirror — `tick-handler` writes the per-symbol cache key
    // alongside the durable PG row. A divergence here would mean the
    // cold-load on the next tick rehydrates the wrong slice.
    for (const sym of SYMBOLS) {
      const cached = await h.redis.get(
        buildSymbolStateKey(asAccountId(TEST_ACCOUNT_ID), asProfileId(TEST_PROFILE_ID), sym),
      );
      expect(cached).not.toBeNull();
      const parsed = JSON.parse(String(cached)) as Record<string, unknown>;
      expect(parsed['markerSymbol']).toBe(sym);
      expect(parsed['markerPrice']).toBe(PRICE_BY_SYMBOL[sym]);
    }
  }, 60_000);
});
