// Contract tests for `mutateSymbolState`, the version-safe per-(profile,
// symbol) state-mutation primitive.
//
// Each test stubs the persistence layer (profileRepo scope / symbolStates
// finder / Redis / registry / persistSymbolState) and asserts the
// helper's read-pick-migrate-persist behaviour against the documented
// invariants in the module header.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import type { ProfileScope } from '@app/db';

import {
  commitSymbolStateForTick,
  mergeLatchFieldsOnCasMiss,
  mutateSymbolState,
  type LatchMergeStrategy,
} from '../../src/state/version-aware-mutate.js';
import type { SymbolStateRowView } from '../../src/tick/snapshot-loader.js';
import { buildSymbolStateKey } from '../../src/executor/redis-namespace.js';

const silentLogger = new Proxy({} as Logger, { get: () => () => undefined }) as Logger;

const userId = asUserId('00000000-0000-0000-0000-000000000001');
const accountId = asAccountId('00000000-0000-0000-0000-000000000003');
const profileId = asProfileId('00000000-0000-0000-0000-000000000002');
const symbol = 'BTCUSDT';
// Credentials + user-data stream are per-account, so the state redis key is
// keyed by accountId (not operatorId).
const stateKey = buildSymbolStateKey(accountId, profileId, symbol);
// The proven scope the tick handler threads into the commit path. `db` is
// unused here (the persister is stubbed); the redis-key + metric paths read
// only the id triple.
const scopeFor = (aid = accountId, pid = profileId) =>
  ({ operatorId: userId, accountId: aid, profileId: pid }) as unknown as ProfileScope;
const SCOPE = scopeFor();

interface RedisLite {
  store: Map<string, string>;
}

const makeRedis = (): { redis: Redis; rs: RedisLite } => {
  const rs: RedisLite = { store: new Map() };
  const redis = {
    get: vi.fn(async (k: string) => rs.store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      rs.store.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (k: string) => {
      const had = rs.store.delete(k);
      return had ? 1 : 0;
    }),
  } as unknown as Redis;
  return { redis, rs };
};

interface SymbolRowLike {
  state: unknown;
  strategyVersion: string;
}

const makeScope = (
  profile: { strategyName: string; config?: unknown },
  symbolRow: SymbolRowLike | null,
) => ({
  scope: { operatorId: userId, accountId, profileId },
  profile: {
    findById: vi.fn(async () => profile),
  },
  symbolStates: {
    findBySymbol: vi.fn(async () => symbolRow),
  },
});

const stratWith = (
  version: string,
  extras: Partial<{
    migrateState: (input: { fromVersion: string; state: unknown }) => unknown;
    initialState: (cfg: unknown) => unknown;
  }> = {},
) => ({
  name: 'trailing-trade',
  version,
  initialState: extras.initialState ?? (() => ({ schemaVersion: version })),
  migrateState: extras.migrateState,
});

