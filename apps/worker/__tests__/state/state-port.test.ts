// StatePort boundary tests.
//
// The port wires three primitives (`loadSymbolStateForTick`,
// `commitSymbolStateForTick`, `mutateSymbolState`) that share one
// reconcile + migrate spine. These tests pin the boundary contract the
// tick handler and fill-adopter both depend on: the read reconciles a
// divergent cache against PG, the commit stamps the version the read
// settled on (never a blind strategy.version), the commit tolerates a
// failing persister, and a load→mutate→commit round-trip is equivalent
// to a single `mutate` — proving the paths cannot drift apart.

import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Redis } from 'ioredis';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { ProfileScope } from '@app/db';

import { createStatePort, type StatePortDeps } from '../../src/state/state-port.js';
import type { SymbolStateStrategyShape } from '../../src/state/version-aware-mutate.js';
import { buildSymbolStateKey } from '../../src/executor/redis-namespace.js';
import type { SnapshotColdLoad, SymbolStateRowView } from '../../src/tick/snapshot-loader.js';

const silentLogger = pino({ level: 'silent' });
const USER_ID = 'u1' as unknown as UserId;
const ACCOUNT_ID = 'a1' as unknown as AccountId;
const PROFILE_ID = 'p1' as unknown as ProfileId;
// The proven scope the tick handler threads into the port. Ownership is
// already checked upstream, so the unit test fakes it with the id triple
// the redis-key and persist paths read; `db` is unused by the stubbed
// coldLoad / persister. Credentials + user-data stream are per-account, so the
// redis key is now keyed by accountId (not operatorId).
const SCOPE = {
  operatorId: USER_ID,
  accountId: ACCOUNT_ID,
  profileId: PROFILE_ID,
} as unknown as ProfileScope;
const SYMBOL = 'BTCUSDT';
const STATE_KEY = buildSymbolStateKey(ACCOUNT_ID, PROFILE_ID, SYMBOL);

const stubRedis = () => {
  const data = new Map<string, string>();
  const redis = {
    data,
    get: vi.fn(async (k: string) => data.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      data.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (k: string) => (data.delete(k) ? 1 : 0)),
  };
  return redis as unknown as Redis & { data: Map<string, string> };
};

const stubColdLoad = (
  row: SymbolStateRowView | null,
): Pick<SnapshotColdLoad, 'loadSymbolState'> => ({
  loadSymbolState: vi.fn(async () => row),
});

// A strategy whose `migrateState` walks any older body to '1.1.0',
// tagging the hop so a test can prove the migrated PG body (not the stale
// cache) flowed through. `initialState` seeds an at-version slice.
const v110Strategy = (): SymbolStateStrategyShape => ({
  name: 'trailing-trade',
  version: '1.1.0',
  initialState: () => ({ schemaVersion: '1.1.0', seeded: true }),
  migrateState: ({ state }) => ({ ...(state as object), schemaVersion: '1.1.0', migrated: true }),
});

const buildPort = (
  overrides: Partial<StatePortDeps> & Pick<StatePortDeps, 'coldLoad' | 'persistSymbolState'>,
) =>
  createStatePort({
    redis: overrides.redis ?? stubRedis(),
    logger: silentLogger,
    registry: overrides.registry ?? { get: () => v110Strategy() },
    coldLoad: overrides.coldLoad,
    persistSymbolState: overrides.persistSymbolState,
  });

