// A (profile, symbol) whose Binance mode no longer lists the symbol (delisted, or
// admitted to the wrong mode) throws a `SymbolDelistedError` from the first
// `symbolInfoCache.get` on the tick path — the cache runs its inline refresh, the
// refresh RESOLVES, and the symbol key is still absent. A bare throw would walk
// past the handler's self-heal catch and dead-letter, every tick, forever. The
// typed error instead reaches a branch (beside the RedisUnavailable skip) that
// SELF-HEALS: reap the auto-added binding when it is flat, tell the operator once
// (throttled), and return a graceful skip instead of rethrowing.
//
// These tests drive the REAL `createSymbolInfoCache` to the confirmed-absent path,
// so the error they raise IS the production one rather than a look-alike, and
// inject the optional deps (`reapAutoIfFlat`, `appendActionLog`, `delistThrottle`)
// so the reap/alert/throttle behaviour is asserted directly. Which call site takes
// that first cache read is deliberately not pinned: the tradability pre-check now
// reads ahead of the assembler and lets this error through untouched, and either
// origin must land on the same self-heal.

import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { MarketDataPort } from '@app/binance';
import { createRegistry, type Strategy } from '@app/strategy-core';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';

import { createChainByKey } from '../../src/lib/chain-by-key.js';
import { createSymbolInfoCache } from '../../src/tick/symbol-info-cache.js';
import { createTickHandler, type TickHandlerDeps } from '../../src/tick/tick-handler.js';
import type { ProfileTickContext } from '../../src/tick/build-tick-input.js';
import type { TickJobData } from '../../src/queues/job-payloads.js';

const OPERATOR = asUserId('11111111-1111-4111-8111-111111111111');
const ACCOUNT = asAccountId('33333333-3333-4333-8333-333333333333');
const PROFILE = asProfileId('22222222-2222-4222-8222-222222222222');
const SYMBOL = 'BTCUSDT';
const SCOPE = { operatorId: OPERATOR, accountId: ACCOUNT, profileId: PROFILE };

const silentLogger = pino({ level: 'silent' });

const buildStubStrategy = (): Strategy =>
  ({
    name: 'stub-delisted',
    version: '1.0.0',
    displayName: 'stub',
    description: 'stub',
    capabilities: {
      candleIntervals: ['1h'],
      needsUserDataStream: false,
      needsMiniTicker: false,
      bundleProviders: [],
      operatorActions: [],
    },
    initialState: () => ({ schemaVersion: '1.0.0' }),
    // The delisted throw happens in the assembler, before tick() is reached.
    tick: () => ({ nextState: { schemaVersion: '1.0.0' }, decisions: [], logs: [], metrics: [] }),
  }) as unknown as Strategy;

const profileBase = {
  operatorId: OPERATOR,
  accountId: ACCOUNT,
  profileId: PROFILE,
  scope: SCOPE,
  symbol: SYMBOL,
  strategyName: 'stub-delisted',
  strategyVersion: '1.0.0',
  config: {},
  bundleProvider: async () => ({ bundle: {} }),
  // A test-mode profile: the real cache is asked for mode 'test', its keyspace is
  // empty, and the (no-op) refresh leaves it empty → confirmed-absent.
  binanceMode: 'test',
  quoteAsset: 'USDT',
  weightLimit1m: 1200,
  candleInterval: '1h',
  technicalsConfig: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
  needsAccountDeployedQuote: false,
  reserveBaseQuantity: null,
};

type ReapOutcome = 'removed' | 'not-found' | 'not-auto' | 'held';

interface HarnessOpts {
  /** `delisted` drives the real cache to a confirmed-absent (SymbolDelistedError)
   * throw; `transient` throws a bare Error, the DLQ path. */
  readonly mode: 'delisted' | 'transient';
  readonly reapResult?: ReapOutcome;
  /** Successive return values of `delistThrottle.allow`, one per tick. */
  readonly throttleAllows?: readonly boolean[];
  /** Omit the optional self-heal deps entirely (proves the degrade-to-skip). */
  readonly unwired?: boolean;
  /** Omit ONLY `enqueueReconfigure`, keeping reap/append/throttle wired
   * (proves a `removed` reap still skips gracefully when the enqueue is absent). */
  readonly omitEnqueueReconfigure?: boolean;
  /** `enqueueReconfigure` rejects — a throw must NOT fail the tick. */
  readonly enqueueReconfigureThrows?: boolean;
}