describe('mutateSymbolState', () => {
  it('migrates a stale Redis cache shape to current version before mutating', async () => {
    // Operator wrote 1.1.0 to PG directly while the worker was running;
    // Redis still carries the cached 1.0.0 shape. Without #261 the
    // mutate would write 1.0.0 back over the strategy_version=1.1.0
    // stamp.
    const { redis, rs } = makeRedis();
    rs.store.set(stateKey, JSON.stringify({ schemaVersion: '1.0.0', lastBuyPrice: '50000' }));
    const scope = makeScope(
      { strategyName: 'trailing-trade', config: {} },
      {
        state: { schemaVersion: '1.1.0', lastBuyPrice: '50000', heldQuantity: '1' },
        strategyVersion: '1.1.0',
      },
    );

    const persistSymbolState = vi.fn(async () => true);
    const registry = { get: vi.fn(() => stratWith('1.1.0', { migrateState: vi.fn() })) };

    await mutateSymbolState(
      { redis, logger: silentLogger, registry, persistSymbolState },
      scope as never,
      symbol,
      (state) => ({ ...(state as Record<string, unknown>), lastBuyPrice: '51000' }),
    );

    expect(persistSymbolState).toHaveBeenCalledOnce();
    const call = persistSymbolState.mock.calls[0] ?? [];
    expect(call[1]).toBe(symbol);
    expect(call[2]).toMatchObject({ schemaVersion: '1.1.0', lastBuyPrice: '51000' });
    expect(call[3]).toBe('1.1.0');
    const cachedAfter = rs.store.get(stateKey);
    expect(cachedAfter).toBeDefined();
    expect(JSON.parse(cachedAfter ?? '{}')).toMatchObject({ lastBuyPrice: '51000' });
  });

  it('runs strategy.migrateState when strategy_version lags the registered version', async () => {
    const { redis } = makeRedis();
    const scope = makeScope(
      { strategyName: 'trailing-trade', config: {} },
      { state: { schemaVersion: '1.0.0', lastBuyPrice: null }, strategyVersion: '1.0.0' },
    );

    const persistSymbolState = vi.fn(async () => true);
    const migrateState = vi.fn(({ state }) => ({
      ...(state as Record<string, unknown>),
      schemaVersion: '1.1.0',
      heldQuantity: null,
    }));
    const registry = { get: vi.fn(() => stratWith('1.1.0', { migrateState })) };

    await mutateSymbolState(
      { redis, logger: silentLogger, registry, persistSymbolState },
      scope as never,
      symbol,
      (state) => ({ ...(state as Record<string, unknown>), lastBuyPrice: '99999' }),
    );

    expect(migrateState).toHaveBeenCalledOnce();
    expect(persistSymbolState).toHaveBeenCalledOnce();
    const call = persistSymbolState.mock.calls[0] ?? [];
    expect(call[2]).toMatchObject({
      schemaVersion: '1.1.0',
      heldQuantity: null,
      lastBuyPrice: '99999',
    });
    expect(call[3]).toBe('1.1.0');
  });

  it('seeds initialState when no symbol_states row exists and persists the seed even on null mutate', async () => {
    // First fill on a brand-new symbol: no durable row yet. The mutator
    // must operate on the strategy's `initialState(config)` and the
    // seed should land on disk so the next call finds a real row.
    const { redis } = makeRedis();
    const scope = makeScope({ strategyName: 'trailing-trade', config: { foo: 'bar' } }, null);

    const persistSymbolState = vi.fn(async () => true);
    const initialState = vi.fn((cfg: unknown) => ({
      schemaVersion: '1.1.0',
      config: cfg,
      lastBuyPrice: null,
    }));
    const registry = { get: vi.fn(() => stratWith('1.1.0', { initialState })) };

    await mutateSymbolState(
      { redis, logger: silentLogger, registry, persistSymbolState },
      scope as never,
      symbol,
      () => null, // no mutation, just seed
    );

    expect(initialState).toHaveBeenCalledWith({ foo: 'bar' });
    expect(persistSymbolState).toHaveBeenCalledOnce();
    const call = persistSymbolState.mock.calls[0] ?? [];
    expect(call[2]).toMatchObject({ schemaVersion: '1.1.0', config: { foo: 'bar' } });
    expect(call[3]).toBe('1.1.0');
  });

  it('returns no-op without writing when mutate returns null and a durable at-version row exists', async () => {
    const { redis, rs } = makeRedis();
    rs.store.set(stateKey, JSON.stringify({ schemaVersion: '1.1.0', stable: true }));
    const scope = makeScope(
      { strategyName: 'trailing-trade', config: {} },
      { state: { schemaVersion: '1.1.0', stable: true }, strategyVersion: '1.1.0' },
    );

    const persistSymbolState = vi.fn(async () => true);
    const registry = { get: vi.fn(() => stratWith('1.1.0')) };

    await mutateSymbolState(
      { redis, logger: silentLogger, registry, persistSymbolState },
      scope as never,
      symbol,
      () => null,
    );

    expect(persistSymbolState).not.toHaveBeenCalled();
  });

  it('persists the migrated shape even when mutate returns null, so a future call does not re-migrate', async () => {
    const { redis } = makeRedis();
    const scope = makeScope(
      { strategyName: 'trailing-trade', config: {} },
      { state: { schemaVersion: '1.0.0' }, strategyVersion: '1.0.0' },
    );

    const persistSymbolState = vi.fn(async () => true);
    const migrateState = vi.fn(({ state }) => ({
      ...(state as Record<string, unknown>),
      schemaVersion: '1.1.0',
      heldQuantity: null,
    }));
    const registry = { get: vi.fn(() => stratWith('1.1.0', { migrateState })) };

    await mutateSymbolState(
      { redis, logger: silentLogger, registry, persistSymbolState },
      scope as never,
      symbol,
      () => null,
    );

    expect(migrateState).toHaveBeenCalledOnce();
    expect(persistSymbolState).toHaveBeenCalledOnce();
    const call = persistSymbolState.mock.calls[0] ?? [];
    expect(call[2]).toMatchObject({ schemaVersion: '1.1.0' });
    expect(call[3]).toBe('1.1.0');
  });

  it('clears a malformed Redis cache entry and falls back to PG body', async () => {
    const { redis, rs } = makeRedis();
    rs.store.set(stateKey, '{ this is not json }');
    const scope = makeScope(
      { strategyName: 'trailing-trade', config: {} },
      { state: { schemaVersion: '1.1.0', lastBuyPrice: '10' }, strategyVersion: '1.1.0' },
    );

    const persistSymbolState = vi.fn(async () => true);
    const registry = { get: vi.fn(() => stratWith('1.1.0')) };

    await mutateSymbolState(
      { redis, logger: silentLogger, registry, persistSymbolState },
      scope as never,
      symbol,
      (state) => ({ ...(state as Record<string, unknown>), lastBuyPrice: '11' }),
    );

    expect(redis.del).toHaveBeenCalledWith(stateKey);
    expect(persistSymbolState).toHaveBeenCalledOnce();
    expect(persistSymbolState.mock.calls[0]?.[2]).toMatchObject({ lastBuyPrice: '11' });
  });

  it('refuses to write if the strategy registry has no entry for the profile', async () => {
    const { redis } = makeRedis();
    const scope = makeScope(
      { strategyName: 'ghost-strategy', config: {} },
      { state: { schemaVersion: '1.0.0' }, strategyVersion: '1.0.0' },
    );

    const persistSymbolState = vi.fn(async () => true);
    const registry = { get: vi.fn(() => undefined) };

    await mutateSymbolState(
      { redis, logger: silentLogger, registry, persistSymbolState },
      scope as never,
      symbol,
      (state) => ({ ...(state as Record<string, unknown>), touched: true }),
    );

    expect(persistSymbolState).not.toHaveBeenCalled();
  });

  it('throws on migration failure so callers can release any side-effects', async () => {
    // A silent no-op on migration failure would leave the slice carrying
    // divergent state while the caller treats the mutation as committed.
    // Throwing pushes the recovery decision to the caller.
    const { redis, rs } = makeRedis();
    rs.store.set(stateKey, JSON.stringify({ schemaVersion: '1.0.0' }));
    const scope = makeScope(
      { strategyName: 'trailing-trade', config: {} },
      { state: { schemaVersion: '1.0.0' }, strategyVersion: '1.0.0' },
    );

    const persistSymbolState = vi.fn(async () => true);
    const migrateState = vi.fn(() => {
      throw new Error('boom');
    });
    const registry = { get: vi.fn(() => stratWith('1.1.0', { migrateState })) };

    await expect(
      mutateSymbolState(
        { redis, logger: silentLogger, registry, persistSymbolState },
        scope as never,
        symbol,
        (state) => state,
      ),
    ).rejects.toThrow(/migration to 1\.1\.0 failed/);

    expect(persistSymbolState).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(rs.store.get(stateKey)).toBe(JSON.stringify({ schemaVersion: '1.0.0' }));
  });

  it('concurrent mutates on two different symbols of the same profile write disjoint slices', async () => {
    // Issue #275 acceptance: a BUY on BTCUSDT and a BUY on ETHUSDT run
    // concurrently. The helper must read/write each symbol's own
    // symbol_states row and Redis key; no cross-symbol clobber.
    const { redis, rs } = makeRedis();

    const symbolRows = new Map<string, SymbolRowLike>([
      [
        'BTCUSDT',
        { state: { schemaVersion: '1.1.0', lastBuyPrice: '50000' }, strategyVersion: '1.1.0' },
      ],
      [
        'ETHUSDT',
        { state: { schemaVersion: '1.1.0', lastBuyPrice: '2000' }, strategyVersion: '1.1.0' },
      ],
    ]);

    const scope = {
      scope: { operatorId: userId, accountId, profileId },
      profile: { findById: vi.fn(async () => ({ strategyName: 'trailing-trade', config: {} })) },
      symbolStates: {
        findBySymbol: vi.fn(async (sym: string) => symbolRows.get(sym) ?? null),
      },
    };

    const persistSymbolState = vi.fn(async () => true);
    const registry = { get: vi.fn(() => stratWith('1.1.0')) };

    await Promise.all([
      mutateSymbolState(
        { redis, logger: silentLogger, registry, persistSymbolState },
        scope as never,
        'BTCUSDT',
        (state) => ({ ...(state as Record<string, unknown>), lastBuyPrice: '60000' }),
      ),
      mutateSymbolState(
        { redis, logger: silentLogger, registry, persistSymbolState },
        scope as never,
        'ETHUSDT',
        (state) => ({ ...(state as Record<string, unknown>), lastBuyPrice: '3000' }),
      ),
    ]);

    expect(persistSymbolState).toHaveBeenCalledTimes(2);
    const calls = persistSymbolState.mock.calls;
    const bySymbol = new Map(calls.map((c) => [c[1] as string, c]));
    expect(bySymbol.get('BTCUSDT')?.[2]).toMatchObject({ lastBuyPrice: '60000' });
    expect(bySymbol.get('ETHUSDT')?.[2]).toMatchObject({ lastBuyPrice: '3000' });
    const btcKey = buildSymbolStateKey(accountId, profileId, 'BTCUSDT');
    const ethKey = buildSymbolStateKey(accountId, profileId, 'ETHUSDT');
    expect(JSON.parse(rs.store.get(btcKey) ?? '{}')).toMatchObject({ lastBuyPrice: '60000' });
    expect(JSON.parse(rs.store.get(ethKey) ?? '{}')).toMatchObject({ lastBuyPrice: '3000' });
  });

  it('re-reads and re-applies the mutator on a CAS miss, then succeeds on the fresh body', async () => {
    // A concurrent writer advanced `version` between our read and our write, so
    // the first persist is a CAS miss (false). The loop re-reads the winner's
    // body (version 6, n=2) and re-applies the mutator on top of it.
    const { redis } = makeRedis();
    let reads = 0;
    const scope = {
      scope: { operatorId: userId, accountId, profileId },
      profile: { findById: vi.fn(async () => ({ strategyName: 'trailing-trade', config: {} })) },
      symbolStates: {
        findBySymbol: vi.fn(async () => {
          reads += 1;
          return {
            state: { schemaVersion: '1.1.0', n: reads },
            strategyVersion: '1.1.0',
            version: reads === 1 ? 5 : 6,
          };
        }),
      },
    };
    const persistSymbolState = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const registry = { get: vi.fn(() => stratWith('1.1.0')) };
    const seenBodies: number[] = [];

    await mutateSymbolState(
      { redis, logger: silentLogger, registry, persistSymbolState },
      scope as never,
      symbol,
      (state) => {
        seenBodies.push((state as { n: number }).n);
        return { ...(state as Record<string, unknown>), touched: true };
      },
    );

    expect(persistSymbolState).toHaveBeenCalledTimes(2); // miss, then win
    expect(seenBodies).toEqual([1, 2]); // second apply saw the winner's fresh body
    // The retry's write carried the fresh CAS token (6) it re-read.
    expect(persistSymbolState.mock.calls[1]?.[4]).toBe(6);
  });

  it('throws after MAX_CAS_RETRIES consecutive CAS misses', async () => {
    const { redis } = makeRedis();
    const scope = {
      scope: { operatorId: userId, accountId, profileId },
      profile: { findById: vi.fn(async () => ({ strategyName: 'trailing-trade', config: {} })) },
      symbolStates: {
        findBySymbol: vi.fn(async () => ({
          state: { schemaVersion: '1.1.0' },
          strategyVersion: '1.1.0',
          version: 5,
        })),
      },
    };
    const persistSymbolState = vi.fn(async () => false); // every attempt loses the CAS
    const registry = { get: vi.fn(() => stratWith('1.1.0')) };

    await expect(
      mutateSymbolState(
        { redis, logger: silentLogger, registry, persistSymbolState },
        scope as never,
        symbol,
        (state) => ({ ...(state as Record<string, unknown>), x: 1 }),
      ),
    ).rejects.toThrow(/CAS retries exhausted \(5\)/);
    expect(persistSymbolState).toHaveBeenCalledTimes(6); // MAX_CAS_RETRIES + 1
  });
});