describe('StatePort.loadForTick', () => {
  it('discards a cache body whose schemaVersion diverges from PG and returns the migrated PG body', async () => {
    const redis = stubRedis();
    const pgRow: SymbolStateRowView = {
      state: { schemaVersion: '1.0.0', source: 'pg' },
      strategyVersion: '1.0.0',
      version: 7,
    };
    const persistSymbolState = vi.fn(async () => true);
    const port = buildPort({ redis, coldLoad: stubColdLoad(pgRow), persistSymbolState });

    const staleCache = JSON.stringify({ schemaVersion: '0.9.0', source: 'stale-cache' });
    const load = await port.loadForTick(SCOPE, SYMBOL, v110Strategy(), {}, staleCache);

    // PG body wins (source: 'pg'), migrated forward to the registered
    // version — the stale cache is ignored, not mutated and re-stamped.
    expect((load.state as Record<string, unknown>)['source']).toBe('pg');
    expect((load.state as Record<string, unknown>)['migrated']).toBe(true);
    // The read settled on the migrated version; the handle stamps it on
    // commit, threading the row's CAS version (7) — both captured, never
    // returned to the caller.
    await load.commit(load.state, 100);
    expect(persistSymbolState).toHaveBeenCalledWith(SCOPE, SYMBOL, load.state, '1.1.0', 7);
  });

  it('cold-loads and seeds when the durable row is missing', async () => {
    const persistSymbolState = vi.fn(async () => true);
    const port = buildPort({ coldLoad: stubColdLoad(null), persistSymbolState });

    const load = await port.loadForTick(SCOPE, SYMBOL, v110Strategy(), {}, null);

    expect(load.state).toEqual({ schemaVersion: '1.1.0', seeded: true });
    await load.commit(load.state, 100);
    // No row at read → CAS expectedVersion is null (the commit inserts at 0).
    expect(persistSymbolState).toHaveBeenCalledWith(SCOPE, SYMBOL, load.state, '1.1.0', null);
  });

  it('clears a malformed cache body and returns the PG body', async () => {
    const redis = stubRedis();
    const malformed = '{not valid json';
    redis.data.set(STATE_KEY, malformed);
    const pgRow: SymbolStateRowView = {
      state: { schemaVersion: '1.1.0', source: 'pg' },
      strategyVersion: '1.1.0',
      version: 3,
    };
    const port = buildPort({
      redis,
      coldLoad: stubColdLoad(pgRow),
      persistSymbolState: vi.fn(async () => true),
    });

    const { state } = await port.loadForTick(SCOPE, SYMBOL, v110Strategy(), {}, malformed);

    expect((state as Record<string, unknown>)['source']).toBe('pg');
    expect(redis.del).toHaveBeenCalledWith(STATE_KEY);
    expect(redis.data.has(STATE_KEY)).toBe(false);
  });

  it('trusts the cache body when its schemaVersion matches PG', async () => {
    const redis = stubRedis();
    const pgRow: SymbolStateRowView = {
      state: { schemaVersion: '1.1.0', source: 'pg' },
      strategyVersion: '1.1.0',
      version: 5,
    };
    const port = buildPort({
      redis,
      coldLoad: stubColdLoad(pgRow),
      persistSymbolState: vi.fn(async () => true),
    });

    const freshCache = JSON.stringify({ schemaVersion: '1.1.0', source: 'cache' });
    const { state } = await port.loadForTick(SCOPE, SYMBOL, v110Strategy(), {}, freshCache);

    expect((state as Record<string, unknown>)['source']).toBe('cache');
  });
});

// A non-migrating strategy at '1.0.0': lets a test prove the commit handle
// stamps the version the read settled on, not the registered strategy version.
const v100Strategy = (): SymbolStateStrategyShape => ({
  name: 'trailing-trade',
  version: '1.0.0',
  initialState: () => ({ schemaVersion: '1.0.0', seeded: true }),
  migrateState: ({ state }) => state,
});

