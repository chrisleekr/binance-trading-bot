// Shared deterministic reconstruction harness for the worker frame-trace gate.
//
// Both the replay test and the fixture generator drive a recorded tuple through
// the REAL snapshot-loader (readRawSnapshot) over a fake in-memory Redis, then
// the REAL buildTickInput + strategy.tick, with identical stubs on every
// boundary (StatePort, coldLoad, marketDataPort, symbolInfoCache, Clock, RNG).
// Sharing the harness is what guarantees record-time inputs == replay-time
// inputs: a fixture generated here replays byte-identically through the gate.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { MarketDataPort } from '@app/binance';
import type {
  AnyStrategy,
  Candle,
  SymbolInfo,
  StrategyRegistry,
  TickInput,
  TickOutput,
} from '@app/strategy-core';
import { asAccountId, asProfileId, asUserId, type TechnicalsBundleConfig } from '@app/contracts';
import type { ProfileScope } from '@app/db';

import {
  buildTickInput,
  type ProfileTickContext,
  type TickInputDeps,
} from '../../src/tick/build-tick-input.js';
import { createRecordingOverrideTicket } from './_override-ticket-stub.js';
import {
  readRawSnapshot,
  type RawSnapshot,
  type SnapshotColdLoad,
} from '../../src/tick/snapshot-loader.js';
import {
  buildAccountInfoKey,
  buildDisableActionKey,
  buildOpenOrdersKey,
  buildKillSwitchKey,
  buildOrderRefusalKey,
  buildOrderRearmKey,
  buildSymbolStateKey,
  buildWeightKey,
} from '../../src/executor/redis-namespace.js';
import { indicatorKey } from '../../src/indicator-computer/indicator-computer.js';
import { minuteBucketOf } from '../../src/executor/binance-error-taxonomy.js';
import type { FrameTuple } from '../../src/tick/frame-recorder.js';
import type { StatePort } from '../../src/state/state-port.js';

/** Fixed wall clock both record and replay pin, so a clock-gated branch is reproducible. */
export const NOW_MS = 1_700_000_000_000;

/** Deterministic Clock injection: every tick reads the same instant. */
export const clock = { nowMs: () => NOW_MS };

/** Deterministic RNG injection: no randomness leaks into a decision. */
export const rng = { next: () => 0 };

export const silentLogger = new Proxy({}, { get: () => () => undefined }) as Logger;

/**
 * Fake ioredis whose pipeline replays the recorded RawSnapshot blobs in exactly
 * the key order readRawSnapshot issues its GETs, so the snapshot-loader's key
 * ordering is part of what the gate verifies. `set` is a no-op (the open-orders
 * write-through is best-effort and never read back in replay).
 */
export const makeFakeRedis = (tuple: FrameTuple): Redis => {
  // Redis keys + the user-data stream are per-account now. The recorded tuple
  // predates the split and carries only the operator UUID, so the account key
  // reuses that token; seed and read derive it identically, so key routing
  // stays consistent and the recorded decisions replay drift-free.
  const accountId = asAccountId(tuple.profile.userId);
  const profileId = asProfileId(tuple.profile.profileId);
  const symbol = tuple.profile.symbol;
  // Map the keys readRawSnapshot reads to the recorded blob for each.
  const store = new Map<string, string | null>();
  store.set(buildSymbolStateKey(accountId, profileId, symbol), tuple.raw.state);
  store.set(buildAccountInfoKey(accountId, profileId), tuple.raw.accountInfo);
  store.set(buildOpenOrdersKey(accountId, symbol), tuple.raw.openOrders);
  store.set(buildKillSwitchKey(accountId, profileId), tuple.raw.killSwitch);
  store.set(buildDisableActionKey(accountId, profileId, symbol), tuple.raw.symbolDisable);
  store.set(buildOrderRearmKey(profileId, symbol), tuple.raw.orderRearm);
  store.set(buildOrderRefusalKey(accountId, profileId, symbol), tuple.raw.orderRefusal ?? null);
  store.set(
    buildWeightKey(accountId, profileId, minuteBucketOf(NOW_MS)),
    String(tuple.raw.weightUsed1m),
  );
  for (const iv of tuple.intervals) {
    store.set(indicatorKey(symbol, iv), tuple.raw.indicatorsByInterval[iv] ?? null);
  }
  const queued: string[] = [];
  const pipeline = {
    get(key: string) {
      queued.push(key);
      return pipeline;
    },
    async exec() {
      return queued.map((k) => [null, store.get(k) ?? null] as [null, string | null]);
    },
  };
  return {
    pipeline: () => pipeline,
    set: async () => 'OK',
  } as unknown as Redis;
};