describe('commitSymbolStateForTick', () => {
  const nextState = { schemaVersion: '1.0.0', lastBuyPrice: '42' };
  const version = '1.0.0';

  it('records state_commit_persist_error and refreshes the cache to nextState when the persist rejects', async () => {
    const { redis, rs } = makeRedis();
    const persistSymbolState = vi.fn(async () => {
      throw new Error('pg down');
    });
    const record = vi.fn();

    await commitSymbolStateForTick(
      { redis, logger: silentLogger, persistSymbolState, metrics: { record } },
      SCOPE,
      symbol,
      nextState,
      version,
      0,
      100,
    );

    expect(record).toHaveBeenCalledWith('state_commit_persist_error', 1, {
      profileId: profileId as unknown as string,
      symbol,
    });
    expect(record).not.toHaveBeenCalledWith('state_commit_persist_timeout', 1, expect.anything());
    // Read-your-writes: a degraded (rejected) persist refreshes the cache to
    // nextState so the next serialized tick reads the intended body, not the
    // stale pre-tick one. Single replica only — chainByKey serialises
    // tick-vs-fill, so there is no concurrent winner to revert. The next
    // confirmed commit heals PG.
    expect(rs.store.get(stateKey)).toBe(JSON.stringify(nextState));
  });

  it('degrades a deleted-mid-tick FK violation to a warn and continues (no tick crash)', async () => {
    // Routing the symbol-state write through the typed ProfileScope repo
    // dropped the old self-gating sub-select: a profile deleted mid-tick now
    // cascade-removes its symbol_states row, so the upsert's INSERT fails the
    // profile_id FK rather than writing zero rows. This pins the contract that
    // such a throw degrades exactly like any persist rejection — error metric,
    // tick continues, never propagates — so the commit can never DLQ the tick
    // on a deletion race.
    const { redis, rs } = makeRedis();
    const fkError = Object.assign(
      new Error('insert or update on table "symbol_states" violates foreign key constraint'),
      { code: '23503' },
    );
    const persistSymbolState = vi.fn(async () => {
      throw fkError;
    });
    const record = vi.fn();

    await expect(
      commitSymbolStateForTick(
        { redis, logger: silentLogger, persistSymbolState, metrics: { record } },
        SCOPE,
        symbol,
        nextState,
        version,
        0,
        100,
      ),
    ).resolves.toBe('degraded');

    expect(record).toHaveBeenCalledWith('state_commit_persist_error', 1, {
      profileId: profileId as unknown as string,
      symbol,
    });
    // Read-your-writes: the degrade refreshes the cache to nextState. For the
    // FK-deleted-profile case the entry is a harmless orphan — no tick runs for
    // a deleted profile, and no read trusts it.
    expect(rs.store.get(stateKey)).toBe(JSON.stringify(nextState));
  });

  it('records state_commit_persist_timeout when the persist exceeds the deadline', async () => {
    const { redis, rs } = makeRedis();
    // Resolves well after the deadline; the race resolves on the timer.
    const persistSymbolState = vi.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 200)),
    );
    const record = vi.fn();

    await commitSymbolStateForTick(
      { redis, logger: silentLogger, persistSymbolState, metrics: { record } },
      SCOPE,
      symbol,
      nextState,
      version,
      0,
      5,
    );

    expect(record).toHaveBeenCalledWith('state_commit_persist_timeout', 1, {
      profileId: profileId as unknown as string,
      symbol,
    });
    expect(record).not.toHaveBeenCalledWith('state_commit_persist_error', 1, expect.anything());
    // Timed-out persist still refreshes the cache to nextState: the read path
    // prefers the cache at equal schemaVersion, so leaving the stale pre-tick
    // body would break read-your-writes and re-fire the next tick's decision.
    // The uncancelled PG write, if it lands, carries the same body.
    expect(rs.store.get(stateKey)).toBe(JSON.stringify(nextState));
  });

  it('records nothing on a successful persist', async () => {
    const { redis } = makeRedis();
    const persistSymbolState = vi.fn(async () => true);
    const record = vi.fn();

    await commitSymbolStateForTick(
      { redis, logger: silentLogger, persistSymbolState, metrics: { record } },
      SCOPE,
      symbol,
      nextState,
      version,
      0,
      100,
    );

    expect(record).not.toHaveBeenCalled();
    expect(persistSymbolState).toHaveBeenCalledOnce();
  });

  it('records state_commit_cas_miss and does NOT refresh the cache on a CAS miss', async () => {
    // A concurrent writer (a fill on the stream-owner pod) advanced the slice
    // during this tick, so the CAS write matched zero rows (false). The tick
    // must not overwrite the winner's body, and must not cache its own.
    const { redis, rs } = makeRedis();
    const persistSymbolState = vi.fn(async () => false);
    const record = vi.fn();

    await commitSymbolStateForTick(
      { redis, logger: silentLogger, persistSymbolState, metrics: { record } },
      SCOPE,
      symbol,
      nextState,
      version,
      5,
      100,
    );

    expect(record).toHaveBeenCalledWith('state_commit_cas_miss', 1, {
      profileId: profileId as unknown as string,
      symbol,
    });
    expect(rs.store.has(stateKey)).toBe(false);
  });

  it('does not throw when no metrics sink is wired and the persist fails', async () => {
    const { redis } = makeRedis();
    const persistSymbolState = vi.fn(async () => {
      throw new Error('pg down');
    });

    await expect(
      commitSymbolStateForTick(
        { redis, logger: silentLogger, persistSymbolState },
        SCOPE,
        symbol,
        nextState,
        version,
        0,
        100,
      ),
    ).resolves.toBe('degraded');
  });

  it('DELs the cache key when the post-persist cache set fails so the next read falls back to PG (#371)', async () => {
    const delCalls: string[] = [];
    const redis = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {
        throw new Error('redis set blip');
      }),
      del: vi.fn(async (k: string) => {
        delCalls.push(k);
        return 1;
      }),
    } as unknown as Redis;
    const persistSymbolState = vi.fn(async () => true);

    await expect(
      commitSymbolStateForTick(
        { redis, logger: silentLogger, persistSymbolState },
        SCOPE,
        symbol,
        nextState,
        version,
        0,
        100,
      ),
    ).resolves.toBe('applied');

    // PG committed first; the failed cache set must clear the key so the
    // next read serves the authoritative PG body, not a stale cache at the
    // same schemaVersion.
    expect(persistSymbolState).toHaveBeenCalledOnce();
    expect(delCalls).toEqual([stateKey]);
  });

  it('does not throw when both the cache set and the recovery DEL fail (#371)', async () => {
    const redis = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {
        throw new Error('redis down');
      }),
      del: vi.fn(async () => {
        throw new Error('redis down');
      }),
    } as unknown as Redis;
    const persistSymbolState = vi.fn(async () => true);

    await expect(
      commitSymbolStateForTick(
        { redis, logger: silentLogger, persistSymbolState },
        SCOPE,
        symbol,
        nextState,
        version,
        0,
        100,
      ),
    ).resolves.toBe('applied');
    expect(persistSymbolState).toHaveBeenCalledOnce();
  });
});

