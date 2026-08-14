// A bound symbol the account has no Binance permission to trade never becomes
// tradable by waiting. Today it re-derives its entry decision every tick, the
// order pre-flight refuses it pre-call, and the operator is alerted hourly —
// forever. The binding must be RETIRED instead.
//
// The self-heal mirrors the delisted-symbol reap
// (tick-handler-delisted-reap.test.ts) case-for-case, with one structural
// difference: this one is DATA-driven, not error-driven. Nothing throws — the
// check reads the symbol's published `permissionSets` off the symbol-info cache
// and the account's held tags off their Redis key, applies the AND-of-ORs
// tradability rule, and either lets the tick run or retires the binding.
//
// The governing rule is FAIL OPEN. A wrong "not permitted" retires a binding the
// account can trade, silently; a wrong "permitted" costs one Binance rejection,
// exactly what happens today. So no published sets, no held tags, an empty list
// or an unparseable one all mean PERMITTED.
//
// Every test drives the REAL tick handler, not the helper: that is what makes
// "never a DLQ", "no second chain.run", and "zero Binance weight" mean anything.

import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { z } from 'zod';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { MarketDataPort } from '@app/binance';
import { createRegistry, type Strategy, type SymbolInfo } from '@app/strategy-core';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';

import { createChainByKey } from '../../src/lib/chain-by-key.js';
import {
  buildAccountPermissionsKey,
  buildDisableActionKey,
  buildKillSwitchKey,
} from '../../src/executor/redis-namespace.js';
import { createTickHandler, type TickHandlerDeps } from '../../src/tick/tick-handler.js';
import type { ProfileTickContext } from '../../src/tick/build-tick-input.js';
import type { TickJobData } from '../../src/queues/job-payloads.js';

const OPERATOR = asUserId('11111111-1111-4111-8111-111111111111');
const ACCOUNT = asAccountId('33333333-3333-4333-8333-333333333333');
const PROFILE = asProfileId('22222222-2222-4222-8222-222222222222');
const SYMBOL = 'BTCUSDT';
const PERMISSIONS_KEY = buildAccountPermissionsKey(ACCOUNT);
const KILL_SWITCH_KEY = buildKillSwitchKey(ACCOUNT, PROFILE);
const DISABLE_ACTION_KEY = buildDisableActionKey(ACCOUNT, PROFILE, SYMBOL);

// Binance's rule is an AND of ORs: the account must hold one tag from EVERY set
// the symbol publishes. These two share nothing, so the symbol is unreachable.
const SYMBOL_SETS: readonly (readonly string[])[] = [['SPOT', 'MARGIN', 'TRD_GRP_005']];
const HELD_MISMATCHED = JSON.stringify(['LEVERAGED', 'TRD_GRP_025']);
const HELD_MATCHING = JSON.stringify(['SPOT', 'TRD_GRP_025']);

const silentLogger = pino({ level: 'silent' });

const buildStubStrategy = (): Strategy =>
  ({
    name: 'stub-not-permitted',
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
    // Permissive: the permitted path runs a FULL tick, which parses the assembled
    // bundle at the strategy boundary before `tick()`.
    bundleSchema: z.object({}),
    initialState: () => ({ schemaVersion: '1.0.0' }),
    tick: () => ({ nextState: { schemaVersion: '1.0.0' }, decisions: [], logs: [], metrics: [] }),
  }) as unknown as Strategy;

type ReapOutcome = 'removed' | 'not-found' | 'not-auto' | 'held';