export const symbolInfo: SymbolInfo = {
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

/**
 * A deterministic candle window for the replay: a flat series at a fixed price
 * so the strategy reads a stable, no-signal closed-candle market unless the
 * tuple's state/config/livePrice drives a decision. The flat 50000 close means
 * a livePrice override is the ONLY way currentPrice diverges from the candle, so
 * a livePrice-driven decision proves the override path.
 */
export const replayCandle = (close: string, closeTimeMs: number): Candle => ({
  openTimeMs: closeTimeMs - 60_000,
  closeTimeMs,
  open: close,
  high: close,
  low: close,
  close,
  volume: '1',
  isClosed: true,
});

export const makeProfileContext = (
  tuple: FrameTuple,
  strategy: AnyStrategy,
): ProfileTickContext => {
  const operatorId = asUserId(tuple.profile.userId);
  const accountId = asAccountId(tuple.profile.userId);
  const profileId = asProfileId(tuple.profile.profileId);
  return {
    operatorId,
    accountId,
    profileId,
    scope: { operatorId, accountId, profileId } as unknown as ProfileScope,
    symbol: tuple.profile.symbol,
    strategyName: tuple.profile.strategyName,
    strategyVersion: tuple.profile.strategyVersion,
    config: tuple.profile.config,
    // The bundle is a replay-side stub (it is NOT recorded in the tuple). Parse
    // a no-signal seed through the strategy's own bundleSchema so the shape is
    // exactly what the strategy expects with no live signals: an empty bundle
    // for a strategy that takes none, or a no-op bundle (no operator override,
    // no technicals signals; config defaults fill in) for one that does. Built
    // the same way at record and replay time, so the gate stays drift-free.
    bundleProvider: async () => ({
      bundle: strategy.bundleSchema.parse({
        override: null,
        // Empty intervals so signals stays 1:1 (no live technicals signal); the
        // config schema fills the rest of its defaults.
        technicals: { config: { intervals: [] }, signals: [] },
      }) as Readonly<Record<string, unknown>>,
    }),
    binanceMode: tuple.profile.binanceMode,
    quoteAsset: tuple.profile.quoteAsset,
    weightLimit1m: tuple.profile.weightLimit1m,
    candleInterval: tuple.profile.candleInterval,
    technicalsConfig: {} as unknown as TechnicalsBundleConfig,
    needsAccountDeployedQuote: tuple.profile.needsAccountDeployedQuote,
  };
};

export const makeDeps = (tuple: FrameTuple): TickInputDeps => {
  // StatePort: return the recorded per-(profile,symbol) state slice verbatim
  // (revived from the raw blob) with a no-op commit. The state reconcile/migration
  // path is therefore NOT exercised by this gate (it has its own unit suite); the
  // body must simply match what the recording's tick ran on.
  const recordedState = tuple.raw.state === null ? null : JSON.parse(tuple.raw.state);
  const statePort = {
    loadForTick: async () => ({ state: recordedState, commit: async () => undefined }),
  } as unknown as StatePort;
  const coldLoad = {
    loadAccount: async () => ({ balances: {} }),
    loadAccountDeployedQuote: async () => '0',
    loadOpenOrders: async () => [],
    loadSymbolState: async () => null,
  } as unknown as SnapshotColdLoad;
  const marketDataPort = {
    loadWindow: async (_s: string, _iv: string, size: number) =>
      Array.from({ length: size }, (_, i) => replayCandle('50000', NOW_MS + i * 60_000)),
  } as unknown as MarketDataPort;
  return {
    redis: makeFakeRedis(tuple),
    logger: silentLogger,
    coldLoad,
    symbolInfoCache: { get: async () => symbolInfo } as unknown as TickInputDeps['symbolInfoCache'],
    statePort,
    marketDataPort,
  };
};

/** What a replay yields: the assembled input (for the boundary asserts) and the strategy's tick output. */
export interface ReplayResult {
  readonly built: {
    readonly input: TickInput<unknown, unknown, Readonly<Record<string, unknown>>>;
  };
  readonly output: TickOutput<unknown>;
}

/**
 * Drive one tuple through the REAL snapshot-loader -> buildTickInput ->
 * strategy.tick, resolving the strategy from the registry by the recorded name.
 * Returns the assembled input and the strategy's decisions for the caller to
 * assert against the recorded tuple.
 */
export const replayTuple = async (
  registry: StrategyRegistry,
  tuple: FrameTuple,
): Promise<ReplayResult> => {
  const strategy = registry.get(tuple.profile.strategyName);
  if (!strategy) throw new Error(`strategy not registered: ${tuple.profile.strategyName}`);

  // Drive the REAL snapshot-loader over the fake Redis so the key ordering is
  // part of the gate, then rebuild RawSnapshot and feed the REAL assembler.
  const deps = makeDeps(tuple);
  const raw: RawSnapshot = await readRawSnapshot(deps.redis, {
    accountId: asAccountId(tuple.profile.userId),
    profileId: asProfileId(tuple.profile.profileId),
    symbol: tuple.profile.symbol,
    intervals: tuple.intervals,
    nowMs: NOW_MS,
  });

  const built = await buildTickInput(deps, {
    profile: makeProfileContext(tuple, strategy),
    strategy,
    raw,
    intervals: tuple.intervals,
    clock,
    rng,
    trigger: tuple.trigger,
    livePrice: tuple.livePrice,
    // Replay is offline: nothing may write back to Redis, so the ticket records
    // and does nothing else.
    overrideTicket: createRecordingOverrideTicket().ticket,
  });
  if (built.kind !== 'ready') throw new Error(`expected ready, got ${built.kind}`);

  const output = strategy.tick(built.input) as TickOutput<unknown>;
  return { built, output };
};