describe('StatePort load handle commit', () => {
  it('stamps the body at the version the read settled on (not strategy.version) and refreshes the cache', async () => {
    const redis = stubRedis();
    const persistSymbolState = vi.fn(async () => true);
    // PG row at '1.0.0' read by a '1.0.0' strategy: the read settles on
    // '1.0.0', which the commit closure captures. The handler never supplies
    // a version, so it cannot stamp a mismatched one.
    const port = buildPort({
      redis,
      coldLoad: stubColdLoad({
        state: { schemaVersion: '1.0.0' },
        strategyVersion: '1.0.0',
        version: 9,
      }),
      persistSymbolState,
    });

    const load = await port.loadForTick(SCOPE, SYMBOL, v100Strategy(), {}, null);
    const next = { schemaVersion: '1.0.0', n: 7 };
    await load.commit(next, 100);

    expect(persistSymbolState).toHaveBeenCalledWith(SCOPE, SYMBOL, next, '1.0.0', 9);
    expect(redis.data.get(STATE_KEY)).toBe(JSON.stringify(next));
  });

  it('refreshes the cache to nextState when the persister stalls past the timeout', async () => {
    vi.useFakeTimers();
    try {
      const redis = stubRedis();
      // Never resolves — only the timeout race can settle the commit.
      const persistSymbolState = vi.fn(() => new Promise<boolean>(() => undefined));
      const port = buildPort({ redis, coldLoad: stubColdLoad(null), persistSymbolState });

      const load = await port.loadForTick(SCOPE, SYMBOL, v110Strategy(), {}, null);
      const next = { schemaVersion: '1.1.0', n: 2 };
      const pending = load.commit(next, 50);
      await vi.advanceTimersByTimeAsync(60);

      await expect(pending).resolves.toBeUndefined();
      // Timed-out persist refreshes the cache to nextState: the read prefers the
      // cache at equal schemaVersion, so a stale pre-tick body would break
      // read-your-writes and re-fire the next serialized tick's decision.
      expect(redis.data.get(STATE_KEY)).toBe(JSON.stringify(next));
    } finally {
      vi.useRealTimers();
    }
  });

  it('degrades to a warn and does not throw when the persister rejects', async () => {
    const redis = stubRedis();
    const persistSymbolState = vi.fn(async () => {
      throw new Error('pg unavailable');
    });
    const port = buildPort({ redis, coldLoad: stubColdLoad(null), persistSymbolState });

    const load = await port.loadForTick(SCOPE, SYMBOL, v110Strategy(), {}, null);
    const next = { schemaVersion: '1.1.0', n: 1 };
    await expect(load.commit(next, 50)).resolves.toBeUndefined();
    // Rejected persist refreshes the cache to nextState (read-your-writes);
    // single replica, so no concurrent CAS winner to revert.
    expect(redis.data.get(STATE_KEY)).toBe(JSON.stringify(next));
  });
});

// A strategy that stamps a latch field via mergeConcurrent — the CAS-miss
// reconcile the state-port dispatches on a tick commit that lost the version.
const latchStrategy = (
  mergeConcurrent: NonNullable<SymbolStateStrategyShape['mergeConcurrent']>,
): SymbolStateStrategyShape => ({
  name: 'trailing-trade',
  version: '1.1.0',
  initialState: () => ({ schemaVersion: '1.1.0', seeded: true }),
  migrateState: ({ state }) => state,
  mergeConcurrent,
});