interface HarnessOpts {
  /**
   * The symbol's published tradability sets. `undefined` = the cache entry omits
   * the field entirely (pre-field cache write), `null` = Binance published
   * nothing usable. Both are the fail-open "unknown" case.
   */
  readonly permissionSets?: readonly (readonly string[])[] | null;
  /** Raw value at the account-permissions Redis key; `null` = cold cache. */
  readonly accountPermissionsRaw?: string | null;
  readonly reapResult?: ReapOutcome;
  /** The reap DB delete rejects — a transient fault must degrade, not DLQ. */
  readonly reapThrows?: boolean;
  /** The action_log append rejects — likewise. */
  readonly appendActionLogThrows?: boolean;
  /** Successive return values of `notPermittedThrottle.allow`, one per tick. */
  readonly throttleAllows?: readonly boolean[];
  /** The throttle's Redis round-trip rejects. */
  readonly throttleThrows?: boolean;
  /** Omit the optional self-heal deps entirely (proves the degrade-to-skip). */
  readonly unwired?: boolean;
  readonly enqueueReconfigureThrows?: boolean;
  readonly binanceMode?: 'test' | 'live';
  /** The operator pulled the profile-wide kill switch. */
  readonly killSwitch?: boolean;
  /** The operator paused this one coin. */
  readonly symbolPaused?: boolean;
}