const buildHarness = (opts: HarnessOpts) => {
  // Snapshot pipeline stub: every pipelined GET resolves null so the cold-load
  // path is taken and the assembler proceeds to `symbolInfoCache.get`.
  const makeChain = (count: { n: number }) => {
    const chain = {
      get() {
        count.n += 1;
        return chain;
      },
      exec: async () => Array.from({ length: count.n }, () => [null, null] as const),
    };
    return chain;
  };
  const redis = {
    pipeline: () => makeChain({ n: 0 }),
    exists: async () => 0,
    get: async () => null,
    set: () => Promise.resolve('OK'),
    del: async () => 1,
  } as unknown as Redis;

  const symbolInfoCache =
    opts.mode === 'delisted'
      ? createSymbolInfoCache({
          // Empty keyspace + no-op refresh → confirmed-absent throw (the exact
          // production path the fix retypes as SymbolDelistedError).
          redis: { get: async () => null } as unknown as Redis,
          logger: silentLogger,
          refreshExchangeInfo: async () => undefined,
        })
      : {
          get: async () => {
            throw new Error('symbol-info-cache: transient redis failure on exchangeInfo read');
          },
        };

  const reapAutoIfFlat = vi.fn(async (): Promise<ReapOutcome> => opts.reapResult ?? 'removed');
  const appendActionLog = vi.fn(async () => undefined);
  // After a `removed` reap, the handler tells the WS to drop the unbound symbol by
  // enqueuing a reconfigure job. Best-effort: a throw must be swallowed, not fatal.
  const enqueueReconfigure = vi.fn(async () => {
    if (opts.enqueueReconfigureThrows) {
      throw new Error('enqueueReconfigure: queue add failed');
    }
  });
  const allows = [...(opts.throttleAllows ?? [true])];
  const delistThrottle = {
    allow: vi.fn(() => (allows.length > 0 ? (allows.shift() as boolean) : true)),
  };

  // Count chain.run entries by key: the reap must NOT open a second run for the
  // same (profile, symbol) key (chainByKey is not reentrant — that self-deadlocks).
  const chainRuns: string[] = [];
  const realChain = createChainByKey();
  const chain = {
    run: <T>(key: string, fn: () => Promise<T>): Promise<T> => {
      chainRuns.push(key);
      return realChain.run(key, fn);
    },
    size: () => realChain.size(),
  };

  const registry = createRegistry();
  registry.register(buildStubStrategy());

  const profile = profileBase as unknown as ProfileTickContext;

  const deps = {
    redis,
    registry,
    executor: { applyAll: async () => [] },
    chain,
    logger: silentLogger,
    coldLoad: {
      loadAccount: async () => ({ balances: {} }),
      loadAccountDeployedQuote: async () => '0',
      loadOpenOrders: async () => [],
      loadSymbolState: async () => null,
    },
    symbolInfoCache,
    statePort: {
      loadForTick: async () => ({
        state: { schemaVersion: '1.0.0' },
        commit: async () => undefined,
      }),
    },
    marketDataPort: { loadWindow: async () => [] } as unknown as MarketDataPort,
    resolveProfile: async () => profile,
    auditShipper: { publish: async () => undefined },
    // The OPTIONAL self-heal deps the fix adds — omitted entirely when `unwired`,
    // to prove the handler still degrades a delisted throw to a skip. `enqueueReconfigure`
    // can be omitted alone to prove a `removed` reap still skips without it.
    ...(opts.unwired
      ? {}
      : {
          reapAutoIfFlat,
          appendActionLog,
          delistThrottle,
          ...(opts.omitEnqueueReconfigure ? {} : { enqueueReconfigure }),
        }),
  } as unknown as TickHandlerDeps;

  const handler = createTickHandler(deps);
  const job = {
    data: {
      userId: String(OPERATOR),
      accountId: String(ACCOUNT),
      profileId: String(PROFILE),
      symbol: SYMBOL,
      event: 'tick',
      enqueuedAtMs: 0,
      payload: {},
    } satisfies TickJobData,
  } as unknown as Job<TickJobData>;

  const tick = async (): Promise<{ result?: unknown; thrown?: unknown }> => {
    try {
      return { result: await handler(job) };
    } catch (thrown) {
      return { thrown };
    }
  };

  const warnLogs = () =>
    appendActionLog.mock.calls.filter((c) => (c[1] as { level?: string })?.level === 'warn');
  const infoLogs = () =>
    appendActionLog.mock.calls.filter((c) => (c[1] as { level?: string })?.level === 'info');

  return {
    tick,
    reapAutoIfFlat,
    appendActionLog,
    delistThrottle,
    enqueueReconfigure,
    chainRuns,
    warnLogs,
    infoLogs,
  };
};

