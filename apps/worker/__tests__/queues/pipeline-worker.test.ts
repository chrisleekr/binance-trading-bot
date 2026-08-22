import { describe, expect, it, vi } from 'vitest';
import type { Job, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { BinanceApiError } from '@app/binance';
import { GLOBAL_KEYS, profileRepo, ProfileNotOwnedError } from '@app/db';
import { Decimal } from '@app/money';

import { reconcileHeldQuantity } from '../../src/boot/reconcile-held-quantity.js';
import { registerPipelineWorker } from '../../src/queues/pipeline-worker.js';
import { buildSymbolInfoKey } from '../../src/executor/redis-namespace.js';
import { createChainByKey } from '../../src/lib/chain-by-key.js';
import type { ChainByKey } from '../../src/lib/chain-by-key.js';
import {
  createProfileManager,
  type MarketSubscriberHooks,
} from '../../src/profile-manager/profile-manager.js';
import type { QueueSet } from '../../src/queues/queue-set.js';
import type { PipelineWorkerDeps } from '../../src/queues/pipeline-worker.js';

// Hoisted repo mocks so the worker's scoped `p.*` calls hit our spies
// without requiring a real Postgres. `profileRepo` is mocked to return a
// `ProfileRepo` stub whose nested methods are these spies. Each test
// resets them via buildHarness.
const repoMocks = vi.hoisted(() => ({
  ordersFindById: vi.fn(),
  ordersListLiveForSymbol: vi.fn(),
  ordersListRecoveryAttributionRows: vi.fn(),
  tradeArchiveLatestArchivedAt: vi.fn(),
  tradeArchiveSummarizeArchiveSince: vi.fn(),
  tradeArchiveListClosedSince: vi.fn(),
  tradeArchiveListForSymbol: vi.fn(),
  tradeArchiveInsert: vi.fn(),
  tradeArchiveRecordBackfillAttempt: vi.fn(),
  tradeArchiveAttemptBoundary: vi.fn(async () => new Date('2026-08-01T00:00:00Z')),
  avgEntryPricesRemove: vi.fn(),
  avgEntryPricesFindBySymbol: vi.fn(),
  avgEntryPricesUpsert: vi.fn(),
  symbolStatesFindBySymbol: vi.fn(),
  profilesFindById: vi.fn(),
  apiKeysFindByProfile: vi.fn(),
  apiKeysSetVerification: vi.fn(),
  profileSymbolsListForProfile: vi.fn(),
  profileSymbolsFindForSymbol: vi.fn(),
  binanceGetAccount: vi.fn(),
  binanceGetMyTrades: vi.fn(),
  binanceGetPriceTickers: vi.fn(),
  // Per-account resolution: credentials + Binance mode live on the account now.
  binanceModeById: vi.fn(),
  accountGet: vi.fn(),
  apiKeysFindForAccount: vi.fn(),
}));

// `handleVerifyKey` constructs a per-profile REST client through this factory;
// stub it so getAccount can resolve/reject per test without a real Binance.
// The relative source path (not the `profile-bindings/*` tsconfig alias) is
// used because vitest does not resolve the alias when registering the mock,
// so an alias specifier silently passes through to the real client.
vi.mock('../../src/profile-bindings/binance-client.js', () => ({
  buildBinanceClient: () => ({ getAccount: repoMocks.binanceGetAccount }),
}));

vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return {
    ...orig,
    profileRepo: vi.fn(async () => ({
      scope: {},
      profile: {
        findById: repoMocks.profilesFindById,
      },
      orders: {
        findById: repoMocks.ordersFindById,
        listLiveForSymbol: repoMocks.ordersListLiveForSymbol,
        listRecoveryAttributionRows: repoMocks.ordersListRecoveryAttributionRows,
      },
      tradeArchive: {
        latestArchivedAt: repoMocks.tradeArchiveLatestArchivedAt,
        summarizeArchiveSince: repoMocks.tradeArchiveSummarizeArchiveSince,
        listClosedSince: repoMocks.tradeArchiveListClosedSince,
        listForSymbol: repoMocks.tradeArchiveListForSymbol,
        insert: repoMocks.tradeArchiveInsert,
        recordBackfillAttempt: repoMocks.tradeArchiveRecordBackfillAttempt,
        attemptBoundary: repoMocks.tradeArchiveAttemptBoundary,
      },
      avgEntryPrices: {
        remove: repoMocks.avgEntryPricesRemove,
        findBySymbol: repoMocks.avgEntryPricesFindBySymbol,
        upsert: repoMocks.avgEntryPricesUpsert,
      },
      symbolStates: { findBySymbol: repoMocks.symbolStatesFindBySymbol },
      apiKeys: {
        findByProfile: repoMocks.apiKeysFindByProfile,
        setVerification: repoMocks.apiKeysSetVerification,
      },
      profileSymbols: {
        listForProfile: repoMocks.profileSymbolsListForProfile,
        findForSymbol: repoMocks.profileSymbolsFindForSymbol,
      },
    })),
    // verify-key now resolves per-account credentials + mode through accountRepo.
    accountRepo: vi.fn(async () => ({
      account: { get: repoMocks.accountGet },
      apiKeys: {
        findForAccount: repoMocks.apiKeysFindForAccount,
        setVerification: repoMocks.apiKeysSetVerification,
      },
    })),
    // Binance mode is an account attribute; the archive + reconfigure paths read
    // it via repo.accounts.binanceModeById (routed through the mocked db).
    repo: {
      ...orig.repo,
      accounts: { ...orig.repo.accounts, binanceModeById: repoMocks.binanceModeById },
    },
  };
});

interface Harness {
  invoke: (name: string, data: unknown) => Promise<void>;
  enabled: ReturnType<typeof vi.fn>;
  disabled: ReturnType<typeof vi.fn>;
  warnings: { ctx: unknown; msg: string }[];
  info: { ctx: unknown; msg: string }[];
  setTechnicalsIntervals: ReturnType<typeof vi.fn>;
  setSymbols: ReturnType<typeof vi.fn>;
  executorApply: ReturnType<typeof vi.fn>;
  redis: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
  // Configurable `StrategyRegistry.get` so reset-grid-trade tests can supply
  // a strategy carrying the position capability + `reset-grid` operator action.
  // Defaults to undefined (unknown strategy) for the subscribe/dispatch tests.
  evictProfileContext: ReturnType<typeof vi.fn>;
  strategiesGet: ReturnType<typeof vi.fn>;
  statePortMutate: ReturnType<typeof vi.fn>;
  resolveBinanceClient: ReturnType<typeof vi.fn>;
  chainKeys: string[];
  persistedSymbolStates: { symbol: string; state: unknown; version: string }[];
  reconcileOwnership: ReturnType<typeof vi.fn>;
}

// Schema-agnostic stand-in for a strategy with the position capability and the
// `reset-grid` operator action. `clearPosition` clears the per-cycle fields
// (and the grid index when asked) for any object body; returns null for a
// non-object. Decoupled from any concrete strategy's schema — TT's real adapter
// is covered by its own unit test.
const fakeStrategy = {
  position: {
    clearPosition: (state: unknown, opts?: { resetGridIndex?: boolean }) =>
      state && typeof state === 'object'
        ? {
            ...(state as Record<string, unknown>),
            avgEntryPrice: null,
            highSinceBuy: null,
            ...(opts?.resetGridIndex ? { currentGridTradeIndex: null } : {}),
          }
        : null,
  },
  capabilities: { operatorActions: ['reset-grid'] },
};

const buildHarness = (
  pmHandlers: Partial<{
    enable: (...a: unknown[]) => Promise<void>;
    disable: (...a: unknown[]) => Promise<void>;
    setTechnicalsIntervals: (profileId: unknown, intervals: readonly string[]) => boolean;
    setSymbols: (
      profileId: unknown,
      symbols: readonly string[],
      candleInterval?: string,
    ) => Promise<void>;
  }> = {},
  // Optional real (or deferring) chain so a serialization test can prove
  // overlapping jobs are mutually excluded. Defaults to the inline pass-
  // through chain the dispatch tests rely on.
  chainOverride?: ChainByKey,
): Harness => {
  const warnings: { ctx: unknown; msg: string }[] = [];
  const info: { ctx: unknown; msg: string }[] = [];
  const chainKeys: string[] = [];
  const enabled = vi.fn(pmHandlers.enable ?? (async () => undefined));
  const disabled = vi.fn(pmHandlers.disable ?? (async () => undefined));
  const setTechnicalsIntervals = vi.fn(pmHandlers.setTechnicalsIntervals ?? (() => true));
  const setSymbols = vi.fn(pmHandlers.setSymbols ?? (async () => undefined));
  const executorApply = vi.fn(async () => ({ ok: true as const }));
  const redisGet = vi.fn(async () => null);
  const redisSet = vi.fn(async () => 'OK');
  const redisDel = vi.fn(async () => 1);
  const strategiesGet = vi.fn(() => undefined as unknown);
  const statePortMutate = vi.fn(async () => undefined);
  const evictProfileContext = vi.fn();
  const reconcileOwnership = vi.fn(async () => undefined);
  // Default: a client exposing getMyTrades + getAccount (wired to the hoisted
  // spies). Tests override the spy's return per case (null client / thrown
  // call) to exercise the fee-degrade and reconcile branches.
  const resolveBinanceClient = vi.fn(async () => ({
    getMyTrades: repoMocks.binanceGetMyTrades,
    getAccount: repoMocks.binanceGetAccount,
    getPriceTickers: repoMocks.binanceGetPriceTickers,
  }));
  // Captures every persistSymbolState write the mid-run reconcile drives, so a
  // wiring test can assert the symbol_states body carried heldQuantity +
  // avgEntryPrice. Routed into symbolStateDeps below.
  const persistedSymbolStates: { symbol: string; state: unknown; version: string }[] = [];
  const persistSymbolState = vi.fn(
    async (
      _scope: unknown,
      symbol: string,
      state: unknown,
      version: string,
      _expectedVersion: number | null,
    ): Promise<boolean> => {
      persistedSymbolStates.push({ symbol, state, version });
      return true;
    },
  );

  for (const k of Object.keys(repoMocks) as (keyof typeof repoMocks)[]) {
    repoMocks[k].mockReset();
  }
  // Default account mode is live; the #582 test overrides it once to 'test'.
  repoMocks.binanceModeById.mockResolvedValue('live');
  repoMocks.ordersListRecoveryAttributionRows.mockResolvedValue([]);
  // Empty by default so the reconfigure reconcile's batched price fetch resolves rather than returning undefined; cases that exercise the fallback override it.
  repoMocks.binanceGetPriceTickers.mockResolvedValue([]);

  let captured: ((job: Job) => Promise<void>) | null = null;
  const queueSet: QueueSet = {
    queues: {} as QueueSet['queues'],
    workers: [],
    enqueueDlq: vi.fn(async () => undefined),
    registerWorker: ((_name: string, handler: (job: Job) => Promise<void>) => {
      captured = handler;
      return {} as Worker;
    }) as unknown as QueueSet['registerWorker'],
    closeAll: vi.fn(async () => undefined),
  };
  const logger: Logger = {
    warn: (ctx: unknown, msg: string) => {
      warnings.push({ ctx, msg });
    },
    info: (ctx: unknown, msg: string) => {
      info.push({ ctx, msg });
    },
    debug: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
    child() {
      return this;
    },
  } as unknown as Logger;
  const deps = {
    db: {} as PipelineWorkerDeps['db'],
    redis: {
      get: redisGet,
      set: redisSet,
      del: redisDel,
    } as unknown as Redis,
    profileManager: {
      enable: enabled,
      disable: disabled,
      setTechnicalsIntervals,
      setSymbols,
    } as unknown as PipelineWorkerDeps['profileManager'],
    strategies: {
      get: strategiesGet,
    } as unknown as PipelineWorkerDeps['strategies'],
    executor: { apply: executorApply } as unknown as PipelineWorkerDeps['executor'],
    statePort: { mutate: statePortMutate } as unknown as PipelineWorkerDeps['statePort'],
    clock: { nowMs: () => 1_700_000_000_000 },
    // Inline pass-through chain: runs the function immediately so the
    // tests assert on the same execution semantics the production
    // serial-by-key chain provides, without spinning a real one.
    // `chainKeys` captures every `${profileId}:${symbol}` the handler
    // routes through so tests can verify the chain integration uses
    // the tick handler's canonical key shape (a regression that
    // changed the key would silently break cross-queue serialisation).
    chain: chainOverride ?? {
      run: async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
        chainKeys.push(key);
        return fn();
      },
      size: () => 0,
    },
    logger,
    resolveBinanceClient:
      resolveBinanceClient as unknown as PipelineWorkerDeps['resolveBinanceClient'],
    evictProfileContext,
    symbolStateDeps: {
      redis: { get: redisGet, set: redisSet, del: redisDel } as unknown as Redis,
      logger,
      registry: { get: strategiesGet },
      persistSymbolState,
    } as unknown as PipelineWorkerDeps['symbolStateDeps'],
    reconcileOwnership,
    // The reconfigure/disable notify wrapper resolves providers through this; no test here drives a notification, so an empty registry is the whole surface they need.
    notifyRegistry: {} as PipelineWorkerDeps['notifyRegistry'],
    // Required by the dep bag because the mid-run reconcile below records position removals through it; no case here asserts a counter, so a no-op is the whole surface needed.
    metrics: { record: vi.fn(), forget: vi.fn() },
  } satisfies PipelineWorkerDeps;
  registerPipelineWorker(queueSet, deps);
  if (captured === null) throw new Error('test setup: registerWorker did not capture handler');

  return {
    invoke: async (name, data) => {
      if (captured === null) throw new Error('handler not captured');
      await captured({ name, data, id: 'test-job' } as unknown as Job);
    },
    enabled,
    disabled,
    warnings,
    info,
    setTechnicalsIntervals,
    setSymbols,
    evictProfileContext,
    executorApply,
    redis: { get: redisGet, set: redisSet, del: redisDel },
    strategiesGet,
    statePortMutate,
    resolveBinanceClient,
    chainKeys,
    persistedSymbolStates,
    reconcileOwnership,
  };
};

