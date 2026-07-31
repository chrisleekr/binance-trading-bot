import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { MarketDataPort } from '@app/binance';
import type { AnyStrategy, Candle, SymbolInfo, TriggerEvent } from '@app/strategy-core';
import { asAccountId, asProfileId, asUserId, type TechnicalsBundleConfig } from '@app/contracts';
import type { ProfileScope } from '@app/db';

// The entry-blocker on-change writer resolves a bound repo from the scope and
// appends one action_log. Mock the binding so the wrapper's write is observable
// without a real DB; `appendSpy` captures the row.
const appendSpy = vi.fn(async () => undefined);
vi.mock('@app/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@app/db')>();
  return { ...actual, profileRepoFromScope: () => ({ actionLogs: { append: appendSpy } }) };
});

import {
  buildTickInput,
  type BuildTickInputArgs,
  type ProfileTickContext,
  type TickInputDeps,
} from '../../src/tick/build-tick-input.js';
import { createRecordingOverrideTicket } from './_override-ticket-stub.js';
import type { RawSnapshot, SnapshotColdLoad } from '../../src/tick/snapshot-loader.js';
import type { SymbolInfoCache } from '../../src/tick/symbol-info-cache.js';
import type { StatePort } from '../../src/state/state-port.js';

const symbolInfo: SymbolInfo = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: {
    minNotional: '10',
    tickSize: '0.01',
    stepSize: '0.0001',
    minQty: '0.0001',
    maxQty: '1000',
    minPrice: '0.01',
    maxPrice: '1000000',
  },
};

const candle = (close: string, closeTimeMs: number): Candle => ({
  openTimeMs: closeTimeMs - 60_000,
  closeTimeMs,
  open: close,
  high: close,
  low: close,
  close,
  volume: '1',
  isClosed: true,
});

const indicatorBlob = JSON.stringify({
  symbol: 'BTCUSDT',
  interval: '1h',
  windowSize: 200,
  lowestLow: '40000',
  highestHigh: '60000',
  sma20: '50000',
  ema20: '50500',
  rsi14: '55.5',
  lastCandleCloseTimeMs: 1_700_000_000_000,
});

const makeProfile = (overrides: Partial<ProfileTickContext> = {}): ProfileTickContext => ({
  operatorId: asUserId('11111111-1111-4111-8111-111111111111'),
  accountId: asAccountId('33333333-3333-4333-8333-333333333333'),
  profileId: asProfileId('22222222-2222-4222-8222-222222222222'),
  scope: {
    operatorId: asUserId('11111111-1111-4111-8111-111111111111'),
    accountId: asAccountId('33333333-3333-4333-8333-333333333333'),
    profileId: asProfileId('22222222-2222-4222-8222-222222222222'),
  } as unknown as ProfileScope,
  symbol: 'BTCUSDT',
  strategyName: 'trailing-trade',
  strategyVersion: '1.0.0',
  config: { candleInterval: '1h' },
  bundleProvider: async () => ({ bundle: { technicals: { ready: true } } }),
  binanceMode: 'test',
  quoteAsset: 'USDT',
  weightLimit1m: 1200,
  candleInterval: '1h',
  technicalsConfig: {} as unknown as TechnicalsBundleConfig,
  needsAccountDeployedQuote: false,
  reserveBaseQuantity: null,
  ...overrides,
});

const baseRaw = (overrides: Partial<RawSnapshot> = {}): RawSnapshot => ({
  state: '{"schemaVersion":"1.0.0"}',
  accountInfo: JSON.stringify({ balances: { USDT: { free: '100', locked: '0' } } }),
  openOrders: JSON.stringify([]),
  killSwitch: null,
  symbolDisable: null,
  weightUsed1m: 10,
  indicatorsByInterval: { '1h': null },
  ...overrides,
});

const strategyStub = {
  name: 'trailing-trade',
  version: '1.0.0',
  // buildTickInput reads capabilities.bundleProviders to tell the provider
  // which slots to assemble; the stubbed provider ignores it.
  capabilities: { bundleProviders: ['technicals', 'override'] },
} as unknown as AnyStrategy;
const trigger: TriggerEvent = { kind: 'tick' };
const clock = { nowMs: () => 1000 };
const rng = { next: () => 0 };