describe('mergeLatchFieldsOnCasMiss', () => {
  const winnerRow = (over: Partial<SymbolStateRowView> = {}): SymbolStateRowView => ({
    state: { schemaVersion: '2.0.0', avgEntryPrice: '100', lastLossExitAt: null },
    strategyVersion: '2.0.0',
    version: 7,
    ...over,
  });

  // Strategy whose mergeConcurrent grafts the tick's lastLossExitAt onto the
  // winner (the real TT merge is unit-tested in the trailing-trade package).
  const mergeStrat = (
    mergeConcurrent: LatchMergeStrategy['mergeConcurrent'] = ({ base, latchSource }) => ({
      ...(base as Record<string, unknown>),
      lastLossExitAt: (latchSource as { lastLossExitAt: number }).lastLossExitAt,
    }),
    extras: Partial<LatchMergeStrategy> = {},
  ): LatchMergeStrategy => ({
    name: 'trailing-trade',
    version: '2.0.0',
    initialState: () => ({ schemaVersion: '2.0.0' }),
    mergeConcurrent,
    ...extras,
  });

  const tickNext = { schemaVersion: '2.0.0', lastLossExitAt: 1234 };

  it('grafts the tick latch onto the winner and CAS-writes on the winner version', async () => {
    const { redis } = makeRedis();
    const coldLoad = { loadSymbolState: vi.fn(async () => winnerRow()) };
    const persistSymbolState = vi.fn(async () => true);
    const metrics = { record: vi.fn() };

    const ok = await mergeLatchFieldsOnCasMiss(
      { redis, logger: silentLogger, persistSymbolState, coldLoad, metrics },
      SCOPE,
      symbol,
      mergeStrat(),
      {},
      tickNext,
    );

    expect(ok).toBe(true);
    expect(persistSymbolState).toHaveBeenCalledOnce();
    const call = persistSymbolState.mock.calls[0] ?? [];
    // Merged body keeps the winner's position, adopts the tick's latch.
    expect(call[2]).toMatchObject({ avgEntryPrice: '100', lastLossExitAt: 1234 });
    expect(call[3]).toBe('2.0.0'); // workingVersion
    expect(call[4]).toBe(7); // expectedVersion = winner's CAS token
    expect(metrics.record).toHaveBeenCalledWith('state_commit_latch_merged', 1, expect.any(Object));
  });

  it('re-reads and retries when a fresh writer wins the first attempt', async () => {
    const { redis } = makeRedis();
    const coldLoad = { loadSymbolState: vi.fn(async () => winnerRow()) };
    const persistSymbolState = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const ok = await mergeLatchFieldsOnCasMiss(
      { redis, logger: silentLogger, persistSymbolState, coldLoad },
      SCOPE,
      symbol,
      mergeStrat(),
      {},
      tickNext,
    );

    expect(ok).toBe(true);
    expect(persistSymbolState).toHaveBeenCalledTimes(2);
    expect(coldLoad.loadSymbolState).toHaveBeenCalledTimes(2);
  });

  it('gives up after exhausting CAS retries, dropping the latch (no corruption)', async () => {
    const { redis } = makeRedis();
    const coldLoad = { loadSymbolState: vi.fn(async () => winnerRow()) };
    const persistSymbolState = vi.fn(async () => false);
    const metrics = { record: vi.fn() };

    const ok = await mergeLatchFieldsOnCasMiss(
      { redis, logger: silentLogger, persistSymbolState, coldLoad, metrics },
      SCOPE,
      symbol,
      mergeStrat(),
      {},
      tickNext,
    );

    expect(ok).toBe(false);
    // MAX_CAS_RETRIES (5) + the initial attempt.
    expect(persistSymbolState).toHaveBeenCalledTimes(6);
    expect(metrics.record).toHaveBeenCalledWith(
      'state_commit_latch_merge_exhausted',
      1,
      expect.any(Object),
    );
  });

  it('bails without writing when the winner re-read fails migration', async () => {
    const { redis } = makeRedis();
    // Winner sits a version behind and the strategy migration throws -> the
    // reconcile spine returns null and the merge must not persist.
    const coldLoad = {
      loadSymbolState: vi.fn(async () =>
        winnerRow({ state: { schemaVersion: '1.0.0' }, strategyVersion: '1.0.0' }),
      ),
    };
    const persistSymbolState = vi.fn(async () => true);
    const strat = mergeStrat(undefined, {
      migrateState: () => {
        throw new Error('boom');
      },
    });

    const ok = await mergeLatchFieldsOnCasMiss(
      { redis, logger: silentLogger, persistSymbolState, coldLoad },
      SCOPE,
      symbol,
      strat,
      {},
      tickNext,
    );

    expect(ok).toBe(false);
    expect(persistSymbolState).not.toHaveBeenCalled();
  });
});