const ids = {
  userId: asUserId('00000000-0000-0000-0000-00000000aaaa'),
  accountId: asAccountId('00000000-0000-0000-0000-00000000cccc'),
  profileId: asProfileId('00000000-0000-0000-0000-00000000bbbb'),
};

describe('pipeline-worker dispatch', () => {
  it('cancel-order: resolves UUID and emits a cancel-order Decision through the executor', async () => {
    const h = buildHarness();
    repoMocks.ordersFindById.mockResolvedValueOnce({
      id: 'order-uuid-1',
      symbol: 'BTCUSDT',
      binanceOrderId: 42n,
      closedAt: null,
    });
    await h.invoke('cancel-order', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
      orderId: 'order-uuid-1',
    });
    expect(h.executorApply).toHaveBeenCalledTimes(1);
    const firstCall = h.executorApply.mock.calls[0];
    if (!firstCall) throw new Error('expected executorApply to be called');
    const [ctx, accountId, decision] = firstCall;
    // Executor ctx stays operator/profile-scoped; the account is a separate
    // positional arg so the executor resolves per-account credentials.
    expect(ctx).toMatchObject({ userId: ids.userId, profileId: ids.profileId });
    expect(accountId).toBe(ids.accountId);
    expect(decision).toEqual({ type: 'cancel-order', orderId: 42, reason: 'manual-cancel' });
  });

  it('cancel-order: warn-and-ack when the row is missing (idempotent retry)', async () => {
    const h = buildHarness();
    repoMocks.ordersFindById.mockResolvedValueOnce(null);
    await h.invoke('cancel-order', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
      orderId: 'gone',
    });
    expect(h.executorApply).not.toHaveBeenCalled();
    expect(h.warnings.some((w) => /row_missing/.test(w.msg))).toBe(true);
  });

  it('cancel-order: refuses a symbol mismatch (operator URL bug or tenant cross-talk)', async () => {
    const h = buildHarness();
    repoMocks.ordersFindById.mockResolvedValueOnce({
      id: 'order-uuid-2',
      symbol: 'ETHUSDT',
      binanceOrderId: 99n,
      closedAt: null,
    });
    await h.invoke('cancel-order', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
      orderId: 'order-uuid-2',
    });
    expect(h.executorApply).not.toHaveBeenCalled();
    expect(h.warnings.some((w) => /symbol_mismatch/.test(w.msg))).toBe(true);
  });

  it('cancel-order: idempotent ack when the row is already closed (no executor call)', async () => {
    const h = buildHarness();
    repoMocks.ordersFindById.mockResolvedValueOnce({
      id: 'order-uuid-3',
      symbol: 'BTCUSDT',
      binanceOrderId: 7n,
      status: 'FILLED',
      closedAt: new Date(),
    });
    await h.invoke('cancel-order', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
      orderId: 'order-uuid-3',
    });
    expect(h.executorApply).not.toHaveBeenCalled();
    expect(h.info.some((i) => /already_closed/.test(i.msg))).toBe(true);
  });

  it('cancel-order: rethrows when the executor returns a retryable failure (BullMQ retries it)', async () => {
    const h = buildHarness();
    repoMocks.ordersFindById.mockResolvedValueOnce({
      id: 'order-uuid-4',
      symbol: 'BTCUSDT',
      binanceOrderId: 11n,
      closedAt: null,
    });
    h.executorApply.mockResolvedValueOnce({ ok: false, retryable: true, reason: 'network blip' });
    await expect(
      h.invoke('cancel-order', {
        userId: ids.userId,
        accountId: ids.accountId,
        profileId: ids.profileId,
        symbol: 'BTCUSDT',
        orderId: 'order-uuid-4',
      }),
    ).rejects.toThrow(/retryable failure/);
  });

  it('cancel-order: refuses a binance_order_id that exceeds the safe integer range', async () => {
    const h = buildHarness();
    repoMocks.ordersFindById.mockResolvedValueOnce({
      id: 'order-uuid-5',
      symbol: 'BTCUSDT',
      binanceOrderId: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      closedAt: null,
    });
    await expect(
      h.invoke('cancel-order', {
        userId: ids.userId,
        accountId: ids.accountId,
        profileId: ids.profileId,
        symbol: 'BTCUSDT',
        orderId: 'order-uuid-5',
      }),
    ).rejects.toThrow(/safe integer/);
    expect(h.executorApply).not.toHaveBeenCalled();
  });

  it('archive-grid-trade: inserts a trade_archive row with SQL-computed totals, generic breakdown, and orders jsonb', async () => {
    const h = buildHarness();
    repoMocks.profilesFindById.mockResolvedValueOnce({ binanceMode: 'live' });
    h.redis.get.mockResolvedValueOnce(
      JSON.stringify({ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' }),
    );
    repoMocks.tradeArchiveLatestArchivedAt.mockResolvedValueOnce(null);
    repoMocks.tradeArchiveSummarizeArchiveSince.mockResolvedValueOnce({
      totalBuyQuote: '100',
      totalSellQuote: '110',
      breakdown: { 'grid-buy:BUY': '100', 'grid-sell:SELL': '110' },
      profit: '10',
      profitPercent: '10',
      orderCount: 2,
      missingCostBasis: 0,
    });
    repoMocks.tradeArchiveListClosedSince.mockResolvedValueOnce([
      {
        id: 'r1',
        binanceOrderId: 1n,
        clientOrderId: 'c1',
        intent: 'grid-buy',
        side: 'BUY',
        status: 'FILLED',
        meta: { gridTradeIndex: 0 },
        closedAt: new Date('2026-05-13T00:00:00Z'),
        raw: { cummulativeQuoteQty: '100' },
      },
      {
        id: 'r2',
        binanceOrderId: 2n,
        clientOrderId: 'c2',
        intent: 'grid-sell',
        side: 'SELL',
        status: 'FILLED',
        meta: null,
        closedAt: new Date('2026-05-13T00:01:00Z'),
        raw: { cummulativeQuoteQty: '110' },
      },
    ]);
    repoMocks.tradeArchiveInsert.mockResolvedValueOnce({ id: 'archive-1' });
    repoMocks.profileSymbolsFindForSymbol.mockResolvedValueOnce({
      symbol: 'BTCUSDT',
      source: 'auto',
    });
    // myTrades carries both archived orders plus a stray older-cycle trade
    // (orderId 99) that must NOT be summed into the fees.
    repoMocks.binanceGetMyTrades.mockResolvedValueOnce([
      { orderId: 1, commission: '0.001', commissionAsset: 'BNB' },
      { orderId: 2, commission: '0.0015', commissionAsset: 'BNB' },
      { orderId: 2, commission: '0.11', commissionAsset: 'USDT' },
      { orderId: 99, commission: '5', commissionAsset: 'USDT' },
    ]);
    await h.invoke('archive-grid-trade', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });
    // The archive read the symbol-info keyspace for this profile's mode (#582).
    expect(h.redis.get).toHaveBeenCalledWith(buildSymbolInfoKey('BTCUSDT', 'live'));
    expect(repoMocks.tradeArchiveInsert).toHaveBeenCalledTimes(1);
    const args = repoMocks.tradeArchiveInsert.mock.calls[0];
    if (!args) throw new Error('expected tradeArchive.insert to be called');
    expect(args[0]).toMatchObject({
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      profit: '10',
      profitPercent: '10',
      totalBuyQuote: '100',
      totalSellQuote: '110',
      breakdown: { 'grid-buy:BUY': '100', 'grid-sell:SELL': '110' },
      // Fees summed per asset over the archived orders only (orderId 99 excluded).
      fees: { BNB: '0.0025', USDT: '0.11' },
      // Source stamped from the live profile_symbols binding.
      source: 'auto',
      // Cross-pod dedup key = the first closed order the handler read (rows[0]),
      // which production orders desc(closedAt) to the cycle's max close time.
      cycleEnd: new Date('2026-05-13T00:00:00Z'),
    });
    // Every FILLED row is summarised into the generic `orders` jsonb.
    expect((args[0] as { orders: unknown[] }).orders).toHaveLength(2);
    // myTrades is scoped to the symbol and pulls the max page (limit 1000).
    expect(repoMocks.binanceGetMyTrades).toHaveBeenCalledWith({ symbol: 'BTCUSDT', limit: 1000 });
  });

  it('archive-grid-trade: a null insert (concurrent consumer already archived) is a clean no-op', async () => {
    const h = buildHarness();
    h.redis.get.mockResolvedValueOnce(
      JSON.stringify({ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' }),
    );
    repoMocks.tradeArchiveLatestArchivedAt.mockResolvedValueOnce(null);
    repoMocks.tradeArchiveSummarizeArchiveSince.mockResolvedValueOnce({
      totalBuyQuote: '100',
      totalSellQuote: '110',
      breakdown: {},
      profit: '10',
      profitPercent: '10',
      orderCount: 1,
      missingCostBasis: 0,
    });
    repoMocks.tradeArchiveListClosedSince.mockResolvedValueOnce([
      {
        id: 'r1',
        binanceOrderId: 1n,
        clientOrderId: 'c1',
        intent: 'grid-sell',
        side: 'SELL',
        status: 'FILLED',
        meta: null,
        closedAt: new Date('2026-05-13T00:00:00Z'),
        raw: { cummulativeQuoteQty: '110' },
      },
    ]);
    repoMocks.profileSymbolsFindForSymbol.mockResolvedValueOnce({
      symbol: 'BTCUSDT',
      source: 'auto',
    });
    repoMocks.binanceGetMyTrades.mockResolvedValueOnce([]);
    // The partial unique index collapsed our insert — repo returns null.
    repoMocks.tradeArchiveInsert.mockResolvedValueOnce(null);

    // The handler must swallow the dedup and return without throwing.
    await expect(
      h.invoke('archive-grid-trade', {
        userId: ids.userId,
        accountId: ids.accountId,
        profileId: ids.profileId,
        symbol: 'BTCUSDT',
      }),
    ).resolves.toBeUndefined();
    expect(repoMocks.tradeArchiveInsert).toHaveBeenCalledTimes(1);
  });

  it('archive-grid-trade: warns when a SELL has no cost basis (under-count surfaced, still inserts)', async () => {
    const h = buildHarness();
    h.redis.get.mockResolvedValueOnce(
      JSON.stringify({ symbol: 'XPLUSDT', baseAsset: 'XPL', quoteAsset: 'USDT' }),
    );
    repoMocks.tradeArchiveLatestArchivedAt.mockResolvedValueOnce(null);
    // An un-costed adopted sale: the aggregator excluded it from profit and
    // reports missingCostBasis > 0, so the handler must surface the under-count.
    repoMocks.tradeArchiveSummarizeArchiveSince.mockResolvedValueOnce({
      totalBuyQuote: '0',
      totalSellQuote: '0',
      breakdown: { 'protective-stop:SELL': '29.01' },
      profit: '0',
      profitPercent: '0',
      orderCount: 1,
      missingCostBasis: 1,
    });
    repoMocks.tradeArchiveListClosedSince.mockResolvedValueOnce([
      {
        id: 'r1',
        binanceOrderId: 1n,
        clientOrderId: 'c1',
        intent: 'protective-stop',
        side: 'SELL',
        status: 'FILLED',
        meta: null,
        closedAt: new Date('2026-06-14T13:31:00Z'),
        raw: { cummulativeQuoteQty: '29.01' },
      },
    ]);
    repoMocks.tradeArchiveInsert.mockResolvedValueOnce({ id: 'archive-2' });
    repoMocks.profileSymbolsFindForSymbol.mockResolvedValueOnce({
      symbol: 'XPLUSDT',
      source: 'auto',
    });
    repoMocks.binanceGetMyTrades.mockResolvedValueOnce([]);

    await h.invoke('archive-grid-trade', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'XPLUSDT',
    });

    expect(h.warnings.some((w) => /missing_cost_basis/.test(w.msg))).toBe(true);
    // The archive still inserts (a conservative under-count, not a failure).
    expect(repoMocks.tradeArchiveInsert).toHaveBeenCalledTimes(1);
  });

  it('archive-grid-trade: fees={} + warn + still inserts when resolveBinanceClient rejects', async () => {
    const h = buildHarness();
    h.resolveBinanceClient.mockRejectedValueOnce(new Error('profile bindings unavailable'));
    h.redis.get.mockResolvedValueOnce(
      JSON.stringify({ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' }),
    );
    repoMocks.tradeArchiveLatestArchivedAt.mockResolvedValueOnce(null);
    repoMocks.tradeArchiveSummarizeArchiveSince.mockResolvedValueOnce({
      totalBuyQuote: '100',
      totalSellQuote: '110',
      breakdown: { 'grid-buy:BUY': '100' },
      profit: '10',
      profitPercent: '10',
      orderCount: 1,
    });
    repoMocks.tradeArchiveListClosedSince.mockResolvedValueOnce([
      {
        id: 'r1',
        binanceOrderId: 1n,
        clientOrderId: 'c1',
        intent: 'grid-buy',
        side: 'BUY',
        status: 'FILLED',
        meta: null,
        closedAt: new Date('2026-05-13T00:00:00Z'),
        raw: { cummulativeQuoteQty: '100' },
      },
    ]);
    repoMocks.profileSymbolsFindForSymbol.mockResolvedValueOnce({
      symbol: 'BTCUSDT',
      source: 'manual',
    });
    repoMocks.tradeArchiveInsert.mockResolvedValueOnce({ id: 'archive-4' });
    await h.invoke('archive-grid-trade', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });
    const args = repoMocks.tradeArchiveInsert.mock.calls[0];
    if (!args) throw new Error('expected tradeArchive.insert to be called');
    expect((args[0] as { fees: unknown }).fees).toEqual({});
    expect(h.warnings.some((w) => /fees_unavailable/.test(w.msg))).toBe(true);
    // The fee fetch never ran (the client never resolved) but the archive lands.
    expect(repoMocks.binanceGetMyTrades).not.toHaveBeenCalled();
    expect(repoMocks.tradeArchiveInsert).toHaveBeenCalledTimes(1);
  });

  it('archive-grid-trade: emits fees_partial warn when an archived order matched no returned trade', async () => {
    const h = buildHarness();
    h.redis.get.mockResolvedValueOnce(
      JSON.stringify({ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' }),
    );
    repoMocks.tradeArchiveLatestArchivedAt.mockResolvedValueOnce(null);
    repoMocks.tradeArchiveSummarizeArchiveSince.mockResolvedValueOnce({
      totalBuyQuote: '200',
      totalSellQuote: '210',
      breakdown: { 'grid-buy:BUY': '200' },
      profit: '10',
      profitPercent: '5',
      orderCount: 2,
    });
    repoMocks.tradeArchiveListClosedSince.mockResolvedValueOnce([
      {
        id: 'r1',
        binanceOrderId: 1n,
        clientOrderId: 'c1',
        intent: 'grid-buy',
        side: 'BUY',
        status: 'FILLED',
        meta: null,
        closedAt: new Date('2026-05-13T00:00:00Z'),
        raw: { cummulativeQuoteQty: '100' },
      },
      {
        id: 'r2',
        binanceOrderId: 2n,
        clientOrderId: 'c2',
        intent: 'grid-buy',
        side: 'BUY',
        status: 'FILLED',
        meta: null,
        closedAt: new Date('2026-05-13T00:01:00Z'),
        raw: { cummulativeQuoteQty: '100' },
      },
    ]);
    // Only order 1's trade survives on the page; order 2 fell off (truncation).
    repoMocks.binanceGetMyTrades.mockResolvedValueOnce([
      { orderId: 1, commission: '0.001', commissionAsset: 'BNB' },
    ]);
    repoMocks.profileSymbolsFindForSymbol.mockResolvedValueOnce({
      symbol: 'BTCUSDT',
      source: 'manual',
    });
    repoMocks.tradeArchiveInsert.mockResolvedValueOnce({ id: 'archive-5' });
    await h.invoke('archive-grid-trade', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });
    const args = repoMocks.tradeArchiveInsert.mock.calls[0];
    if (!args) throw new Error('expected tradeArchive.insert to be called');
    // The partial fees still land (order 1's commission).
    expect((args[0] as { fees: unknown }).fees).toEqual({ BNB: '0.001' });
    const partial = h.warnings.find((w) => /fees_partial/.test(w.msg));
    expect(partial).toBeDefined();
    expect((partial?.ctx as { missingOrderIds: number }).missingOrderIds).toBe(1);
    expect(repoMocks.tradeArchiveInsert).toHaveBeenCalledTimes(1);
  });

  it('archive-grid-trade: fees={} + warn + still inserts when no binance client is resolvable', async () => {
    const h = buildHarness();
    h.resolveBinanceClient.mockResolvedValueOnce(null);
    h.redis.get.mockResolvedValueOnce(
      JSON.stringify({ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' }),
    );
    repoMocks.tradeArchiveLatestArchivedAt.mockResolvedValueOnce(null);
    repoMocks.tradeArchiveSummarizeArchiveSince.mockResolvedValueOnce({
      totalBuyQuote: '100',
      totalSellQuote: '110',
      breakdown: { 'grid-buy:BUY': '100' },
      profit: '10',
      profitPercent: '10',
      orderCount: 1,
    });
    repoMocks.tradeArchiveListClosedSince.mockResolvedValueOnce([
      {
        id: 'r1',
        binanceOrderId: 1n,
        clientOrderId: 'c1',
        intent: 'grid-buy',
        side: 'BUY',
        status: 'FILLED',
        meta: null,
        closedAt: new Date('2026-05-13T00:00:00Z'),
        raw: { cummulativeQuoteQty: '100' },
      },
    ]);
    repoMocks.tradeArchiveInsert.mockResolvedValueOnce({ id: 'archive-2' });
    await h.invoke('archive-grid-trade', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });
    const args = repoMocks.tradeArchiveInsert.mock.calls[0];
    if (!args) throw new Error('expected tradeArchive.insert to be called');
    expect((args[0] as { fees: unknown }).fees).toEqual({});
    // No binding row -> source falls back to manual.
    expect((args[0] as { source: unknown }).source).toBe('manual');
    expect(h.warnings.some((w) => /fees_unavailable/.test(w.msg))).toBe(true);
    expect(repoMocks.binanceGetMyTrades).not.toHaveBeenCalled();
  });

  it('archive-grid-trade: fees={} + warn + still inserts when getMyTrades throws', async () => {
    const h = buildHarness();
    h.redis.get.mockResolvedValueOnce(
      JSON.stringify({ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' }),
    );
    repoMocks.tradeArchiveLatestArchivedAt.mockResolvedValueOnce(null);
    repoMocks.tradeArchiveSummarizeArchiveSince.mockResolvedValueOnce({
      totalBuyQuote: '100',
      totalSellQuote: '110',
      breakdown: { 'grid-buy:BUY': '100' },
      profit: '10',
      profitPercent: '10',
      orderCount: 1,
    });
    repoMocks.tradeArchiveListClosedSince.mockResolvedValueOnce([
      {
        id: 'r1',
        binanceOrderId: 1n,
        clientOrderId: 'c1',
        intent: 'grid-buy',
        side: 'BUY',
        status: 'FILLED',
        meta: null,
        closedAt: new Date('2026-05-13T00:00:00Z'),
        raw: { cummulativeQuoteQty: '100' },
      },
    ]);
    repoMocks.binanceGetMyTrades.mockRejectedValueOnce(new Error('binance down'));
    repoMocks.profileSymbolsFindForSymbol.mockResolvedValueOnce({
      symbol: 'BTCUSDT',
      source: 'manual',
    });
    repoMocks.tradeArchiveInsert.mockResolvedValueOnce({ id: 'archive-3' });
    await h.invoke('archive-grid-trade', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });
    const args = repoMocks.tradeArchiveInsert.mock.calls[0];
    if (!args) throw new Error('expected tradeArchive.insert to be called');
    expect((args[0] as { fees: unknown }).fees).toEqual({});
    expect(h.warnings.some((w) => /fees_unavailable/.test(w.msg))).toBe(true);
    // The archive still inserts despite the fee call failing.
    expect(repoMocks.tradeArchiveInsert).toHaveBeenCalledTimes(1);
  });

  it('archive-grid-trade: skips the insert when no FILLED rows exist past the cutoff', async () => {
    const h = buildHarness();
    h.redis.get.mockResolvedValueOnce(
      JSON.stringify({ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' }),
    );
    repoMocks.tradeArchiveLatestArchivedAt.mockResolvedValueOnce(new Date('2026-05-13T00:00:00Z'));
    repoMocks.tradeArchiveSummarizeArchiveSince.mockResolvedValueOnce(null);
    await h.invoke('archive-grid-trade', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });
    expect(repoMocks.tradeArchiveInsert).not.toHaveBeenCalled();
    expect(h.info.some((i) => /nothing_to_archive/.test(i.msg))).toBe(true);
  });

  it('archive-grid-trade: throws when the symbol-info snapshot is missing (cron not yet primed)', async () => {
    const h = buildHarness();
    h.redis.get.mockResolvedValueOnce(null);
    await expect(
      h.invoke('archive-grid-trade', {
        userId: ids.userId,
        accountId: ids.accountId,
        profileId: ids.profileId,
        symbol: 'BTCUSDT',
      }),
    ).rejects.toThrow(/symbol-info missing/);
    expect(repoMocks.tradeArchiveInsert).not.toHaveBeenCalled();
  });

  it('archive-grid-trade: reads the testnet symbol-info keyspace for a test-mode profile (#582)', async () => {
    const h = buildHarness();
    repoMocks.binanceModeById.mockResolvedValueOnce('test');
    // No symbol-info under any key → throws; we assert only the keyspace read.
    h.redis.get.mockResolvedValue(null);
    await expect(
      h.invoke('archive-grid-trade', {
        userId: ids.userId,
        accountId: ids.accountId,
        profileId: ids.profileId,
        symbol: 'BTCUSDT',
      }),
    ).rejects.toThrow(/symbol-info missing/);
    expect(h.redis.get).toHaveBeenCalledWith(buildSymbolInfoKey('BTCUSDT', 'test'));
    expect(h.redis.get).not.toHaveBeenCalledWith(buildSymbolInfoKey('BTCUSDT', 'live'));
  });

  it('backfill-trade-archive: reconstructs a round-trip from myTrades and inserts a source=auto row', async () => {
    const h = buildHarness();
    h.redis.get.mockResolvedValueOnce(
      JSON.stringify({ symbol: 'WLDUSDT', baseAsset: 'WLD', quoteAsset: 'USDT' }),
    );
    // One full page would loop; a short page (<1000) ends pagination after one call.
    repoMocks.binanceGetMyTrades.mockResolvedValueOnce([
      {
        id: 1,
        orderId: 1,
        symbol: 'WLDUSDT',
        price: '0',
        qty: '30',
        quoteQty: '15',
        commission: '0',
        commissionAsset: 'USDT',
        time: 1000,
        isBuyer: true,
        isMaker: false,
      },
      {
        id: 2,
        orderId: 2,
        symbol: 'WLDUSDT',
        price: '0',
        qty: '30',
        quoteQty: '13',
        commission: '0',
        commissionAsset: 'USDT',
        time: 2000,
        isBuyer: false,
        isMaker: false,
      },
    ]);
    repoMocks.tradeArchiveListForSymbol.mockResolvedValueOnce([]);
    repoMocks.tradeArchiveInsert.mockResolvedValueOnce({ id: 'backfill-1' });
    await h.invoke('backfill-trade-archive', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'WLDUSDT',
      fromMs: null,
      toMs: null,
    });
    expect(repoMocks.tradeArchiveInsert).toHaveBeenCalledTimes(1);
    const args = repoMocks.tradeArchiveInsert.mock.calls[0];
    if (!args) throw new Error('expected tradeArchive.insert to be called');
    expect(args[0]).toMatchObject({ symbol: 'WLDUSDT', source: 'auto', profit: '-2' });
    expect(repoMocks.binanceGetMyTrades).toHaveBeenCalledWith({
      symbol: 'WLDUSDT',
      fromId: 0,
      limit: 1000,
    });
  });

  it('reset-grid-trade: cancels open grid-buy orders, wipes lbp, and clears grid state through the StatePort', async () => {
    const h = buildHarness();
    h.strategiesGet.mockReturnValue(fakeStrategy);
    repoMocks.profilesFindById.mockResolvedValue({
      id: ids.profileId,
      strategyName: 'trailing-trade',
      state: {},
    });
    repoMocks.ordersListLiveForSymbol.mockResolvedValueOnce([
      { binanceOrderId: 100n, side: 'BUY', intent: 'grid-buy' },
      // Non-grid-buy order — left untouched so manual SELLs in flight survive.
      { binanceOrderId: 101n, side: 'SELL', intent: 'grid-sell' },
    ]);
    repoMocks.avgEntryPricesRemove.mockResolvedValueOnce(undefined);
    await h.invoke('reset-grid-trade', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });
    expect(h.executorApply).toHaveBeenCalledTimes(1);
    expect(h.executorApply.mock.calls[0]?.[1]).toBe(ids.accountId);
    expect(h.executorApply.mock.calls[0]?.[2]).toMatchObject({
      type: 'cancel-order',
      orderId: 100,
      reason: 'reset-grid-trade',
    });
    expect(repoMocks.avgEntryPricesRemove).toHaveBeenCalledTimes(1);
    // The grid-state clear routes through the per-(profile, symbol) StatePort
    // (the symbol_states store the tick reads), not the dead profiles.state
    // column. The reconcile/migrate/persist of the mutated body is the
    // StatePort spine's responsibility, covered by its own tests; here we
    // assert the dispatch routes the reset through it and the mutator applies
    // the strategy's grid-reset.
    expect(h.statePortMutate).toHaveBeenCalledTimes(1);
    expect(h.statePortMutate.mock.calls[0]?.[1]).toBe('BTCUSDT');
    const mutator = h.statePortMutate.mock.calls[0]?.[2] as ((s: unknown) => unknown) | undefined;
    expect(mutator).toBeDefined();
    expect(
      mutator?.({ currentGridTradeIndex: 1, avgEntryPrice: '100', highSinceBuy: '110' }),
    ).toMatchObject({ avgEntryPrice: null, highSinceBuy: null, currentGridTradeIndex: null });
  });

  it('reset-grid-trade: aborts when a cancel returns non-retryable so a live grid-buy never coexists with a wiped local state', async () => {
    const h = buildHarness();
    repoMocks.ordersListLiveForSymbol.mockResolvedValueOnce([
      { binanceOrderId: 50n, side: 'BUY', intent: 'grid-buy' },
    ]);
    h.executorApply.mockResolvedValueOnce({
      ok: false,
      retryable: false,
      reason: 'order not in our books',
    });
    await expect(
      h.invoke('reset-grid-trade', {
        userId: ids.userId,
        accountId: ids.accountId,
        profileId: ids.profileId,
        symbol: 'BTCUSDT',
      }),
    ).rejects.toThrow(/cancel failed.*retryable=false/);
    // State wipe MUST NOT run when a cancel hasn't completed.
    expect(repoMocks.avgEntryPricesRemove).not.toHaveBeenCalled();
    expect(h.statePortMutate).not.toHaveBeenCalled();
  });

  it('reset-grid-trade: rejects an unsafe binance_order_id rather than silently leaving Binance live', async () => {
    const h = buildHarness();
    repoMocks.ordersListLiveForSymbol.mockResolvedValueOnce([
      {
        binanceOrderId: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        side: 'BUY',
        intent: 'grid-buy',
      },
    ]);
    await expect(
      h.invoke('reset-grid-trade', {
        userId: ids.userId,
        accountId: ids.accountId,
        profileId: ids.profileId,
        symbol: 'BTCUSDT',
      }),
    ).rejects.toThrow(/safe integer/);
    expect(repoMocks.avgEntryPricesRemove).not.toHaveBeenCalled();
  });

  it('routes the three new job names through the chain with the tick handler key shape', async () => {
    const h = buildHarness();
    repoMocks.ordersFindById.mockResolvedValueOnce({
      id: 'o',
      symbol: 'BTCUSDT',
      binanceOrderId: 1n,
      closedAt: null,
    });
    h.redis.get.mockResolvedValueOnce(
      JSON.stringify({ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' }),
    );
    repoMocks.tradeArchiveLatestArchivedAt.mockResolvedValueOnce(null);
    repoMocks.tradeArchiveSummarizeArchiveSince.mockResolvedValueOnce(null);
    repoMocks.ordersListLiveForSymbol.mockResolvedValueOnce([]);
    repoMocks.avgEntryPricesRemove.mockResolvedValueOnce(undefined);
    await h.invoke('cancel-order', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
      orderId: 'o',
    });
    await h.invoke('archive-grid-trade', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });
    await h.invoke('reset-grid-trade', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });
    expect(h.chainKeys).toEqual([
      `${ids.profileId}:BTCUSDT`,
      `${ids.profileId}:BTCUSDT`,
      `${ids.profileId}:BTCUSDT`,
    ]);
  });

  it('reconfigure-profile: resyncs ProfileManager symbols + technicalsIntervals from the DB', async () => {
    // A symbol add/remove or a PATCH that changes `technicals.intervals[]`
    // MUST reach ProfileManager so the tick + technicals-compute cron see
    // the current symbol set on their next tick — without this resync the
    // manager's enable-time snapshot stays frozen until worker restart, so
    // a symbol added after boot is never ticked and gets no technicals.
    const h = buildHarness();
    repoMocks.profilesFindById.mockResolvedValueOnce({
      id: ids.profileId,
      enabled: true,
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.0',
      config: {
        technicals: {
          intervals: [
            { interval: '1h', whenStrongBuy: true, whenBuy: true },
            { interval: '4h', whenStrongBuy: true, whenBuy: true },
            { interval: '1d', whenStrongBuy: true, whenBuy: true },
          ],
        },
      },
    });
    repoMocks.profileSymbolsListForProfile.mockResolvedValueOnce([
      { symbol: 'BTCUSDT' },
      { symbol: 'ETHUSDT' },
      { symbol: 'XRPUSDT' },
    ]);

    await h.invoke('reconfigure-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });

    expect(h.setTechnicalsIntervals).toHaveBeenCalledTimes(1);
    const intervalsCall = h.setTechnicalsIntervals.mock.calls[0];
    expect(intervalsCall?.[0]).toBe(ids.profileId);
    expect(intervalsCall?.[1]).toEqual(['1h', '4h', '1d']);
    expect(h.setSymbols).toHaveBeenCalledTimes(1);
    const symbolsCall = h.setSymbols.mock.calls[0];
    expect(symbolsCall?.[0]).toBe(ids.profileId);
    expect(symbolsCall?.[1]).toEqual(['BTCUSDT', 'ETHUSDT', 'XRPUSDT']);
    // Serialized per profile (keyed on profileId, no symbol suffix) so
    // concurrent resyncs apply read-then-write atomically.
    expect(h.chainKeys).toEqual([ids.profileId]);
    // The edited config must drop the cross-tick context cache so the next
    // tick reads fresh.
    expect(h.evictProfileContext).toHaveBeenCalledWith(ids.profileId);
  });

  it('reconfigure-profile: forwards the resolved candle interval so a hot interval change applies', async () => {
    // A PATCH that changes `candleInterval` must reach ProfileManager.setSymbols
    // as the 3rd arg so the retained symbols re-subscribe to the new interval
    // without a manual stop->start.
    const h = buildHarness();
    h.strategiesGet.mockReturnValue({ capabilities: { candleIntervals: ['5m', '1h'] } });
    repoMocks.profilesFindById.mockResolvedValueOnce({
      id: ids.profileId,
      enabled: true,
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.0',
      config: { candleInterval: '1h' },
    });
    repoMocks.profileSymbolsListForProfile.mockResolvedValueOnce([{ symbol: 'BTCUSDT' }]);

    await h.invoke('reconfigure-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });

    expect(h.setSymbols).toHaveBeenCalledTimes(1);
    const symbolsCall = h.setSymbols.mock.calls[0];
    expect(symbolsCall?.[1]).toEqual(['BTCUSDT']);
    expect(symbolsCall?.[2]).toBe('1h');
  });

  it('reconfigure-profile: keeps the interval (undefined 3rd arg) when the plugin is unknown', async () => {
    // Config drift: the strategy is gone but the symbol diff must still apply.
    // setSymbols gets undefined so ProfileManager keeps the current interval,
    // and the handler must NOT throw (a live profile must not be crashed).
    const h = buildHarness();
    h.strategiesGet.mockReturnValue(undefined);
    repoMocks.profilesFindById.mockResolvedValueOnce({
      id: ids.profileId,
      enabled: true,
      strategyName: 'gone-strategy',
      strategyVersion: '1.0.0',
      config: { candleInterval: '1h' },
    });
    repoMocks.profileSymbolsListForProfile.mockResolvedValueOnce([{ symbol: 'BTCUSDT' }]);

    await h.invoke('reconfigure-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });

    expect(h.setSymbols).toHaveBeenCalledTimes(1);
    expect(h.setSymbols.mock.calls[0]?.[2]).toBeUndefined();
    expect(h.warnings.map((w) => w.msg)).toContain(
      'pipeline_reconfigure_unknown_strategy_keeping_interval',
    );
  });

  it('reconfigure-profile: falls back to 1h and warns when the configured interval is unsupported', async () => {
    // A hand-edited config row carrying an interval the strategy does not
    // declare must not drive the hot-reconfigure path to an unsupported stream;
    // it falls back to '1h' (matching the subscribe path) and warns.
    const h = buildHarness();
    h.strategiesGet.mockReturnValue({ capabilities: { candleIntervals: ['5m', '1h'] } });
    repoMocks.profilesFindById.mockResolvedValueOnce({
      id: ids.profileId,
      enabled: true,
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.0',
      config: { candleInterval: '3m' },
    });
    repoMocks.profileSymbolsListForProfile.mockResolvedValueOnce([{ symbol: 'BTCUSDT' }]);

    await h.invoke('reconfigure-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });

    expect(h.setSymbols).toHaveBeenCalledTimes(1);
    expect(h.setSymbols.mock.calls[0]?.[2]).toBe('1h');
    expect(h.warnings.map((w) => w.msg)).toContain(
      'pipeline_subscribe_unsupported_interval_falling_back_to_1h',
    );
  });

  it('reconfigure-profile: warn-and-ack when the profile row is missing', async () => {
    const h = buildHarness();
    repoMocks.profilesFindById.mockResolvedValueOnce(null);
    await h.invoke('reconfigure-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });
    expect(h.setTechnicalsIntervals).not.toHaveBeenCalled();
    expect(h.warnings.map((w) => w.msg)).toContain('pipeline_reconfigure_profile_missing');
    // A missing profile has nothing to evict — the early return precedes it.
    expect(h.evictProfileContext).not.toHaveBeenCalled();
  });

  it('reconfigure-profile: info-and-ack when the profile is not active in ProfileManager', async () => {
    // Disabled mid-PATCH race: the setter returns false, the handler
    // logs and acks rather than retrying — the next subscribe picks
    // up the fresh config.
    const h = buildHarness({ setTechnicalsIntervals: () => false });
    repoMocks.profilesFindById.mockResolvedValueOnce({
      id: ids.profileId,
      enabled: true,
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.0',
      config: { technicals: { intervals: [{ interval: '1h' }] } },
    });
    repoMocks.profileSymbolsListForProfile.mockResolvedValueOnce([]);
    await h.invoke('reconfigure-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });
    expect(h.info.map((m) => m.msg)).toContain('pipeline_reconfigure_skipped_not_active');
    // The RUNTIME resync is what the membership gate skips: ProfileManager does not
    // hold this profile, so there is nothing in memory to update.
    expect(h.setSymbols).not.toHaveBeenCalled();
    // The DURABLE wallet reconcile is NOT gated on membership and still ran (it
    // reads the symbol set to do so). A profile that just inherited a position is
    // typically disabled — gating its state seeding on being in ProfileManager left
    // it reading FLAT while holding the coins, so it armed no stop and would buy
    // again on the next signal.
    expect(repoMocks.profileSymbolsListForProfile).toHaveBeenCalled();
    // Eviction still fires — it precedes the active check, so a config edit
    // on a profile that's momentarily inactive is never served stale either.
    expect(h.evictProfileContext).toHaveBeenCalledWith(ids.profileId);
  });

  // Schema-light strategy whose position adapter reads/writes plain-object
  // bodies, plus initialState/migrateState so the real mutateSymbolState spine
  // (which the mid-run reconcile routes through) can seed + persist a slice.
  const reconcileStrategy = {
    name: 'trailing-trade',
    version: '1.0.0',
    capabilities: { candleIntervals: ['1h'] },
    initialState: () => ({ schemaVersion: '1.0.0', avgEntryPrice: null, heldQuantity: null }),
    migrateState: ({ state }: { state: unknown }) => state,
    position: {
      readPosition: (s: unknown) =>
        s && typeof s === 'object'
          ? {
              avgEntryPrice: (s as Record<string, unknown>)['avgEntryPrice'] ?? null,
              heldQuantity: (s as Record<string, unknown>)['heldQuantity'] ?? null,
            }
          : null,
      setHeldQuantity: (s: unknown, q: string | null) =>
        s && typeof s === 'object' ? { ...(s as Record<string, unknown>), heldQuantity: q } : null,
      setAvgEntryPrice: (s: unknown, p: string) =>
        s && typeof s === 'object' ? { ...(s as Record<string, unknown>), avgEntryPrice: p } : null,
      // Mirror the real trailing-trade applyFill semantics so the
      // cost-basis seed (`kind: 'buy'`) lands a priced body the reconcile
      // step and the readPosition stub above both agree on.
      applyFill: (
        s: unknown,
        fill: { kind: string; avgEntryPrice?: string; heldQuantity?: string | null },
      ) => {
        if (!s || typeof s !== 'object') return null;
        const body = s as Record<string, unknown>;
        switch (fill.kind) {
          case 'buy':
            return {
              ...body,
              avgEntryPrice: fill.avgEntryPrice,
              heldQuantity: fill.heldQuantity,
              highSinceBuy: null,
            };
          case 'sell-reduce':
            return { ...body, heldQuantity: fill.heldQuantity };
          case 'empty':
            return { ...body, avgEntryPrice: null, heldQuantity: null, highSinceBuy: null };
          default:
            return null;
        }
      },
      clearPosition: (s: unknown) =>
        s && typeof s === 'object'
          ? { ...(s as Record<string, unknown>), avgEntryPrice: null, highSinceBuy: null }
          : null,
    },
  };

  it('reconfigure-profile: reconstructs cost basis + reconciles held qty for a held-but-unpriced adopt', async () => {
    // The bug: an operator adopts an orphan mid-run -> the symbol is freshly
    // subscribed with state.avgEntryPrice=null while the wallet holds the coin
    // and no ledger row exists. The mid-run reconcile must seed the ledger from
    // myTrades AND set heldQuantity + avgEntryPrice on the symbol_states body so
    // the entry gate stops treating the position as flat.
    const h = buildHarness();
    h.strategiesGet.mockReturnValue(reconcileStrategy);
    repoMocks.profilesFindById.mockResolvedValue({
      id: ids.profileId,
      enabled: true,
      binanceMode: 'live',
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.0',
      config: {},
    });
    repoMocks.profileSymbolsListForProfile.mockResolvedValueOnce([{ symbol: 'BTCUSDT' }]);
    // Cached symbolInfo: baseAsset BTC, stepSize 0.0001.
    h.redis.get.mockImplementation(async (key: string) =>
      key.includes('symbol-info')
        ? JSON.stringify({ baseAsset: 'BTC', filters: { stepSize: '0.0001' } })
        : null,
    );
    // Wallet holds 2 BTC.
    repoMocks.binanceGetAccount.mockResolvedValue({
      balances: [{ asset: 'BTC', free: '2', locked: '0' }],
    });
    // No ledger row yet, no prior symbol_states row.
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);
    repoMocks.avgEntryPricesUpsert.mockResolvedValue(undefined);
    // myTrades: bought 2 BTC for 100 quote -> avg 50.
    repoMocks.binanceGetMyTrades.mockResolvedValue([
      {
        id: 1,
        orderId: 1,
        symbol: 'BTCUSDT',
        price: '50',
        qty: '2',
        quoteQty: '100',
        commission: '0',
        commissionAsset: 'USDT',
        time: 1000,
        isBuyer: true,
        isMaker: false,
      },
    ]);

    await h.invoke('reconfigure-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });

    // The reconcile read the symbol-info keyspace for this profile's mode (#582):
    // a live profile reads the production keyspace, never the testnet one.
    expect(h.redis.get).toHaveBeenCalledWith(buildSymbolInfoKey('BTCUSDT', 'live'));
    expect(h.redis.get).not.toHaveBeenCalledWith(buildSymbolInfoKey('BTCUSDT', 'test'));
    // Ledger seeded from the reconstructed cost basis.
    expect(repoMocks.avgEntryPricesUpsert).toHaveBeenCalledWith('BTCUSDT', {
      avgEntryPrice: '50',
      quantity: '2',
    });
    // The persisted symbol_states body carries the reconciled position so the
    // entry gate no longer sees the symbol as flat.
    const finalWrite = h.persistedSymbolStates.at(-1);
    expect(finalWrite?.symbol).toBe('BTCUSDT');
    expect(finalWrite?.state).toMatchObject({ heldQuantity: '2', avgEntryPrice: '50' });
    // Per-symbol reconcile runs under the tick handler's key shape.
    expect(h.chainKeys).toContain(`${ids.profileId}:BTCUSDT`);
  });

  /**
   * Wires the mid-run reconcile fixture the reserve cases share.
   *
   * @param h - The harness whose redis + repo mocks are being programmed.
   * @param opts - Wallet balance, per-symbol reserve, cached price, and the exchange filters the cached symbolInfo reports.
   * @returns Nothing; the harness mocks are mutated in place.
   */
  const armReserveReconcile = (
    h: ReturnType<typeof buildHarness>,
    opts: {
      walletFree: string;
      reserve: string;
      price: string;
      stepSize: string;
      minNotional: string;
    },
  ): void => {
    h.strategiesGet.mockReturnValue(reconcileStrategy);
    repoMocks.profilesFindById.mockResolvedValue({
      id: ids.profileId,
      enabled: true,
      binanceMode: 'live',
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.0',
      config: {},
    });
    // Both lookup shapes carry the reserve, so the assertion turns on the reserve being APPLIED rather than on which repo call the implementation happens to reach for.
    repoMocks.profileSymbolsListForProfile.mockResolvedValue([
      { symbol: 'BTCUSDT', reserveBaseQuantity: opts.reserve },
    ]);
    repoMocks.profileSymbolsFindForSymbol.mockResolvedValue({
      reserveBaseQuantity: opts.reserve,
    });
    h.redis.get.mockImplementation(async (key: string) => {
      if (key === buildSymbolInfoKey('BTCUSDT', 'live')) {
        return JSON.stringify({
          baseAsset: 'BTC',
          filters: { stepSize: opts.stepSize, minNotional: opts.minNotional },
        });
      }
      if (key === GLOBAL_KEYS.ticker('BTCUSDT')) return JSON.stringify({ price: opts.price });
      return null;
    });
    repoMocks.binanceGetAccount.mockResolvedValue({
      balances: [{ asset: 'BTC', free: opts.walletFree, locked: '0' }],
    });
  };

  it('reconfigure-profile: adopts only the tradeable surplus, never the operator reserve', async () => {
    // The boot sweep drains the per-symbol reserve out of the wallet before adoption, so a reserved holding is never claimed as a position the strategy may sell. This path does not, which makes the same profile reconcile to two different held quantities depending on which door it came through — and the reconfigure door is the one an operator walks through immediately after setting the reserve.
    const h = buildHarness();
    armReserveReconcile(h, {
      walletFree: '2',
      reserve: '0.5',
      price: '50',
      stepSize: '0.0001',
      minNotional: '10',
    });
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);
    repoMocks.avgEntryPricesUpsert.mockResolvedValue(undefined);
    repoMocks.binanceGetMyTrades.mockResolvedValue([
      {
        id: 1,
        orderId: 1,
        symbol: 'BTCUSDT',
        price: '50',
        qty: '2',
        quoteQty: '100',
        commission: '0',
        commissionAsset: 'USDT',
        time: 1000,
        isBuyer: true,
        isMaker: false,
      },
    ]);

    await h.invoke('reconfigure-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });

    const upserted = repoMocks.avgEntryPricesUpsert.mock.calls[0]?.[1] as { quantity: string };
    expect(new Decimal(upserted.quantity).eq('1.5')).toBe(true);
    const held = (h.persistedSymbolStates.at(-1)?.state as { heldQuantity: string }).heldQuantity;
    expect(new Decimal(held).eq('1.5')).toBe(true);
  });

  it('reconfigure-profile: a fully-reserved wallet reconciles flat instead of holding the reserve', async () => {
    // Same rule from the other side. Every coin is reserved, so the tradeable surplus is zero and the strategy must read FLAT and trade on top — not carry a position made entirely of coins the operator told it never to sell.
    const h = buildHarness();
    armReserveReconcile(h, {
      walletFree: '2',
      reserve: '2',
      price: '50',
      stepSize: '0.0001',
      minNotional: '10',
    });
    const pricedBody = {
      schemaVersion: '1.0.0',
      avgEntryPrice: '50',
      heldQuantity: '2',
      highSinceBuy: null,
    };
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
      avgEntryPrice: '50',
      quantity: '2',
    });
    // A read returns the LAST write, as a database would. The pass makes two writes here — the reconciler converges the quantity, then the phantom prune clears the cost basis over it — and a mock that replays the pre-reconcile body to the second one hands it a position that no longer exists.
    repoMocks.symbolStatesFindBySymbol.mockImplementation(async () => ({
      symbol: 'BTCUSDT',
      strategyVersion: '1.0.0',
      state: h.persistedSymbolStates.at(-1)?.state ?? pricedBody,
    }));

    await h.invoke('reconfigure-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });

    expect(h.persistedSymbolStates.at(-1)?.state).toMatchObject({ heldQuantity: null });
  });

  it('reconfigure-profile: values the dust bounds at the operator holding, not the surplus', async () => {
    // Where the two numbers genuinely disagree, and the case a single forwarded wallet figure cannot get right. A deep reserve leaves a surplus worth a fraction of one minimum order while the operator's own holding is worth twenty times it. The dust VALUE bounds ask "is this residue?", which is a question about the coins the operator owns; asked of the surplus instead they answer yes, refuse to adopt, and the reconfigure leaves a real position invisible. Sizing keeps reading the surplus — only the value bounds read the raw total.
    const h = buildHarness();
    armReserveReconcile(h, {
      walletFree: '2',
      reserve: '1.9999',
      price: '50',
      stepSize: '0.00001',
      minNotional: '10',
    });
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);
    repoMocks.avgEntryPricesUpsert.mockResolvedValue(undefined);
    repoMocks.binanceGetMyTrades.mockResolvedValue([
      {
        id: 1,
        orderId: 1,
        symbol: 'BTCUSDT',
        price: '50',
        qty: '2',
        quoteQty: '100',
        commission: '0',
        commissionAsset: 'USDT',
        time: 1000,
        isBuyer: true,
        isMaker: false,
      },
    ]);

    await h.invoke('reconfigure-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });

    // The boot sweep's own verdict for the identical inputs. Asserting against it rather than a literal is what makes the two doors provably one rule: change the rule and both move together, or this fails.
    const bootVerdict = reconcileHeldQuantity({
      heldQuantity: null,
      walletFree: '0.0001',
      walletLocked: '0',
      stepSize: '0.00001',
      minNotional: '10',
      referencePrice: '50',
      unreservedWalletTotal: '2',
    });
    expect(bootVerdict.action).toBe('seed-from-wallet');
    const held = (h.persistedSymbolStates.at(-1)?.state as { heldQuantity: string }).heldQuantity;
    expect(new Decimal(held).eq(bootVerdict.nextHeldQuantity ?? '0')).toBe(true);
  });

  it('reconfigure-profile: prices a symbol the ticker cache has never held, via the batched REST fallback', async () => {
    // Not a cold-start race — a guaranteed miss. `handleReconfigure` runs this reconcile BEFORE `setSymbols`, so a newly added symbol has never had a miniTicker subscription and its `ticker:` key cannot exist. Without the fallback every dust value bound stands down on exactly the pass that re-adopts a symbol, and an operator re-adding one that still carries sub-notional residue has the seed gate rebuild the unsellable strand this whole change exists to prevent.
    const h = buildHarness();
    armReserveReconcile(h, {
      walletFree: '0.5',
      reserve: '0',
      price: '50',
      stepSize: '0.0001',
      minNotional: '10',
    });
    // The cache holds nothing for this symbol, which is the guaranteed state for a fresh binding.
    h.redis.get.mockImplementation(async (key: string) =>
      key === buildSymbolInfoKey('BTCUSDT', 'live')
        ? JSON.stringify({ baseAsset: 'BTC', filters: { stepSize: '0.0001', minNotional: '10' } })
        : null,
    );
    // 0.5 x 0.001 = 0.0005 quote, four orders of magnitude under the 10 floor: unmistakably dust once a price exists to value it by.
    repoMocks.binanceGetPriceTickers.mockResolvedValue([{ symbol: 'BTCUSDT', price: '0.001' }]);
    const pricedBody = {
      schemaVersion: '1.0.0',
      avgEntryPrice: '50',
      heldQuantity: '0.5',
      highSinceBuy: null,
    };
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
      avgEntryPrice: '50',
      quantity: '0.5',
    });
    repoMocks.symbolStatesFindBySymbol.mockImplementation(async () => ({
      symbol: 'BTCUSDT',
      strategyVersion: '1.0.0',
      state: h.persistedSymbolStates.at(-1)?.state ?? pricedBody,
    }));

    await h.invoke('reconfigure-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });

    expect(repoMocks.binanceGetPriceTickers).toHaveBeenCalledWith(['BTCUSDT']);
    // The bound ARMED and acted: the residue is flattened and its cost basis dropped. With no price this pass would have converged the strand instead and left it on the dashboard forever.
    expect(h.persistedSymbolStates.at(-1)?.state).toMatchObject({ heldQuantity: null });
    expect(repoMocks.avgEntryPricesRemove).toHaveBeenCalledWith('BTCUSDT');
  });

  it('reconfigure-profile: seeds the strategy state of a DISABLED profile — the handoff target case', async () => {
    // The handoff hands a live position to another profile, and the natural target
    // is a fresh or stopped one, i.e. NOT in ProfileManager. Gating the wallet
    // reconcile on membership left that target reading FLAT while holding the coins:
    // it would arm no protective stop and fire a fresh entry BUY on top of the
    // position it already owned. Enabling it later does not heal that (subscribe
    // does not reconcile) — only a reboot did.
    const h = buildHarness({ setTechnicalsIntervals: () => false });
    h.strategiesGet.mockReturnValue(reconcileStrategy);
    repoMocks.profilesFindById.mockResolvedValue({
      id: ids.profileId,
      enabled: false,
      binanceMode: 'live',
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.0',
      config: {},
    });
    repoMocks.profileSymbolsListForProfile.mockResolvedValueOnce([{ symbol: 'BTCUSDT' }]);
    h.redis.get.mockImplementation(async (key: string) =>
      key.includes('symbol-info')
        ? JSON.stringify({ baseAsset: 'BTC', filters: { stepSize: '0.0001' } })
        : null,
    );
    // The wallet holds the inherited position...
    repoMocks.binanceGetAccount.mockResolvedValue({
      balances: [{ asset: 'BTC', free: '2', locked: '0' }],
    });
    // ...and the cost basis the handoff just re-pointed to this profile.
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      avgEntryPrice: '50',
      quantity: '2',
    });
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);

    await h.invoke('reconfigure-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });

    // Not in ProfileManager, so no runtime resync...
    expect(h.setSymbols).not.toHaveBeenCalled();
    // ...but the state IS seeded: the target knows what it owns before it ever ticks.
    const write = h.persistedSymbolStates.at(-1);
    expect(write?.symbol).toBe('BTCUSDT');
    expect(write?.state).toMatchObject({ heldQuantity: '2', avgEntryPrice: '50' });
  });

  it('reconfigure-profile: skips reconcile without throwing when no binance client resolves', async () => {
    // A test-mode profile without keys has no client; the reconcile must be
    // skipped silently and the reconfigure itself still completes.
    const h = buildHarness();
    h.strategiesGet.mockReturnValue(reconcileStrategy);
    h.resolveBinanceClient.mockResolvedValue(null);
    repoMocks.profilesFindById.mockResolvedValue({
      id: ids.profileId,
      enabled: true,
      binanceMode: 'live',
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.0',
      config: {},
    });
    repoMocks.profileSymbolsListForProfile.mockResolvedValueOnce([{ symbol: 'BTCUSDT' }]);

    await h.invoke('reconfigure-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });

    expect(h.setSymbols).toHaveBeenCalledTimes(1);
    expect(repoMocks.avgEntryPricesUpsert).not.toHaveBeenCalled();
    expect(repoMocks.binanceGetAccount).not.toHaveBeenCalled();
    expect(h.persistedSymbolStates).toHaveLength(0);
  });

  it('apply-avg-entry-price: force-sets avgEntryPrice + reserve-adjusted held qty from the ledger (#496)', async () => {
    // The operator wrote the ledger via the api (PUT or combined add); the
    // worker must force the running strategy's cost basis onto the symbol_states
    // body so the bot manages and sells the held position. The worker NEVER
    // rewrites the ledger — that is the api's job.
    const h = buildHarness();
    h.strategiesGet.mockReturnValue(reconcileStrategy);
    repoMocks.profilesFindById.mockResolvedValue({
      id: ids.profileId,
      enabled: true,
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.0',
      config: {},
    });
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      avgEntryPrice: '50',
      quantity: '2',
    });
    // Reserve 0.5 BTC -> the bot manages only 1.5 of the 2 held (#498).
    repoMocks.profileSymbolsFindForSymbol.mockResolvedValue({ reserveBaseQuantity: '0.5' });
    h.redis.get.mockImplementation(async (key: string) =>
      key.includes('symbol-info')
        ? JSON.stringify({ baseAsset: 'BTC', filters: { stepSize: '0.0001' } })
        : null,
    );
    repoMocks.binanceGetAccount.mockResolvedValue({
      balances: [{ asset: 'BTC', free: '2', locked: '0' }],
    });
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);

    await h.invoke('apply-avg-entry-price', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });

    expect(repoMocks.avgEntryPricesUpsert).not.toHaveBeenCalled();
    const finalWrite = h.persistedSymbolStates.at(-1);
    expect(finalWrite?.symbol).toBe('BTCUSDT');
    expect(finalWrite?.state).toMatchObject({ avgEntryPrice: '50', heldQuantity: '1.5' });
    expect(h.chainKeys).toContain(`${ids.profileId}:BTCUSDT`);
  });

  it('apply-avg-entry-price: clears the position when the ledger row is absent (delete path)', async () => {
    const h = buildHarness();
    h.strategiesGet.mockReturnValue(reconcileStrategy);
    repoMocks.profilesFindById.mockResolvedValue({
      id: ids.profileId,
      enabled: true,
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.0',
      config: {},
    });
    // Ledger gone (DELETE) -> clear the strategy's cost basis, no wallet read.
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);

    await h.invoke('apply-avg-entry-price', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });

    expect(repoMocks.binanceGetAccount).not.toHaveBeenCalled();
    expect(h.persistedSymbolStates.at(-1)?.state).toMatchObject({ avgEntryPrice: null });
    expect(h.chainKeys).toContain(`${ids.profileId}:BTCUSDT`);
  });

  it('apply-avg-entry-price: falls back to the ledger quantity when the wallet cannot be read', async () => {
    const h = buildHarness();
    h.strategiesGet.mockReturnValue(reconcileStrategy);
    h.resolveBinanceClient.mockResolvedValue(null); // no client -> no wallet read
    repoMocks.profilesFindById.mockResolvedValue({
      id: ids.profileId,
      enabled: true,
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.0',
      config: {},
    });
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      avgEntryPrice: '50',
      quantity: '2',
    });
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);

    await h.invoke('apply-avg-entry-price', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });

    expect(repoMocks.binanceGetAccount).not.toHaveBeenCalled();
    expect(h.persistedSymbolStates.at(-1)?.state).toMatchObject({
      avgEntryPrice: '50',
      heldQuantity: '2',
    });
  });

  it('apply-avg-entry-price: warn-and-ack when the profile is missing', async () => {
    const h = buildHarness();
    repoMocks.profilesFindById.mockResolvedValue(null);
    await h.invoke('apply-avg-entry-price', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });
    expect(h.persistedSymbolStates).toHaveLength(0);
    expect(h.warnings.some((w) => w.msg === 'pipeline_apply_avg_entry_price_profile_missing')).toBe(
      true,
    );
  });

  it('apply-avg-entry-price: warn-and-ack when the strategy has no position capability', async () => {
    const h = buildHarness();
    h.strategiesGet.mockReturnValue({ capabilities: {} }); // no `position` capability
    repoMocks.profilesFindById.mockResolvedValue({
      id: ids.profileId,
      enabled: true,
      strategyName: 'momentum',
      strategyVersion: '1.0.0',
      config: {},
    });
    await h.invoke('apply-avg-entry-price', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });
    expect(h.persistedSymbolStates).toHaveLength(0);
    expect(repoMocks.avgEntryPricesFindBySymbol).not.toHaveBeenCalled();
    expect(h.warnings.some((w) => w.msg === 'pipeline_apply_avg_entry_price_no_position')).toBe(
      true,
    );
  });

  it('apply-avg-entry-price: rejects invalid payload (no symbol)', async () => {
    const h = buildHarness();
    await expect(
      h.invoke('apply-avg-entry-price', {
        userId: ids.userId,
        accountId: ids.accountId,
        profileId: ids.profileId,
      }),
    ).rejects.toThrow('pipeline_invalid_payload');
    expect(h.persistedSymbolStates).toHaveLength(0);
  });

  it('reconfigure-profile: throws on an invalid payload so BullMQ retries + DLQs', async () => {
    const h = buildHarness();
    // Must THROW, not ack. Payload skew is the same defect class as job-name
    // skew, which the dispatcher's `default` case already throws on. Acking
    // would record the job `completed` while the operator's request never ran —
    // e.g. a dispose-profile that lost its accountId leaves a profile that can
    // never be deleted, with one warn line as the only trace.
    await expect(h.invoke('reconfigure-profile', { profileId: 'no-user' })).rejects.toThrow(
      'pipeline_invalid_payload',
    );
    expect(h.setTechnicalsIntervals).not.toHaveBeenCalled();
  });

  it('subscribe-profile: evicts the cached tick context so the first tick reads fresh', async () => {
    // A profile edited while disabled (the API enabled-gate suppresses the
    // reconfigure signal) must still read fresh on its first tick after a
    // re-enable. Evicting on (re)subscribe guarantees that regardless of the
    // API gate.
    const h = buildHarness();
    h.strategiesGet.mockReturnValueOnce({ capabilities: { candleIntervals: ['1h'] } });
    repoMocks.profilesFindById.mockResolvedValueOnce({
      id: ids.profileId,
      enabled: true,
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.0',
      config: {},
    });
    repoMocks.profileSymbolsListForProfile.mockResolvedValueOnce([{ symbol: 'BTCUSDT' }]);

    await h.invoke('subscribe-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });

    expect(h.enabled).toHaveBeenCalledTimes(1);
    expect(h.evictProfileContext).toHaveBeenCalledWith(ids.profileId);
    // Kicks ownership so the just-subscribed profile's user-data stream opens
    // now (enable no longer opens it; ownership is the sole driver — #579).
    expect(h.reconcileOwnership).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe-profile: tears down and evicts when DB says the profile is disabled', async () => {
    const h = buildHarness();
    repoMocks.profilesFindById.mockResolvedValueOnce({ id: ids.profileId, enabled: false });
    await h.invoke('unsubscribe-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });
    expect(h.disabled).toHaveBeenCalledWith(ids.profileId);
    expect(h.evictProfileContext).toHaveBeenCalledWith(ids.profileId);
    // Kicks ownership so the departed profile's stream closes now (#579).
    expect(h.reconcileOwnership).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe-profile: tears down and evicts when the profile is deleted (ProfileNotOwnedError)', async () => {
    // A deleted profile makes `profileRepo` (the ownership check) throw
    // ProfileNotOwnedError BEFORE findById runs. The handler must map that to
    // "profile gone -> tear down + evict", not propagate the throw (which would
    // DLQ the job and leak the in-memory subscription). RED on the pre-fix code:
    // the unmapped throw escaped, disable never ran.
    const h = buildHarness();
    vi.mocked(profileRepo).mockRejectedValueOnce(
      new ProfileNotOwnedError(ids.userId, ids.accountId, ids.profileId),
    );
    await h.invoke('unsubscribe-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });
    expect(h.disabled).toHaveBeenCalledWith(ids.profileId);
    expect(h.evictProfileContext).toHaveBeenCalledWith(ids.profileId);
  });

  it('unsubscribe-profile: rethrows a non-ownership repo error (so BullMQ retries, not silently evicts)', async () => {
    // A transient DB error during the ownership check is NOT proof the profile
    // is gone; rethrow so BullMQ retries instead of tearing down a possibly
    // still-enabled subscription.
    const h = buildHarness();
    vi.mocked(profileRepo).mockRejectedValueOnce(new Error('db connection lost'));
    await expect(
      h.invoke('unsubscribe-profile', {
        userId: ids.userId,
        accountId: ids.accountId,
        profileId: ids.profileId,
      }),
    ).rejects.toThrow(/db connection lost/);
    expect(h.disabled).not.toHaveBeenCalled();
  });

  it('unsubscribe-profile: SKIPS teardown when DB says still enabled (stale unsubscribe superseded by a later start)', async () => {
    // The stuck-subscription bug: a /stop's unsubscribe job lands AFTER a /start
    // already re-enabled the profile in the DB. Tearing down here would strand
    // the symbol (DB enabled, streams gone) until restart. DB truth wins: skip.
    const h = buildHarness();
    repoMocks.profilesFindById.mockResolvedValueOnce({ id: ids.profileId, enabled: true });
    await h.invoke('unsubscribe-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });
    expect(h.disabled).not.toHaveBeenCalled();
    expect(h.evictProfileContext).not.toHaveBeenCalled();
    expect(h.info.map((m) => m.msg)).toContain('pipeline_unsubscribe_skipped_still_enabled');
  });

  it('subscribe-profile and unsubscribe-profile dispatch run under the per-profile chain', async () => {
    // Both lifecycle jobs must serialize with each other AND with reconfigure on
    // the same profileId key so an enable's converge cannot race a disable's
    // teardown mid-operation.
    const h = buildHarness();
    h.strategiesGet.mockReturnValueOnce({ capabilities: { candleIntervals: ['1h'] } });
    repoMocks.profilesFindById.mockResolvedValueOnce({
      id: ids.profileId,
      enabled: true,
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.0',
      config: {},
    });
    repoMocks.profileSymbolsListForProfile.mockResolvedValueOnce([{ symbol: 'BTCUSDT' }]);
    await h.invoke('subscribe-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });
    repoMocks.profilesFindById.mockResolvedValueOnce({ id: ids.profileId, enabled: false });
    await h.invoke('unsubscribe-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });
    expect(h.chainKeys).toEqual([ids.profileId, ids.profileId]);
  });

  it('subscribe + unsubscribe on the same profile are MUTUALLY EXCLUDED by the real chain', async () => {
    // The dispatch tests above use a pass-through chain that runs fn()
    // immediately, so they only prove the key is recorded. This one wires the
    // REAL createChainByKey and makes each handler block on a controllable
    // promise, then dispatches both for the same profileId WITHOUT awaiting the
    // first. The second handler must not begin until the first resolves —
    // proving the chain actually serializes overlapping lifecycle jobs.
    let releaseSubscribe!: () => void;
    const subscribeGate = new Promise<void>((resolve) => {
      releaseSubscribe = resolve;
    });
    const order: string[] = [];
    let unsubscribeStarted = false;

    const h = buildHarness(
      {
        enable: async () => {
          order.push('subscribe:start');
          await subscribeGate; // block until released
          order.push('subscribe:end');
        },
        disable: async () => {
          unsubscribeStarted = true;
          order.push('unsubscribe:start');
        },
      },
      createChainByKey(),
    );
    h.strategiesGet.mockReturnValue({ capabilities: { candleIntervals: ['1h'] } });
    repoMocks.profilesFindById.mockResolvedValueOnce({
      id: ids.profileId,
      enabled: true,
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.0',
      config: {},
    });
    repoMocks.profileSymbolsListForProfile.mockResolvedValueOnce([{ symbol: 'BTCUSDT' }]);
    // Second job (unsubscribe) sees DB disabled so it WOULD call disable() once
    // it gets to run — but it must not run until subscribe releases.
    repoMocks.profilesFindById.mockResolvedValueOnce({ id: ids.profileId, enabled: false });

    // Dispatch both WITHOUT awaiting the first.
    const first = h.invoke('subscribe-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });
    const second = h.invoke('unsubscribe-profile', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
    });

    // Drain the event loop until subscribe has reached its gate (several awaits
    // deep: profileRepo -> findById -> ... -> enable). It then parks; unsubscribe
    // must still be queued behind it on the same chain key, never started.
    for (let i = 0; i < 50 && order.length === 0; i += 1) await Promise.resolve();
    expect(order).toEqual(['subscribe:start']);
    expect(unsubscribeStarted).toBe(false);

    // Release the first; the second now runs to completion behind it.
    releaseSubscribe();
    await Promise.all([first, second]);
    expect(order).toEqual(['subscribe:start', 'subscribe:end', 'unsubscribe:start']);
    expect(h.disabled).toHaveBeenCalledWith(ids.profileId);
  });

  it('REGRESSION: stop-then-start leaving DB enabled stays SUBSCRIBED regardless of job order (real ProfileManager)', async () => {
    // The actual stuck-subscription bug. Operator: /stop then /start, so the DB
    // ends enabled=true. Run the dispatched subscribe + unsubscribe jobs in BOTH
    // orders against a REAL ProfileManager (stub market hook) seeded
    // with the active profile. The profile must remain ACTUALLY subscribed in
    // the manager afterward — `profilesUsing(symbol)` still contains it and its
    // market subscription is retained. RED on the pre-fix code (unconditional
    // disable tore the subscription down) for the right reason: the symbol
    // dropped out of profilesUsing.
    for (const order of [
      ['subscribe-profile', 'unsubscribe-profile'],
      ['unsubscribe-profile', 'subscribe-profile'],
    ] as const) {
      // Stub market hook mirrors the profile-manager test harness. The account
      // user-data stream is subscription-ownership's job, not the manager's.
      const marketRemoved: string[][] = [];
      const market: MarketSubscriberHooks = {
        addSymbols: vi.fn(async () => undefined),
        removeSymbols: vi.fn(async (symbols) => {
          marketRemoved.push([...symbols]);
        }),
      };
      const pm = createProfileManager({ loadEnabledProfiles: async () => [] });
      pm.setMarket(market);
      // Seed: the profile is already active (operator's earlier /start, or the
      // converge path). One symbol so profilesUsing has something to lose.
      await pm.enable({
        userId: ids.userId,
        operatorId: ids.userId,
        accountId: ids.accountId,
        profileId: ids.profileId,
        symbols: ['BTCUSDT'],
        candleInterval: '1h',
        technicalsIntervals: [],
      });

      // Wire the REAL manager's enable/disable into the dispatch harness so the
      // jobs drive the actual converge/teardown, not a stub.
      const h = buildHarness({
        enable: (...a: unknown[]) => pm.enable(a[0] as Parameters<typeof pm.enable>[0]),
        disable: (...a: unknown[]) => pm.disable(a[0] as Parameters<typeof pm.disable>[0]),
        setSymbols: (...a: unknown[]) =>
          pm.setSymbols(
            a[0] as Parameters<typeof pm.setSymbols>[0],
            a[1] as Parameters<typeof pm.setSymbols>[1],
            a[2] as Parameters<typeof pm.setSymbols>[2],
          ),
        setTechnicalsIntervals: (...a: unknown[]) =>
          pm.setTechnicalsIntervals(
            a[0] as Parameters<typeof pm.setTechnicalsIntervals>[0],
            a[1] as Parameters<typeof pm.setTechnicalsIntervals>[1],
          ),
      });
      // DB truth: enabled for every read (operator's last action was /start).
      h.strategiesGet.mockReturnValue({ capabilities: { candleIntervals: ['1h'] } });
      repoMocks.profilesFindById.mockResolvedValue({
        id: ids.profileId,
        enabled: true,
        strategyName: 'trailing-trade',
        strategyVersion: '1.0.0',
        config: {},
      });
      repoMocks.profileSymbolsListForProfile.mockResolvedValue([{ symbol: 'BTCUSDT' }]);

      await h.invoke(order[0], {
        userId: ids.userId,
        accountId: ids.accountId,
        profileId: ids.profileId,
      });
      await h.invoke(order[1], {
        userId: ids.userId,
        accountId: ids.accountId,
        profileId: ids.profileId,
      });

      // End-to-end truth: the profile is STILL subscribed in the real manager.
      expect(pm.profilesUsing('BTCUSDT')).toContain(ids.profileId);
      expect(pm.listActive().map((a) => a.profileId)).toContain(ids.profileId);
      // The stale unsubscribe never tore the symbol down.
      expect(marketRemoved).toEqual([]);
    }
  });

  it('still throws on a truly unknown name (producer/consumer skew protection)', async () => {
    const h = buildHarness();
    await expect(
      h.invoke('completely-bogus-name', {
        userId: ids.userId,
        accountId: ids.accountId,
        profileId: ids.profileId,
      }),
    ).rejects.toThrow(/pipeline_unknown_job_name: completely-bogus-name/);
  });

  describe('verify-key', () => {
    // The api enqueues `{ userId, accountId }` — an api-key save is account-level
    // and has no profile. The consumer used to parse it with the profile-scoped
    // parser, so every real payload was rejected and (under the old warn-and-ack)
    // key verification silently never ran. This pins the producer's exact shape.
    it('accepts the exact payload the api enqueues, with no profileId', async () => {
      const h = buildHarness();
      repoMocks.accountGet.mockResolvedValue({ binanceMode: 'live' });
      repoMocks.apiKeysFindForAccount.mockResolvedValue({ key: 'k', secret: 's' });
      repoMocks.binanceGetAccount.mockResolvedValueOnce({ canTrade: true, balances: [] });

      await expect(
        h.invoke('verify-key', { userId: ids.userId, accountId: ids.accountId }),
      ).resolves.toBeUndefined();

      expect(repoMocks.apiKeysSetVerification).toHaveBeenCalledWith({ status: 'ok', error: null });
    });

    const seedKeyAndProfile = (): void => {
      // Credentials + mode are per-account: verify-key reads them via accountRepo.
      repoMocks.accountGet.mockResolvedValue({ binanceMode: 'live' });
      repoMocks.apiKeysFindForAccount.mockResolvedValue({ key: 'k', secret: 's' });
    };

    it('records ok when getAccount succeeds', async () => {
      const h = buildHarness();
      seedKeyAndProfile();
      repoMocks.binanceGetAccount.mockResolvedValueOnce({ canTrade: true, balances: [] });
      await h.invoke('verify-key', { userId: ids.userId, accountId: ids.accountId });
      expect(repoMocks.apiKeysSetVerification).toHaveBeenCalledWith({ status: 'ok', error: null });
      expect(h.info.map((m) => m.msg)).toContain('pipeline_verify_key_ok');
    });

    it('records failed for a permanent Binance verdict (bad key/permission/IP)', async () => {
      const h = buildHarness();
      seedKeyAndProfile();
      repoMocks.binanceGetAccount.mockRejectedValueOnce(
        new BinanceApiError(
          { status: 401, code: -2015, msg: 'Invalid API-key, IP, or permissions for action' },
          false,
          'rejected',
        ),
      );
      await h.invoke('verify-key', { userId: ids.userId, accountId: ids.accountId });
      const call = repoMocks.apiKeysSetVerification.mock.calls[0]?.[0] as {
        status: string;
        error: string;
      };
      expect(call.status).toBe('failed');
      expect(call.error).toMatch(/Invalid API-key/);
    });

    it('rethrows a retryable Binance error so BullMQ retries instead of recording a false failure', async () => {
      const h = buildHarness();
      seedKeyAndProfile();
      repoMocks.binanceGetAccount.mockRejectedValueOnce(
        new BinanceApiError(
          { status: 503, code: -1003, msg: 'Service unavailable' },
          true,
          'ambiguous',
        ),
      );
      await expect(
        h.invoke('verify-key', { userId: ids.userId, accountId: ids.accountId }),
      ).rejects.toThrow(/binance 503/);
      expect(repoMocks.apiKeysSetVerification).not.toHaveBeenCalled();
    });

    it('rethrows a non-Binance error (network/unknown) rather than marking the key failed', async () => {
      const h = buildHarness();
      seedKeyAndProfile();
      repoMocks.binanceGetAccount.mockRejectedValueOnce(new Error('ECONNRESET'));
      await expect(
        h.invoke('verify-key', { userId: ids.userId, accountId: ids.accountId }),
      ).rejects.toThrow(/ECONNRESET/);
      expect(repoMocks.apiKeysSetVerification).not.toHaveBeenCalled();
    });
  });
});