const buildHarness = (opts: HarnessOpts) => {
  // Key-aware: the snapshot pipeline is where the two operator halts are read,
  // and the retire pre-check is gated on both.
  const haltValues: Record<string, string> = {
    ...(opts.killSwitch ? { [KILL_SWITCH_KEY]: '1' } : {}),
    ...(opts.symbolPaused ? { [DISABLE_ACTION_KEY]: '1' } : {}),
  };
  const makeChain = () => {
    const keys: string[] = [];
    const chain = {
      get(key: string) {
        keys.push(key);
        return chain;
      },
      exec: async () => keys.map((k) => [null, haltValues[k] ?? null] as const),
    };
    return chain;
  };
  const redis = {
    pipeline: () => makeChain(),
    exists: async () => 0,
    // Key-aware: the permission pre-check reads the account's held tags from this
    // key and nothing else on the tick path takes a standalone GET.
    get: async (key: string) =>
      key === PERMISSIONS_KEY ? (opts.accountPermissionsRaw ?? null) : null,
    set: () => Promise.resolve('OK'),
    del: async () => 1,
  } as unknown as Redis;

  const symbolInfo: SymbolInfo = {
    symbol: SYMBOL,
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    status: 'TRADING',
    filters: { minQty: '0.00001', stepSize: '0.00001', minNotional: '10', tickSize: '0.01' },
    ...('permissionSets' in opts ? { permissionSets: opts.permissionSets } : {}),
  } as SymbolInfo;
  const symbolInfoCache = { get: vi.fn(async () => symbolInfo) };

  // Every Binance-weight-spending read on the tick path. The permission pre-check
  // must reach NONE of them: it is a Redis + in-process-cache decision.
  const loadAccount = vi.fn(async () => ({ balances: {} }));
  const loadAccountDeployedQuote = vi.fn(async () => '0');
  const loadOpenOrders = vi.fn(async () => []);
  const loadWindow = vi.fn(async () => []);

  const reapAutoIfFlat = vi.fn(async (): Promise<ReapOutcome> => {
    if (opts.reapThrows) throw new Error('reapAutoIfFlat: transient postgres failure');
    return opts.reapResult ?? 'removed';
  });
  const appendActionLog = vi.fn(async () => {
    if (opts.appendActionLogThrows) throw new Error('appendActionLog: transient postgres failure');
  });
  const enqueueReconfigure = vi.fn(async () => {
    if (opts.enqueueReconfigureThrows) throw new Error('enqueueReconfigure: queue add failed');
  });
  const allows = [...(opts.throttleAllows ?? [true])];
  const notPermittedThrottle = {
    allow: vi.fn(async () => {
      if (opts.throttleThrows) throw new Error('notPermittedThrottle: redis unavailable');
      return allows.length > 0 ? (allows.shift() as boolean) : true;
    }),
  };

  // Count chain.run entries by key: the pre-check must NOT open a second run for
  // the same (profile, symbol) key — chainByKey is not reentrant, so that
  // self-deadlocks.
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

  const profile = {
    operatorId: OPERATOR,
    accountId: ACCOUNT,
    profileId: PROFILE,
    scope: { operatorId: OPERATOR, accountId: ACCOUNT, profileId: PROFILE },
    symbol: SYMBOL,
    strategyName: 'stub-not-permitted',
    strategyVersion: '1.0.0',
    config: {},
    bundleProvider: async () => ({ bundle: {} }),
    binanceMode: opts.binanceMode ?? 'live',
    quoteAsset: 'USDT',
    weightLimit1m: 1200,
    candleInterval: '1h',
    technicalsConfig: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
    needsAccountDeployedQuote: false,
    reserveBaseQuantity: null,
  } as unknown as ProfileTickContext;

  const deps = {
    redis,
    registry,
    executor: { applyAll: async () => [] },
    chain,
    logger: silentLogger,
    coldLoad: {
      loadAccount,
      loadAccountDeployedQuote,
      loadOpenOrders,
      loadSymbolState: async () => null,
    },
    symbolInfoCache,
    statePort: {
      loadForTick: async () => ({
        state: { schemaVersion: '1.0.0' },
        commit: async () => undefined,
      }),
    },
    marketDataPort: { loadWindow } as unknown as MarketDataPort,
    resolveProfile: async () => profile,
    auditShipper: { publish: async () => undefined },
    // The retire path reuses the delisted self-heal's deps verbatim and adds one
    // optional throttle of its own. Omitted entirely when `unwired`, to prove the
    // pre-check still degrades to a graceful skip.
    ...(opts.unwired
      ? {}
      : { reapAutoIfFlat, appendActionLog, enqueueReconfigure, notPermittedThrottle }),
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

  const logsAt = (level: string) =>
    appendActionLog.mock.calls.filter((c) => (c[1] as { level?: string })?.level === level);
  const warnLogs = () => logsAt('warn');
  const infoLogs = () => logsAt('info');
  const warnMessages = () => warnLogs().map((c) => String((c[1] as { msg?: string })?.msg ?? ''));
  const ctxOf = (calls: readonly unknown[][]) =>
    calls.map((c) => (c[1] as { ctx?: Record<string, unknown> })?.ctx ?? {});

  return {
    tick,
    symbolInfoCache,
    reapAutoIfFlat,
    appendActionLog,
    enqueueReconfigure,
    notPermittedThrottle,
    chainRuns,
    warnLogs,
    infoLogs,
    warnMessages,
    ctxOf,
    weightSpenders: { loadAccount, loadAccountDeployedQuote, loadOpenOrders, loadWindow },
  };
};

/** The scenario every retire test starts from: symbol publishes sets the account cannot satisfy. */
const notPermitted = (extra: HarnessOpts = {}): HarnessOpts => ({
  permissionSets: SYMBOL_SETS,
  accountPermissionsRaw: HELD_MISMATCHED,
  ...extra,
});

describe('tick handler — an unpermitted symbol retires itself instead of alerting forever', () => {
  it('C1: an auto-bound, flat, unpermitted symbol is reaped and the tick returns a graceful skip, never a DLQ', async () => {
    const h = buildHarness(notPermitted({ reapResult: 'removed' }));
    const { result, thrown } = await h.tick();

    // No rethrow → no DLQ. Same skip shape every other self-heal returns.
    expect(thrown).toBeUndefined();
    expect(result).toMatchObject({
      profileId: PROFILE,
      symbol: SYMBOL,
      decisionCount: 0,
      throttled: true,
    });
    // The binding delete, the per-symbol state teardown and the discovery-hash
    // clear are ONE structural operation inside the repo fn, so the handler's
    // whole obligation is to invoke it with the proven scope and the symbol.
    expect(h.reapAutoIfFlat).toHaveBeenCalledWith(
      expect.objectContaining({ operatorId: OPERATOR, accountId: ACCOUNT, profileId: PROFILE }),
      SYMBOL,
    );
    // The retirement is a fact the operator should see, at info, once.
    expect(h.infoLogs()).toHaveLength(1);
    expect(h.warnLogs()).toHaveLength(0);
    // The two self-heals share one trunk, so the cause is what keeps their
    // records apart — swap the copy and this row starts lying about why.
    expect(h.ctxOf(h.infoLogs())[0]).toMatchObject({ source: 'symbol-not-permitted' });
  });

  it('C2: a retirement enqueues reconfigure-profile exactly once with { userId, accountId, profileId }', async () => {
    const h = buildHarness(notPermitted({ reapResult: 'removed' }));
    await h.tick();

    // The WS is still feeding the now-unbound symbol; one reconfigure job drops it.
    expect(h.enqueueReconfigure).toHaveBeenCalledTimes(1);
    expect(h.enqueueReconfigure).toHaveBeenCalledWith({
      userId: OPERATOR,
      accountId: ACCOUNT,
      profileId: PROFILE,
    });
  });

  it('C2b: a non-retiring outcome (held, not-auto, not-found) never enqueues a reconfigure', async () => {
    for (const reapResult of ['held', 'not-auto', 'not-found'] as const) {
      const h = buildHarness(notPermitted({ reapResult }));
      await h.tick();

      expect(h.enqueueReconfigure).not.toHaveBeenCalled();
    }
  });

  it('C3: a manually pinned binding is NOT retired — every per-symbol surface is untouched and the warn names the unpin', async () => {
    const h = buildHarness(notPermitted({ reapResult: 'not-auto' }));
    const { result, thrown } = await h.tick();

    expect(thrown).toBeUndefined();
    // A surviving binding keeps ticking: only a RETIRED symbol has nothing left
    // to do. One still bound must close its own blocker rows and stay able to
    // cancel resting orders; its orders are refused by the placement pre-flight.
    expect(result).toMatchObject({ symbol: SYMBOL, throttled: false });
    // Nothing removed, nothing unbound, nothing re-subscribed.
    expect(h.enqueueReconfigure).not.toHaveBeenCalled();
    expect(h.infoLogs()).toHaveLength(0);
    // The operator owns this decision, so the record has to say what to DO.
    expect(h.warnLogs()).toHaveLength(1);
    expect(h.warnMessages()[0]).toMatch(/unpin/i);
    expect(h.ctxOf(h.warnLogs())[0]).toMatchObject({ source: 'symbol-not-permitted' });
  });

  it('C4: a held binding is NOT retired — every per-symbol surface is untouched and the warn names the flatten', async () => {
    const h = buildHarness(notPermitted({ reapResult: 'held' }));
    const { result, thrown } = await h.tick();

    expect(thrown).toBeUndefined();
    expect(result).toMatchObject({ symbol: SYMBOL, throttled: false });
    expect(h.enqueueReconfigure).not.toHaveBeenCalled();
    expect(h.infoLogs()).toHaveLength(0);
    expect(h.warnLogs()).toHaveLength(1);
    // "Sell the position down to zero" is the flatten instruction in operator words.
    expect(h.warnMessages()[0]).toMatch(/sell the position down to zero/i);
    expect(h.ctxOf(h.warnLogs())[0]).toMatchObject({ source: 'symbol-not-permitted' });
  });

  // C5 — the fail-open matrix. Each row is an AMBIGUITY, and every ambiguity must
  // tick normally: no reap, no record, no skip. These are the cases where a
  // retirement would destroy a binding the account can trade.
  const failOpenCases: readonly { readonly name: string; readonly opts: HarnessOpts }[] = [
    {
      name: 'the symbol publishes no permissionSets field at all (pre-field cache entry)',
      opts: { accountPermissionsRaw: HELD_MISMATCHED },
    },
    {
      name: 'Binance published nothing usable (permissionSets null)',
      opts: { permissionSets: null, accountPermissionsRaw: HELD_MISMATCHED },
    },
    {
      name: 'the symbol publishes an empty set list',
      opts: { permissionSets: [], accountPermissionsRaw: HELD_MISMATCHED },
    },
    {
      name: 'the account permission key is absent (cold cache)',
      opts: { permissionSets: SYMBOL_SETS, accountPermissionsRaw: null },
    },
    {
      name: 'the account permission list is empty',
      opts: { permissionSets: SYMBOL_SETS, accountPermissionsRaw: '[]' },
    },
    {
      name: 'the account permission value is unparseable',
      opts: { permissionSets: SYMBOL_SETS, accountPermissionsRaw: 'not-json{' },
    },
    {
      name: 'the account permission list carries a non-string entry',
      opts: { permissionSets: SYMBOL_SETS, accountPermissionsRaw: '["SPOT",7]' },
    },
    {
      name: 'the account holds a tag from every published set',
      opts: { permissionSets: SYMBOL_SETS, accountPermissionsRaw: HELD_MATCHING },
    },
  ];

  for (const c of failOpenCases) {
    it(`C5: fails OPEN and ticks normally when ${c.name}`, async () => {
      const h = buildHarness(c.opts);
      const { result, thrown } = await h.tick();

      expect(thrown).toBeUndefined();
      // A real tick ran: not the throttled skip shape the retire path returns.
      expect(result).toMatchObject({ symbol: SYMBOL, throttled: false });
      expect(h.reapAutoIfFlat).not.toHaveBeenCalled();
      expect(h.enqueueReconfigure).not.toHaveBeenCalled();
      expect(h.appendActionLog).not.toHaveBeenCalled();
    });
  }

  it('C6: the pre-check spends ZERO Binance request weight and opens no second chain.run', async () => {
    const h = buildHarness(notPermitted({ reapResult: 'removed' }));
    await h.tick();

    // Symbol info comes from the cache (Redis + in-process), permissions from a
    // plain Redis GET — no signed /account call, no cold-load, no candle fetch.
    // Once, not twice: the retiring tick returns before the assembler takes its
    // own read, so the pre-check adds no lookup of its own to the hot path.
    expect(h.symbolInfoCache.get).toHaveBeenCalledTimes(1);
    expect(h.weightSpenders.loadAccount).not.toHaveBeenCalled();
    expect(h.weightSpenders.loadAccountDeployedQuote).not.toHaveBeenCalled();
    expect(h.weightSpenders.loadOpenOrders).not.toHaveBeenCalled();
    expect(h.weightSpenders.loadWindow).not.toHaveBeenCalled();
    // Exactly one chain entry: the tick's own. A reentrant run on the same key
    // would deadlock, so neither the pre-check nor the reap may take the chain.
    expect(h.chainRuns).toEqual([`${PROFILE}:${SYMBOL}`]);
  });

  it('C7: the refusal record is throttled to once per window per (profile, symbol)', async () => {
    const h = buildHarness(notPermitted({ reapResult: 'held', throttleAllows: [true, false] }));
    await h.tick();
    await h.tick();

    // The reap is consulted every tick (the position may have been flattened)…
    expect(h.reapAutoIfFlat).toHaveBeenCalledTimes(2);
    // …but the operator hears about it once per window, keyed per (profile, symbol).
    expect(h.notPermittedThrottle.allow).toHaveBeenCalledTimes(2);
    expect(h.notPermittedThrottle.allow).toHaveBeenCalledWith(`${PROFILE}:${SYMBOL}`);
    expect(h.warnLogs()).toHaveLength(1);
  });

  it('C7b: a Redis fault inside the throttle costs neither the self-heal nor the tick', async () => {
    const h = buildHarness(notPermitted({ reapResult: 'held', throttleThrows: true }));
    const { result, thrown } = await h.tick();

    // The throttle is visibility plumbing; it can never cost the self-heal.
    expect(thrown).toBeUndefined();
    expect(result).toMatchObject({ symbol: SYMBOL, throttled: false });
    // Fail-open the other way too: unsuppressed beats silent.
    expect(h.warnLogs()).toHaveLength(1);
  });

  it('C8: a testnet profile takes the identical path, with no mode special-casing', async () => {
    const h = buildHarness(notPermitted({ reapResult: 'removed', binanceMode: 'test' }));
    const { result, thrown } = await h.tick();

    // Same outcome as the live case in C1/C2 — and the symbol info is read for the
    // profile's OWN mode, so testnet's published sets decide testnet's bindings.
    expect(h.symbolInfoCache.get).toHaveBeenCalledWith(SYMBOL, 'test');
    expect(thrown).toBeUndefined();
    expect(result).toMatchObject({ symbol: SYMBOL, decisionCount: 0, throttled: true });
    expect(h.reapAutoIfFlat).toHaveBeenCalledTimes(1);
    expect(h.enqueueReconfigure).toHaveBeenCalledTimes(1);
  });

  it('C9: a transient reap failure degrades to a normal tick, never a dead-letter', async () => {
    const h = buildHarness(notPermitted({ reapThrows: true }));
    const { result, thrown } = await h.tick();

    // The next tick re-attempts; a DLQ here would defeat the whole self-heal.
    // Nothing was proven removed, so the binding is treated as still live.
    expect(thrown).toBeUndefined();
    expect(result).toMatchObject({ symbol: SYMBOL, throttled: false });
    expect(h.enqueueReconfigure).not.toHaveBeenCalled();
    expect(h.appendActionLog).not.toHaveBeenCalled();
  });

  it('C9b: a transient action_log failure degrades to a graceful skip too', async () => {
    const h = buildHarness(notPermitted({ reapResult: 'removed', appendActionLogThrows: true }));
    const { result, thrown } = await h.tick();

    expect(thrown).toBeUndefined();
    expect(result).toMatchObject({ symbol: SYMBOL, decisionCount: 0, throttled: true });
  });

  it('C9c: a rejecting enqueueReconfigure is swallowed — the retirement still skips gracefully', async () => {
    const h = buildHarness(notPermitted({ reapResult: 'removed', enqueueReconfigureThrows: true }));
    const { result, thrown } = await h.tick();

    expect(thrown).toBeUndefined();
    expect(result).toMatchObject({ symbol: SYMBOL, decisionCount: 0, throttled: true });
    expect(h.enqueueReconfigure).toHaveBeenCalledTimes(1);
  });

  it('C9d: fully unwired (no reap/append/throttle/enqueue deps) still never dead-letters', async () => {
    const h = buildHarness(notPermitted({ unwired: true }));
    const { result, thrown } = await h.tick();

    // Missing optional deps are a no-op. Nothing can be proven retired without
    // them, so the tick carries on exactly as it did before the pre-check existed.
    expect(thrown).toBeUndefined();
    expect(result).toMatchObject({ profileId: PROFILE, symbol: SYMBOL, throttled: false });
  });

  it('C9e: not-found (the row is already gone) → the tick carries on, ZERO operator records', async () => {
    const h = buildHarness(notPermitted({ reapResult: 'not-found' }));
    const { result, thrown } = await h.tick();

    // Nothing to remove and nothing to say.
    expect(thrown).toBeUndefined();
    expect(result).toMatchObject({ symbol: SYMBOL, throttled: false });
    expect(h.infoLogs()).toHaveLength(0);
    expect(h.warnLogs()).toHaveLength(0);
    expect(h.enqueueReconfigure).not.toHaveBeenCalled();
  });

  // The pre-check runs AHEAD of the assembler, so it has to re-check the two
  // halts the assembler would have short-circuited on. Retiring a binding — and
  // reconfiguring the WS underneath it — on a profile the operator has explicitly
  // stopped is exactly the surprise a kill switch exists to prevent.
  for (const halt of [
    { name: 'the profile-wide kill switch is pulled', opts: { killSwitch: true } },
    { name: 'this coin is paused', opts: { symbolPaused: true } },
  ] as const) {
    it(`C11: no retirement happens while ${halt.name}`, async () => {
      const h = buildHarness(notPermitted({ reapResult: 'removed', ...halt.opts }));
      const { result, thrown } = await h.tick();

      expect(thrown).toBeUndefined();
      // The halt's own noop skip, not the retire path's.
      expect(result).toMatchObject({ symbol: SYMBOL, decisionCount: 0, throttled: true });
      expect(h.reapAutoIfFlat).not.toHaveBeenCalled();
      expect(h.enqueueReconfigure).not.toHaveBeenCalled();
      expect(h.appendActionLog).not.toHaveBeenCalled();
      // Not even read: the pre-check is gated before its symbol-info lookup.
      expect(h.symbolInfoCache.get).not.toHaveBeenCalled();
    });
  }
});