describe('StatePort commit CAS-miss latch merge dispatch', () => {
  const winner: SymbolStateRowView = {
    state: { schemaVersion: '1.1.0', pos: 'winner' },
    strategyVersion: '1.1.0',
    version: 9,
  };

  it('on a cas-miss, grafts the tick latch onto the winner and re-writes when the strategy supports it', async () => {
    // Tick commit CAS-misses (persist #1 false), so the port re-reads the winner
    // and merges; the merged write (persist #2) lands.
    const persistSymbolState = vi
      .fn<StatePortDeps['persistSymbolState']>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const mergeConcurrent = vi.fn(({ base, latchSource }) => ({
      ...(base as object),
      latch: (latchSource as { latch: number }).latch,
    }));
    const port = buildPort({
      coldLoad: stubColdLoad(winner),
      persistSymbolState,
      registry: { get: () => latchStrategy(mergeConcurrent) },
    });

    const load = await port.loadForTick(SCOPE, SYMBOL, latchStrategy(mergeConcurrent), {}, null);
    await load.commit({ schemaVersion: '1.1.0', latch: 42 }, 100);

    // The merge saw the winner as base and the tick's next-state as latchSource.
    expect(mergeConcurrent).toHaveBeenCalledOnce();
    expect(mergeConcurrent.mock.calls[0]?.[0]).toMatchObject({
      base: { pos: 'winner' },
      latchSource: { latch: 42 },
    });
    // Two persists: the missed tick commit, then the merged latch write.
    expect(persistSymbolState).toHaveBeenCalledTimes(2);
    expect(persistSymbolState.mock.calls[1]?.[2]).toMatchObject({ pos: 'winner', latch: 42 });
  });

  it('fail-soft: a throwing latch merge does not reject the tick commit', async () => {
    // Tick commit CAS-misses (persist #1 false); the merge re-write then hits a
    // genuine persist error (dropped connection). commit must still resolve — a
    // reject would DLQ + re-run the tick. The latch is dropped, tick continues.
    const persistSymbolState = vi
      .fn<StatePortDeps['persistSymbolState']>()
      .mockResolvedValueOnce(false)
      .mockRejectedValue(new Error('pg connection dropped'));
    const mergeConcurrent = vi.fn(({ base }) => ({ ...(base as object), latch: 1 }));
    const port = buildPort({
      coldLoad: stubColdLoad(winner),
      persistSymbolState,
      registry: { get: () => latchStrategy(mergeConcurrent) },
    });

    const load = await port.loadForTick(SCOPE, SYMBOL, latchStrategy(mergeConcurrent), {}, null);
    await expect(load.commit({ schemaVersion: '1.1.0', latch: 1 }, 100)).resolves.toBeUndefined();
    expect(persistSymbolState).toHaveBeenCalledTimes(2); // missed tick commit + failed merge write
  });

  it('on a cas-miss, keeps the conservative skip when the strategy has no mergeConcurrent', async () => {
    // persist always false = permanent cas-miss; a strategy without
    // mergeConcurrent must NOT re-read/re-write — one persist only.
    const persistSymbolState = vi.fn(async () => false);
    const port = buildPort({
      coldLoad: stubColdLoad(winner),
      persistSymbolState,
      registry: { get: () => v110Strategy() },
    });

    const load = await port.loadForTick(SCOPE, SYMBOL, v110Strategy(), {}, null);
    await load.commit({ schemaVersion: '1.1.0', latch: 42 }, 100);

    expect(persistSymbolState).toHaveBeenCalledTimes(1);
  });
});

describe('StatePort load→commit equivalence with mutate', () => {
  it('produces identical durable + cache writes', async () => {
    const pgRow: SymbolStateRowView = {
      state: { schemaVersion: '1.1.0', n: 1 },
      strategyVersion: '1.1.0',
      version: 4,
    };
    const mutator = (s: unknown) => ({ ...(s as object), touched: true });

    // Run A — single mutate through the scope-based path.
    const redisA = stubRedis();
    const persistA = vi.fn(async () => true);
    const portA = buildPort({
      redis: redisA,
      coldLoad: stubColdLoad(pgRow),
      persistSymbolState: persistA,
    });
    const scope = {
      scope: { operatorId: USER_ID, accountId: ACCOUNT_ID, profileId: PROFILE_ID },
      profile: { findById: vi.fn(async () => ({ strategyName: 'trailing-trade', config: {} })) },
      symbolStates: { findBySymbol: vi.fn(async () => pgRow) },
    } as unknown as Parameters<typeof portA.mutate>[0];
    await portA.mutate(scope, SYMBOL, mutator);

    // Run B — loadForTick → mutator → load.commit (version captured, not threaded).
    const redisB = stubRedis();
    const persistB = vi.fn(async () => true);
    const portB = buildPort({
      redis: redisB,
      coldLoad: stubColdLoad(pgRow),
      persistSymbolState: persistB,
    });
    const load = await portB.loadForTick(SCOPE, SYMBOL, v110Strategy(), {}, null);
    await load.commit(mutator(load.state), 100);

    expect(persistB.mock.calls[0]).toEqual(persistA.mock.calls[0]);
    expect(redisB.data.get(STATE_KEY)).toBe(redisA.data.get(STATE_KEY));
  });
});