describe('tick handler — a confirmed-absent symbol self-heals instead of dead-lettering', () => {
  it('C1: a confirmed-absent symbol at the tick boundary returns a graceful skip, does NOT throw', async () => {
    const h = buildHarness({ mode: 'delisted', reapResult: 'removed' });
    const { result, thrown } = await h.tick();

    // No rethrow → no DLQ. Same skip shape the RedisUnavailable self-heal returns.
    expect(thrown).toBeUndefined();
    expect(result).toMatchObject({
      profileId: PROFILE,
      symbol: SYMBOL,
      decisionCount: 0,
      throttled: true,
    });
  });

  it('C2: removed → reapAutoIfFlat(scope, symbol) is called and an info action_log is written', async () => {
    const h = buildHarness({ mode: 'delisted', reapResult: 'removed' });
    await h.tick();

    expect(h.reapAutoIfFlat).toHaveBeenCalledWith(
      expect.objectContaining({ operatorId: OPERATOR, accountId: ACCOUNT, profileId: PROFILE }),
      SYMBOL,
    );
    // A removal the operator should see, at info — once, not per tick.
    expect(h.infoLogs()).toHaveLength(1);
    expect(h.warnLogs()).toHaveLength(0);
    // Two self-heals now share one reap-and-record trunk, so the cause is the
    // only thing keeping their operator records apart.
    expect((h.infoLogs()[0]?.[1] as { ctx?: { source?: string } })?.ctx).toMatchObject({
      source: 'symbol-delisted',
    });
  });

  it('C3: held is NOT removed and the warn alert is DEDUPED — two ticks (throttle [true,false]) warn once', async () => {
    const h = buildHarness({ mode: 'delisted', reapResult: 'held', throttleAllows: [true, false] });
    await h.tick();
    await h.tick();

    // Reap consulted every tick, but a held binding is never removed…
    expect(h.reapAutoIfFlat).toHaveBeenCalledTimes(2);
    expect(h.infoLogs()).toHaveLength(0);
    // …and the operator alert fires exactly once: the throttle gates the second tick.
    expect(h.delistThrottle.allow).toHaveBeenCalledTimes(2);
    expect(h.warnLogs()).toHaveLength(1);
  });

  it('C3b: not-auto is a distinct (non-removing) outcome whose warn alert is likewise deduped', async () => {
    const h = buildHarness({
      mode: 'delisted',
      reapResult: 'not-auto',
      throttleAllows: [true, false],
    });
    await h.tick();
    await h.tick();

    expect(h.reapAutoIfFlat).toHaveBeenCalledTimes(2);
    expect(h.infoLogs()).toHaveLength(0);
    expect(h.warnLogs()).toHaveLength(1);
  });

  it('C4: a transient bare Error still RETHROWS (DLQ) and never calls the reap', async () => {
    const h = buildHarness({ mode: 'transient' });
    const { thrown } = await h.tick();

    expect(thrown).toBeInstanceOf(Error);
    expect(h.reapAutoIfFlat).not.toHaveBeenCalled();
  });

  it('C5: the reap runs DIRECTLY, never through a second chain.run for the same (profile, symbol) key', async () => {
    const h = buildHarness({ mode: 'delisted', reapResult: 'removed' });
    await h.tick();

    // Reap invoked directly by the catch branch…
    expect(h.reapAutoIfFlat).toHaveBeenCalledTimes(1);
    // …and the tick opened exactly ONE chain.run (its own); a reentrant run for the
    // same key would deadlock, so the reap must not take the chain.
    expect(h.chainRuns).toEqual([`${PROFILE}:${SYMBOL}`]);
  });

  it('C6: not-found (the cron already reaped the row) → graceful skip, ZERO action-logs', async () => {
    const h = buildHarness({ mode: 'delisted', reapResult: 'not-found' });
    const { result, thrown } = await h.tick();

    // Nothing to remove and nothing to say — but still a clean skip, never a DLQ.
    expect(thrown).toBeUndefined();
    expect(result).toMatchObject({ symbol: SYMBOL, decisionCount: 0, throttled: true });
    expect(h.infoLogs()).toHaveLength(0);
    expect(h.warnLogs()).toHaveLength(0);
  });

  it('C7: fully unwired (no reap/append/throttle deps) still returns a graceful skip, does NOT throw', async () => {
    const h = buildHarness({ mode: 'delisted', unwired: true });
    const { result, thrown } = await h.tick();

    // The degrade-to-skip contract: missing optional deps are a no-op, and the
    // confirmed-absent throw is still absorbed into a throttled skip, never a DLQ.
    expect(thrown).toBeUndefined();
    expect(result).toMatchObject({
      profileId: PROFILE,
      symbol: SYMBOL,
      decisionCount: 0,
      throttled: true,
    });
  });

  it('C8: removed → enqueueReconfigure is called exactly once with { userId, accountId, profileId }', async () => {
    const h = buildHarness({ mode: 'delisted', reapResult: 'removed' });
    await h.tick();

    // The WS must stop feeding the now-unbound symbol promptly: one reconfigure job.
    expect(h.enqueueReconfigure).toHaveBeenCalledTimes(1);
    expect(h.enqueueReconfigure).toHaveBeenCalledWith({
      userId: OPERATOR,
      accountId: ACCOUNT,
      profileId: PROFILE,
    });
  });

  it('C9: non-removed outcomes (held, not-auto, not-found) never enqueue a reconfigure', async () => {
    for (const reapResult of ['held', 'not-auto', 'not-found'] as const) {
      const h = buildHarness({ mode: 'delisted', reapResult });
      await h.tick();

      // Nothing was unbound, so the WS binding is unchanged — no reconfigure job.
      expect(h.enqueueReconfigure).not.toHaveBeenCalled();
    }
  });

  it('C10: enqueueReconfigure rejecting is swallowed — the reap still returns the graceful skip', async () => {
    const h = buildHarness({
      mode: 'delisted',
      reapResult: 'removed',
      enqueueReconfigureThrows: true,
    });
    const { result, thrown } = await h.tick();

    // Best-effort enqueue: its throw must not fail the tick nor reach the DLQ.
    expect(thrown).toBeUndefined();
    expect(result).toMatchObject({
      profileId: PROFILE,
      symbol: SYMBOL,
      decisionCount: 0,
      throttled: true,
    });
    expect(h.enqueueReconfigure).toHaveBeenCalledTimes(1);
  });

  it('C11: the reconfigure enqueue does NOT open a second chain.run for the same (profile, symbol) key', async () => {
    const h = buildHarness({ mode: 'delisted', reapResult: 'removed' });
    await h.tick();

    expect(h.enqueueReconfigure).toHaveBeenCalledTimes(1);
    // Reentering chainByKey for the same key would deadlock — the enqueue must not.
    expect(h.chainRuns).toEqual([`${PROFILE}:${SYMBOL}`]);
  });

  it('C12: removed with enqueueReconfigure omitted still returns a graceful skip, does NOT throw', async () => {
    const h = buildHarness({
      mode: 'delisted',
      reapResult: 'removed',
      omitEnqueueReconfigure: true,
    });
    const { result, thrown } = await h.tick();

    // The optional enqueue is a no-op when unwired; the reap still skips cleanly.
    expect(thrown).toBeUndefined();
    expect(result).toMatchObject({
      profileId: PROFILE,
      symbol: SYMBOL,
      decisionCount: 0,
      throttled: true,
    });
  });
});