const buildArgs = (over: Partial<BuildTickInputArgs> = {}): BuildTickInputArgs => ({
  profile: makeProfile(),
  strategy: strategyStub,
  raw: baseRaw(),
  intervals: ['1h'],
  clock,
  rng,
  trigger,
  overrideTicket: createRecordingOverrideTicket().ticket,
  ...over,
});

interface Stubs {
  readonly deps: TickInputDeps;
  readonly redisSet: ReturnType<typeof vi.fn>;
  readonly loadAccount: ReturnType<typeof vi.fn>;
  readonly loadAccountDeployedQuote: ReturnType<typeof vi.fn>;
  readonly loadOpenOrders: ReturnType<typeof vi.fn>;
  readonly loadProfileKv: ReturnType<typeof vi.fn>;
  readonly loadWindow: ReturnType<typeof vi.fn>;
  readonly getSymbolInfo: ReturnType<typeof vi.fn>;
  readonly loadForTick: ReturnType<typeof vi.fn>;
  readonly stateCommit: ReturnType<typeof vi.fn>;
  readonly logger: {
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
}

const makeStubs = (over: Partial<TickInputDeps> = {}): Stubs => {
  const redisSet = vi.fn(async () => 'OK');
  const loadAccount = vi.fn(async () => ({ balances: {} }));
  const loadAccountDeployedQuote = vi.fn(async () => '0');
  const loadOpenOrders = vi.fn(async () => []);
  const loadProfileKv = vi.fn(async () => ({ 'rebalance:target': '0.5' }));
  const loadWindow = vi.fn(async () => [candle('50000', 1_700_000_000_000)]);
  const getSymbolInfo = vi.fn(async () => symbolInfo);
  // loadForTick now returns a StateLoad: the body plus an opaque `commit`
  // closure that captured the read's version. The assembler forwards `commit`
  // onto BuiltTick unchanged; the handler calls it after strategy.tick.
  const stateCommit = vi.fn(async () => undefined);
  const loadForTick = vi.fn(async () => ({ state: { s: 1 }, commit: stateCommit }));
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const deps: TickInputDeps = {
    redis: { set: redisSet } as unknown as Redis,
    logger: logger as unknown as Logger,
    coldLoad: {
      loadAccount,
      loadAccountDeployedQuote,
      loadOpenOrders,
      loadSymbolState: vi.fn(async () => null),
      loadProfileKv,
    } as unknown as SnapshotColdLoad,
    symbolInfoCache: { get: getSymbolInfo } as unknown as SymbolInfoCache,
    statePort: { loadForTick } as unknown as StatePort,
    marketDataPort: { loadWindow } as unknown as MarketDataPort,
    ...over,
  };
  return {
    deps,
    redisSet,
    loadAccount,
    loadAccountDeployedQuote,
    loadOpenOrders,
    loadProfileKv,
    loadWindow,
    getSymbolInfo,
    loadForTick,
    stateCommit,
    logger,
  };
};

describe('buildTickInput', () => {
  it('assembles a ready TickInput from cached snapshot data', async () => {
    const { deps, stateCommit } = makeStubs();
    const built = await buildTickInput(
      deps,
      buildArgs({ raw: baseRaw({ indicatorsByInterval: { '1h': indicatorBlob } }) }),
    );

    expect(built.kind).toBe('ready');
    if (built.kind !== 'ready') throw new Error('expected ready');
    // The load handle's `commit` is wrapped (for the on-change entry-blocker
    // log) but forwards to the underlying commit. With no entryBlocker change
    // (neither prev nor next has one) the wrapper just delegates.
    await built.commit({ s: 1 }, 5000);
    expect(stateCommit).toHaveBeenCalledWith({ s: 1 }, 5000);
    expect(built.input.state).toEqual({ s: 1 });
    expect(built.input.account.balances['USDT']?.free.toString()).toBe('100');
    expect(built.input.market.currentPrice).toBe('50000');
    expect(built.input.market.indicatorsByInterval?.['1h']?.sma20).toBe('50000');
    expect(built.input.profile.strategyVersion).toBe('1.0.0');
    expect(built.input.limits.weightUsed1m).toBe(10);
  });

  it('carries the override TTL from the bundle provider onto the built tick', async () => {
    // The tick handler re-arms a deferred override off this value. Drop it and every
    // deferred force-sell silently falls back to being consumed — the original bug.
    const { deps } = makeStubs();
    const built = await buildTickInput(
      deps,
      buildArgs({
        profile: makeProfile({
          bundleProvider: async () => ({ bundle: { override: null }, overrideTtlMs: 240_000 }),
        }),
      }),
    );

    if (built.kind !== 'ready') throw new Error('expected ready');
    expect(built.overrideTtlMs).toBe(240_000);
  });

  it('omits overrideTtlMs entirely when the provider read no override window', async () => {
    // exactOptionalPropertyTypes: the key must be ABSENT, not `undefined` — the
    // handler's `ttlMs` spread and the settle path both read presence.
    const { deps } = makeStubs();
    const built = await buildTickInput(
      deps,
      buildArgs({
        profile: makeProfile({ bundleProvider: async () => ({ bundle: { override: null } }) }),
      }),
    );

    if (built.kind !== 'ready') throw new Error('expected ready');
    expect('overrideTtlMs' in built).toBe(false);
  });

  it('subtracts the per-symbol reserve from the bot-visible base balance (#498)', async () => {
    const { deps } = makeStubs();
    const built = await buildTickInput(
      deps,
      buildArgs({
        profile: makeProfile({ reserveBaseQuantity: '0.5' }),
        raw: baseRaw({
          accountInfo: JSON.stringify({
            balances: { BTC: { free: '2', locked: '0' }, USDT: { free: '100', locked: '0' } },
          }),
        }),
      }),
    );
    expect(built.kind).toBe('ready');
    if (built.kind !== 'ready') throw new Error('expected ready');
    // Bot sees 2 - 0.5 = 1.5 BTC tradeable; the reserve is invisible to the strategy.
    expect(built.input.account.balances['BTC']?.free.toString()).toBe('1.5');
    // Quote balance is untouched — the reserve is base-only.
    expect(built.input.account.balances['USDT']?.free.toString()).toBe('100');
  });

  it('leaves the base balance untouched when no reserve is set', async () => {
    const { deps } = makeStubs();
    const built = await buildTickInput(
      deps,
      buildArgs({
        raw: baseRaw({
          accountInfo: JSON.stringify({ balances: { BTC: { free: '2', locked: '0' } } }),
        }),
      }),
    );
    expect(built.kind).toBe('ready');
    if (built.kind !== 'ready') throw new Error('expected ready');
    expect(built.input.account.balances['BTC']?.free.toString()).toBe('2');
  });

  it('is inert when a reserve is set but the base balance line is absent', async () => {
    // The realistic first-enable case: the operator set a reserve before any base
    // balance landed in the wallet snapshot. The overlay must no-op (not throw, not
    // synthesize a base line) and leave the quote balance intact.
    const { deps } = makeStubs();
    const built = await buildTickInput(
      deps,
      buildArgs({
        profile: makeProfile({ reserveBaseQuantity: '0.5' }),
        raw: baseRaw({
          accountInfo: JSON.stringify({ balances: { USDT: { free: '100', locked: '0' } } }),
        }),
      }),
    );
    expect(built.kind).toBe('ready');
    if (built.kind !== 'ready') throw new Error('expected ready');
    expect(built.input.account.balances['BTC']).toBeUndefined();
    expect(built.input.account.balances['USDT']?.free.toString()).toBe('100');
  });

  it('injects the cross-profile deployed total when the account cap is armed', async () => {
    const stubs = makeStubs();
    stubs.loadAccountDeployedQuote.mockResolvedValueOnce('1234.5');
    const built = await buildTickInput(
      stubs.deps,
      buildArgs({
        profile: makeProfile({ needsAccountDeployedQuote: true, quoteAsset: 'USDT' }),
        raw: baseRaw({ indicatorsByInterval: { '1h': indicatorBlob } }),
      }),
    );

    if (built.kind !== 'ready') throw new Error('expected ready');
    // The cross-profile sum the worker reads (account-wide exposure cap input)
    // lands on the account snapshot the strategy sees, alongside balances.
    expect(built.input.account.deployedQuoteAcrossProfiles).toBe('1234.5');
    expect(stubs.loadAccountDeployedQuote).toHaveBeenCalledOnce();
    // The aggregate is scoped by (account, quote asset): the account already
    // pins one Binance environment, so no separate mode arg is threaded.
    expect(stubs.loadAccountDeployedQuote).toHaveBeenCalledWith(expect.anything(), 'USDT');
  });

  it('skips the deployed-quote aggregate when the account cap is disarmed', async () => {
    const stubs = makeStubs();
    const built = await buildTickInput(
      stubs.deps,
      buildArgs({
        profile: makeProfile({ needsAccountDeployedQuote: false }),
        raw: baseRaw({ indicatorsByInterval: { '1h': indicatorBlob } }),
      }),
    );

    if (built.kind !== 'ready') throw new Error('expected ready');
    // The aggregate is an indexed SUM over the cost-basis ledger on the hottest
    // path; a profile that has not armed the account cap must not pay for it,
    // and the optional snapshot field is left unset (cap check defaults to '0').
    expect(stubs.loadAccountDeployedQuote).not.toHaveBeenCalled();
    expect(built.input.account.deployedQuoteAcrossProfiles).toBeUndefined();
  });

  it('loads the profile KV snapshot only when the strategy opts in (needsProfileKv)', async () => {
    const stubs = makeStubs();
    const kvStrategy = {
      ...strategyStub,
      capabilities: { bundleProviders: [], needsProfileKv: true },
    } as unknown as AnyStrategy;
    const built = await buildTickInput(
      stubs.deps,
      buildArgs({ strategy: kvStrategy, raw: baseRaw() }),
    );
    if (built.kind !== 'ready') throw new Error('expected ready');
    expect(stubs.loadProfileKv).toHaveBeenCalledOnce();
    expect(built.input.profileKv).toEqual({ 'rebalance:target': '0.5' });
  });

  it('skips the profile KV read for a per-symbol strategy (no needsProfileKv)', async () => {
    const stubs = makeStubs();
    const built = await buildTickInput(stubs.deps, buildArgs({ raw: baseRaw() }));
    if (built.kind !== 'ready') throw new Error('expected ready');
    // The default strategy stub has no needsProfileKv → no hot-path read, field absent.
    expect(stubs.loadProfileKv).not.toHaveBeenCalled();
    expect(built.input.profileKv).toBeUndefined();
  });

  it('short-circuits on kill-switch without touching downstream reads', async () => {
    const stubs = makeStubs();
    const built = await buildTickInput(
      stubs.deps,
      buildArgs({ raw: baseRaw({ killSwitch: '1' }) }),
    );

    expect(built.kind).toBe('kill-switch');
    expect(stubs.getSymbolInfo).not.toHaveBeenCalled();
    expect(stubs.loadForTick).not.toHaveBeenCalled();
    expect(stubs.loadWindow).not.toHaveBeenCalled();
  });

  it('short-circuits to symbol-paused when the per-symbol disable key is present (#658)', async () => {
    // C1: the per-coin "Pause" writes a `disable-action:<symbol>` Redis key that
    // the snapshot loader will surface on `raw.symbolDisable`. A present value
    // freezes ALL new buy+sell decisions — the assembler must short-circuit to
    // `symbol-paused` BEFORE any downstream read, exactly like the kill-switch.
    const stubs = makeStubs();
    const built = await buildTickInput(
      stubs.deps,
      buildArgs({ raw: baseRaw({ symbolDisable: '1' }) }),
    );

    expect(built.kind).toBe('symbol-paused');
    // A pause is a noop tick: no snapshot assembly, no state load, no candle read.
    expect(stubs.getSymbolInfo).not.toHaveBeenCalled();
    expect(stubs.loadForTick).not.toHaveBeenCalled();
    expect(stubs.loadWindow).not.toHaveBeenCalled();
  });

  it('ticks normally when the per-symbol disable key is absent (#658 regression guard)', async () => {
    // C2: absence (or TTL-expiry) of the disable key means trade normally — the
    // pause must not leak into an un-paused symbol. `symbolDisable: null` is the
    // absent case the loader reports (`!== null` is false), so the tick assembles
    // a ready input.
    const stubs = makeStubs();
    const built = await buildTickInput(
      stubs.deps,
      buildArgs({
        raw: baseRaw({ symbolDisable: null, indicatorsByInterval: { '1h': indicatorBlob } }),
      }),
    );

    expect(built.kind).toBe('ready');
  });

  it('degrades account to cold-load when the cache key is absent', async () => {
    const stubs = makeStubs();
    stubs.loadAccount.mockResolvedValueOnce({
      balances: { BTC: { asset: 'BTC', free: '1', locked: '0' } },
    });
    const built = await buildTickInput(
      stubs.deps,
      buildArgs({ raw: baseRaw({ accountInfo: null }) }),
    );

    expect(stubs.loadAccount).toHaveBeenCalledOnce();
    if (built.kind !== 'ready') throw new Error('expected ready');
    expect(built.input.account.balances['BTC']).toBeDefined();
  });

  it('cold-loads open orders and writes through with a TTL on cache miss', async () => {
    const stubs = makeStubs();
    stubs.loadOpenOrders.mockResolvedValueOnce([{ orderId: 7 }]);
    const built = await buildTickInput(
      stubs.deps,
      buildArgs({ raw: baseRaw({ openOrders: null }) }),
    );

    expect(stubs.loadOpenOrders).toHaveBeenCalledOnce();
    expect(stubs.redisSet).toHaveBeenCalledWith(
      expect.any(String),
      JSON.stringify([{ orderId: 7 }]),
      'EX',
      600,
      'NX',
    );
    if (built.kind !== 'ready') throw new Error('expected ready');
    expect(built.input.openOrders).toEqual([{ orderId: 7 }]);
  });

  it('cold-load write-through uses SET NX with a ~600s TTL so it cannot clobber an executor mutation (E8)', async () => {
    // Issue #649 C1: the cold-load write is now conditional (NX) and long-lived
    // (~10 min safety ceiling). NX means a concurrent executor Lua mutation that
    // already established the list wins — the cold-load only seeds an ABSENT key,
    // so a stale REST snapshot cannot overwrite a fresher WS-merged one. RED until
    // Phase B (today it is an unconditional `SET ... EX 60`).
    const stubs = makeStubs();
    stubs.loadOpenOrders.mockResolvedValueOnce([{ orderId: 7 }]);
    await buildTickInput(stubs.deps, buildArgs({ raw: baseRaw({ openOrders: null }) }));

    expect(stubs.redisSet).toHaveBeenCalledWith(
      expect.any(String),
      JSON.stringify([{ orderId: 7 }]),
      'EX',
      600,
      'NX',
    );
  });

  it('survives a failed open-orders write-through (stale-cache race fail-safe)', async () => {
    const stubs = makeStubs();
    stubs.redisSet.mockRejectedValueOnce(new Error('redis down'));
    stubs.loadOpenOrders.mockResolvedValueOnce([{ orderId: 9 }]);
    const built = await buildTickInput(
      stubs.deps,
      buildArgs({ raw: baseRaw({ openOrders: null }) }),
    );

    expect(stubs.logger.warn).toHaveBeenCalledOnce();
    if (built.kind !== 'ready') throw new Error('expected ready');
    expect(built.input.openOrders).toEqual([{ orderId: 9 }]);
  });

  it('omits indicators on a cache miss and revives them when present', async () => {
    const miss = await buildTickInput(
      makeStubs().deps,
      buildArgs({ raw: baseRaw({ indicatorsByInterval: { '1h': null } }) }),
    );
    if (miss.kind !== 'ready') throw new Error('expected ready');
    expect(miss.input.market.indicatorsByInterval?.['1h']).toBeUndefined();

    const hit = await buildTickInput(
      makeStubs().deps,
      buildArgs({ raw: baseRaw({ indicatorsByInterval: { '1h': indicatorBlob } }) }),
    );
    if (hit.kind !== 'ready') throw new Error('expected ready');
    expect(hit.input.market.indicatorsByInterval?.['1h']?.rsi14).toBe('55.5');
  });

  it('sources candles per interval in lock-step with the raw snapshot keys', async () => {
    const stubs = makeStubs();
    await buildTickInput(
      stubs.deps,
      buildArgs({ raw: baseRaw({ indicatorsByInterval: { '1h': null } }) }),
    );
    expect(stubs.loadWindow).toHaveBeenCalledExactlyOnceWith('BTCUSDT', '1h', 200);
  });

  it('loads multiple intervals concurrently and maps each window to its own interval', async () => {
    const stubs = makeStubs();
    // Distinct close per interval so a misindexed map (the risk in the
    // serial->Promise.all rewrite) would surface as a swapped value.
    stubs.loadWindow.mockImplementation(async (_sym: string, iv: string) => [
      candle(iv === '15m' ? '111' : '222', 1_700_000_000_000),
    ]);
    const built = await buildTickInput(
      stubs.deps,
      buildArgs({
        intervals: ['1h', '15m'],
        raw: baseRaw({ indicatorsByInterval: { '1h': null, '15m': null } }),
      }),
    );
    if (built.kind !== 'ready') throw new Error('expected ready');
    expect(stubs.loadWindow).toHaveBeenCalledTimes(2);
    expect(built.input.market.candlesByInterval['1h']?.[0]?.close).toBe('222');
    expect(built.input.market.candlesByInterval['15m']?.[0]?.close).toBe('111');
  });

  it('logs and rethrows when state migration fails', async () => {
    const stubs = makeStubs();
    stubs.loadForTick.mockRejectedValueOnce(new Error('migrate boom'));
    await expect(buildTickInput(stubs.deps, buildArgs())).rejects.toThrow('migrate boom');
    expect(stubs.logger.error).toHaveBeenCalledOnce();
  });

  describe('entry-blocker on-change action_log (de-spam)', () => {
    const builtCommit = async (
      stubs: Stubs,
      prevState: unknown,
      nextState: unknown,
    ): Promise<void> => {
      stubs.loadForTick.mockResolvedValueOnce({ state: prevState, commit: stubs.stateCommit });
      const built = await buildTickInput(stubs.deps, buildArgs());
      if (built.kind !== 'ready') throw new Error('expected ready');
      await built.commit(nextState, 5000);
    };

    it('writes ONE action_log when the entry-blocker reason changes', async () => {
      appendSpy.mockClear();
      const stubs = makeStubs();
      await builtCommit(
        stubs,
        { entryBlocker: null },
        { entryBlocker: { reason: 'awaiting-trigger-price', detail: { windowLow: '95' } } },
      );
      expect(stubs.stateCommit).toHaveBeenCalledOnce();
      expect(appendSpy).toHaveBeenCalledOnce();
      expect(appendSpy.mock.calls[0]?.[0]).toMatchObject({
        symbol: 'BTCUSDT',
        level: 'info',
        ctx: {
          source: 'entry-blocker',
          reason: 'awaiting-trigger-price',
          detail: { windowLow: '95' },
        },
      });
    });

    it('writes a "no longer blocked" log when the reason clears to null', async () => {
      appendSpy.mockClear();
      const stubs = makeStubs();
      await builtCommit(
        stubs,
        { entryBlocker: { reason: 'technicals-sell' } },
        { entryBlocker: null },
      );
      expect(appendSpy).toHaveBeenCalledOnce();
      expect(appendSpy.mock.calls[0]?.[0]).toMatchObject({
        ctx: { source: 'entry-blocker', reason: null, previousReason: 'technicals-sell' },
      });
    });

    it('writes NO action_log when the reason is unchanged across ticks (de-spam)', async () => {
      appendSpy.mockClear();
      const stubs = makeStubs();
      await builtCommit(
        stubs,
        { entryBlocker: { reason: 'technicals-no-signal' } },
        { entryBlocker: { reason: 'technicals-no-signal', detail: { interval: '1m' } } },
      );
      expect(stubs.stateCommit).toHaveBeenCalledOnce();
      expect(appendSpy).not.toHaveBeenCalled();
    });

    it('swallows an action_log append failure (state commit already succeeded)', async () => {
      appendSpy.mockClear();
      appendSpy.mockRejectedValueOnce(new Error('append boom'));
      const stubs = makeStubs();
      await expect(
        builtCommit(stubs, { entryBlocker: null }, { entryBlocker: { reason: 'min-notional' } }),
      ).resolves.toBeUndefined();
      expect(stubs.logger.warn).toHaveBeenCalled();
    });
  });

  // The bundle read is destructive: by the time it returns, the operator's
  // override key has already been DEL'd. The assembler is therefore the only
  // place that can register the paired release, and it has to do so before the
  // next thing that can throw.
  describe('override ticket', () => {
    const OVERRIDE = {
      kind: 'trigger-sell' as const,
      overrideActionId: '01234567-89ab-4cde-89ab-cdef01234567',
    };
    const withOverride = (overrideTtlMs?: number) =>
      makeProfile({
        bundleProvider: async () => ({
          bundle: { override: OVERRIDE },
          ...(overrideTtlMs === undefined ? {} : { overrideTtlMs }),
        }),
      });

    it('arms the ticket with the consumed override, its scope and its remaining window', async () => {
      const recorder = createRecordingOverrideTicket();
      const profile = withOverride(120_000);
      await buildTickInput(
        makeStubs().deps,
        buildArgs({ profile, overrideTicket: recorder.ticket }),
      );

      expect(recorder.arms).toHaveLength(1);
      expect(recorder.arms[0]?.override).toEqual(OVERRIDE);
      expect(recorder.arms[0]?.ttlMs).toBe(120_000);
      // The ownership the tick already proved; the compensating settle re-resolves nothing.
      expect(recorder.arms[0]?.scope).toBe(profile.scope);
    });

    it('leaves the ticket unarmed when the builder projected no override', async () => {
      // The builder returns null for every pre-DEL bail-out (a degraded signal
      // read, a DEL that failed). The key is still in Redis, so writing it back
      // would be inventing state.
      const recorder = createRecordingOverrideTicket();
      await buildTickInput(makeStubs().deps, buildArgs({ overrideTicket: recorder.ticket }));

      expect(recorder.arms).toHaveLength(0);
    });

    it('arms the ticket even when the concurrent state load rejects', async () => {
      // The two reads run together now, so the bundle can consume the override
      // while the state load is already doomed. Arming has to happen before the
      // rejection is inspected or the concurrency reopens the loss it fixed.
      const recorder = createRecordingOverrideTicket();
      const stubs = makeStubs();
      stubs.loadForTick.mockRejectedValueOnce(new Error('migrate boom'));

      await expect(
        buildTickInput(
          stubs.deps,
          buildArgs({ profile: withOverride(120_000), overrideTicket: recorder.ticket }),
        ),
      ).rejects.toThrow('migrate boom');
      expect(recorder.arms).toHaveLength(1);
    });
  });

  // The handler classifies a thrown tick by pattern-matching the error (delisted
  // symbol self-heals, governor-unavailable Redis skips, everything else DLQs).
  // Running the two reads concurrently must not make WHICH error surfaces depend
  // on which rejected first.
  describe('concurrent state + bundle reads', () => {
    it('issues both reads before either completes', async () => {
      // MUTUAL gate: each read announces its own start and then waits for the
      // other's. Either serial order therefore deadlocks — the first read blocks
      // on a signal only the second can send, and the second never begins. Only
      // genuine concurrency completes, so this cannot pass on a code path that
      // merely swapped the serial order for no benefit.
      let stateStarted = (): void => {};
      let bundleStarted = (): void => {};
      const stateHasStarted = new Promise<void>((resolve) => {
        stateStarted = resolve;
      });
      const bundleHasStarted = new Promise<void>((resolve) => {
        bundleStarted = resolve;
      });

      const stubs = makeStubs();
      stubs.loadForTick.mockImplementationOnce(async () => {
        stateStarted();
        await bundleHasStarted;
        return { state: { s: 1 }, commit: stubs.stateCommit };
      });
      const profile = makeProfile({
        bundleProvider: async () => {
          bundleStarted();
          await stateHasStarted;
          return { bundle: {} };
        },
      });

      // Fail fast instead of hanging if the reads go serial again. Cleared either
      // way so a passing run leaves no timer holding the event loop open.
      let deadlock: ReturnType<typeof setTimeout> | undefined;
      const guard = new Promise<'deadlocked'>((resolve) => {
        deadlock = setTimeout(() => {
          // Release both so the abandoned promise cannot linger unresolved.
          stateStarted();
          bundleStarted();
          resolve('deadlocked');
        }, 2000);
      });

      try {
        const outcome = await Promise.race([
          buildTickInput(stubs.deps, buildArgs({ profile })),
          guard,
        ]);
        expect(outcome).not.toBe('deadlocked');
      } finally {
        clearTimeout(deadlock);
      }
    });

    it('surfaces the state-load failure when both reads reject', async () => {
      // Fixed precedence, matching the order the serial version ran them in.
      // `Promise.all` would surface whichever lost the race, and the handler's
      // skip-versus-DLQ classification would turn flaky.
      const stubs = makeStubs();
      stubs.loadForTick.mockRejectedValueOnce(new Error('migrate boom'));
      const profile = makeProfile({
        bundleProvider: async () => {
          throw new Error('bundle boom');
        },
      });

      await expect(buildTickInput(stubs.deps, buildArgs({ profile }))).rejects.toThrow(
        'migrate boom',
      );
    });

    it('surfaces the bundle failure when only the bundle read rejects', async () => {
      const stubs = makeStubs();
      const profile = makeProfile({
        bundleProvider: async () => {
          throw new Error('bundle boom');
        },
      });

      await expect(buildTickInput(stubs.deps, buildArgs({ profile }))).rejects.toThrow(
        'bundle boom',
      );
    });
  });
});
