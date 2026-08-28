import { describe, expect, it, vi } from 'vitest';
import type { Job, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { BinanceApiError } from '@app/binance';
import { GLOBAL_KEYS, profileRepo, ProfileNotOwnedError } from '@app/db';

import {
  reconcileHeldQuantity,
  resolveWalletFields,
} from '../../src/boot/reconcile-held-quantity.js';
import { Decimal } from '@app/money';
import { isPhantomLedgerRow } from '../../src/boot/revive-avg-entry-price.js';
import {
  APPLY_SEED_GATE_STAND_DOWN_REASONS,
  registerPipelineWorker,
} from '../../src/queues/pipeline-worker.js';
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
  conditionRecordCondition: vi.fn(async () => ({ changed: false, sinceMs: null })),
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
      // The apply job opens and clears the seed-refusal condition on the exits that resolved a profile, so the scope stub carries the store even for cases that assert nothing about it.
      conditionStates: { recordCondition: repoMocks.conditionRecordCondition },
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
  metrics: { record: ReturnType<typeof vi.fn>; forget: ReturnType<typeof vi.fn> };
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
    // Returned on the harness as well, so a case can assert the zero-seed and the increment a labelled counter needs in order to be readable at all.
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
    metrics: deps.metrics,
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
        baseCommissionNetted: '0.001',
        meta: { gridTradeIndex: 0 },
        closedAt: new Date('2026-05-13T00:00:00Z'),
        raw: {
          executedQty: '1',
          cummulativeQuoteQty: '100',
        },
      },
      {
        id: 'r2',
        binanceOrderId: 2n,
        clientOrderId: 'c2',
        intent: 'grid-sell',
        side: 'SELL',
        status: 'FILLED',
        baseCommissionNetted: null,
        meta: null,
        closedAt: new Date('2026-05-13T00:01:00Z'),
        raw: { executedQty: '1', cummulativeQuoteQty: '110' },
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
      {
        id: 10,
        orderId: 1,
        symbol: 'BTCUSDT',
        price: '100',
        qty: '1',
        quoteQty: '100',
        commission: '0.001',
        commissionAsset: 'BTC',
        isBuyer: true,
      },
      {
        id: 20,
        orderId: 2,
        symbol: 'BTCUSDT',
        price: '110',
        qty: '0.5',
        quoteQty: '55',
        commission: '0.05',
        commissionAsset: 'USDT',
        isBuyer: false,
      },
      {
        id: 21,
        orderId: 2,
        symbol: 'BTCUSDT',
        price: '110',
        qty: '0.5',
        quoteQty: '55',
        commission: '0.06',
        commissionAsset: 'USDT',
        isBuyer: false,
      },
      {
        id: 990,
        orderId: 99,
        symbol: 'BTCUSDT',
        price: '1',
        qty: '1',
        quoteQty: '1',
        commission: '5',
        commissionAsset: 'USDT',
        isBuyer: false,
      },
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
      totalBuyQuote: '100',
      totalSellQuote: '110',
      breakdown: { 'grid-buy:BUY': '100', 'grid-sell:SELL': '110' },
      // Fees summed per asset over the archived orders only (orderId 99 excluded).
      fees: { BTC: '0.001', USDT: '0.11' },
      feesQuote: '0.11',
      feeBasis: 'exact',
      // Source stamped from the live profile_symbols binding.
      source: 'auto',
      // Cross-pod dedup key = the first closed order the handler read (rows[0]),
      // which production orders desc(closedAt) to the cycle's max close time.
      cycleEnd: new Date('2026-05-13T00:00:00Z'),
    });
    expect(args[0]).not.toHaveProperty('profitPercent');
    const success = h.info.find((entry) => entry.msg === 'pipeline_archive_grid_trade_ok');
    expect(success?.ctx).not.toHaveProperty('profitPercent');
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
        baseCommissionNetted: null,
        meta: null,
        closedAt: new Date('2026-05-13T00:00:00Z'),
        raw: { executedQty: '1', cummulativeQuoteQty: '100' },
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
        baseCommissionNetted: null,
        meta: null,
        closedAt: new Date('2026-05-13T00:00:00Z'),
        raw: { executedQty: '1', cummulativeQuoteQty: '100' },
      },
      {
        id: 'r2',
        binanceOrderId: 2n,
        clientOrderId: 'c2',
        intent: 'grid-buy',
        side: 'BUY',
        status: 'FILLED',
        baseCommissionNetted: null,
        meta: null,
        closedAt: new Date('2026-05-13T00:01:00Z'),
        raw: { cummulativeQuoteQty: '100' },
      },
    ]);
    // Only order 1's trade survives on the page; order 2 fell off (truncation).
    repoMocks.binanceGetMyTrades.mockResolvedValueOnce([
      {
        id: 10,
        orderId: 1,
        symbol: 'BTCUSDT',
        price: '100',
        qty: '1',
        quoteQty: '100',
        commission: '0.001',
        commissionAsset: 'BNB',
        isBuyer: true,
      },
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
    expect((args[0] as { feeBasis: unknown }).feeBasis).toBe('unknown');
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
    // No binding row, so nobody can now say who chose the coin. `unknown` rather than `manual`, which would file a cycle discovery may well have opened under the operator's column.
    expect((args[0] as { source: unknown }).source).toBe('unknown');
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

  it('backfill-trade-archive: reconstructs a round-trip from myTrades and inherits the binding provenance', async () => {
    const h = buildHarness();
    // A manual binding proves the wiring end-to-end: a hard-coded `auto` in the handler passes any fixture whose binding happens to be auto, so the fixture states the other value.
    repoMocks.profileSymbolsFindForSymbol.mockResolvedValueOnce({ source: 'manual' });
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
    expect(args[0]).toMatchObject({ symbol: 'WLDUSDT', source: 'manual', profit: '-2' });
    expect(repoMocks.profileSymbolsFindForSymbol).toHaveBeenCalledWith('WLDUSDT');
    expect(args[0]).not.toHaveProperty('profitPercent');
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
   * Wires the mid-run reconcile fixture the reconfigure cases share.
   *
   * @param h - The harness whose redis + repo mocks are being programmed.
   * @param opts - Wallet balance, cached price, and the exchange filters the cached symbolInfo reports.
   * @returns Nothing; the harness mocks are mutated in place.
   */
  const armReconcile = (
    h: ReturnType<typeof buildHarness>,
    opts: {
      walletFree: string;
      walletLocked?: string;
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
    repoMocks.profileSymbolsListForProfile.mockResolvedValue([{ symbol: 'BTCUSDT' }]);
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
      balances: [{ asset: 'BTC', free: opts.walletFree, locked: opts.walletLocked ?? '0' }],
    });
  };

  it.each([
    ['flattens the crumb', '200', null],
    ['keeps the holding', '10', '2'],
  ])(
    "reconfigure-profile: reconciles to the boot door's own verdict and %s",
    async (_label, minNotional, expected) => {
      // The two doors do NOT share a target builder. The boot sweep enumerates its own, and `handleReconfigure` hand-assembles one — supplying `stepSize`, `minNotional` and `referencePrice` itself — so the same profile can reconcile to two different held quantities depending on which door an operator walked through. Asserting against the boot reconciler's live verdict rather than a literal is what makes the two provably one rule: change the rule and both move together, or this fails.
      //
      // Both rows are needed. A 2-of-500 wallet is a 0.4% crumb share, so the dust VALUE bound decides the answer and the two floors put it on opposite sides: drop `minNotional` or `referencePrice` from the door's target and the bound stands down, which the first row catches; wire either to the wrong value and the second row catches it.
      const h = buildHarness();
      armReconcile(h, { walletFree: '2', price: '50', stepSize: '0.00001', minNotional });
      const staleClaim = {
        schemaVersion: '1.0.0',
        avgEntryPrice: '50',
        heldQuantity: '500',
        highSinceBuy: null,
      };
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        avgEntryPrice: '50',
        quantity: '500',
      });
      // A read returns the LAST write, as a database would: this pass writes state more than once and replaying the pre-reconcile body to the later read would hand it a position that no longer exists.
      repoMocks.symbolStatesFindBySymbol.mockImplementation(async () => ({
        symbol: 'BTCUSDT',
        strategyVersion: '1.0.0',
        state: h.persistedSymbolStates.at(-1)?.state ?? staleClaim,
      }));

      await h.invoke('reconfigure-profile', {
        userId: ids.userId,
        accountId: ids.accountId,
        profileId: ids.profileId,
      });

      const bootVerdict = reconcileHeldQuantity({
        ...resolveWalletFields({ free: '2', locked: '0' }),
        heldQuantity: '500',
        stepSize: '0.00001',
        minNotional,
        referencePrice: '50',
      });
      // Anchor the verdict itself, so a rule change that makes both doors no-op cannot satisfy the equality below by leaving nothing to compare.
      expect(bootVerdict.action).toBe('adopt-wallet-smaller');
      expect(bootVerdict.nextHeldQuantity).toBe(expected);
      const persisted = h.persistedSymbolStates.at(-1)?.state as { heldQuantity: string | null };
      expect(persisted.heldQuantity).toBe(bootVerdict.nextHeldQuantity);
    },
  );

  it('reconfigure-profile: prices a symbol the ticker cache has never held, via the batched REST fallback', async () => {
    // Not a cold-start race — a guaranteed miss. `handleReconfigure` runs this reconcile BEFORE `setSymbols`, so a newly added symbol has never had a miniTicker subscription and its `ticker:` key cannot exist. Without the fallback every dust value bound stands down on exactly the pass that re-adopts a symbol, and an operator re-adding one that still carries sub-notional residue has the seed gate rebuild the unsellable strand this whole change exists to prevent.
    const h = buildHarness();
    armReconcile(h, {
      walletFree: '0.5',
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

  it('apply-avg-entry-price: force-sets avgEntryPrice + wallet-sized held qty from the ledger (#496)', async () => {
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
    expect(finalWrite?.state).toMatchObject({ avgEntryPrice: '50', heldQuantity: '2' });
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

  it.each([
    ['declines a wallet no sell could round up to', '10', true],
    ['writes the wallet the prune vouched for', '0.00001', false],
  ])(
    "apply-avg-entry-price: reconciles to the boot door's own verdict and %s",
    async (_label, stepSize, expectedPhantom) => {
      // The third door onto the same decision. Boot adoption and the reconfigure reconcile both ask `reconcileHeldQuantity` whether a wallet balance is worth tracking; this one sized the position straight off `free + locked` and wrote it, so the same profile ends up with a different held quantity depending on which door the operator walked through. Asserting against that function's live verdict rather than a literal is what makes the three provably one rule: change the rule and all three move together, or this fails.
      //
      // The ledger quantity is passed as the CLAIM, not as `null`. That is what keeps the existing in-code defence intact: a real recorded quantity over a dust wallet routes to `adopt-wallet-smaller`, so the refusal converges the quantity instead of letting `flatten-sub-notional-dust` delete a cost basis the operator submitted seconds ago.
      //
      // Both rows are needed, and they straddle the one bound that may refuse. A 2-of-500 wallet is a 0.4% crumb share, so `isUnsellableDust` returns null on BOTH rows and the reconciler alone cannot tell them apart. What separates them is the increment arm the prune judges absolutely: under a step of 10 the wallet cannot be rounded up to a sellable order and the prune deletes the row, so refusing is right; under a step of 0.00001 the same wallet is a real holding the prune keeps, and refusing there would leave a priced row no later pass can reach.
      const h = buildHarness();
      const minNotional = '200';
      armReconcile(h, { walletFree: '2', price: '50', stepSize, minNotional });
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        symbol: 'BTCUSDT',
        avgEntryPrice: '50',
        quantity: '500',
      });
      repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);

      await h.invoke('apply-avg-entry-price', {
        userId: ids.userId,
        accountId: ids.accountId,
        profileId: ids.profileId,
        symbol: 'BTCUSDT',
      });

      const bootVerdict = reconcileHeldQuantity({
        ...resolveWalletFields({ free: '2', locked: '0' }),
        heldQuantity: '500',
        stepSize,
        minNotional,
        referencePrice: '50',
      });
      const phantom = isPhantomLedgerRow({
        ledgerAvgEntryPrice: '50',
        stateAvgEntryPrice: null,
        walletQuantity: '2',
        stepSize,
        minNotional,
        referencePrice: '50',
        preReconcileHeldQuantity: '500',
      });
      // Anchored, so a rule change that makes every door no-op cannot satisfy the equalities below by leaving nothing to compare. The reconciler names no quantity on either row, which is exactly why it cannot be the thing that decides.
      expect(bootVerdict.nextHeldQuantity).toBeNull();
      expect(phantom).toBe(expectedPhantom);

      const write = h.persistedSymbolStates.find((w) => w.symbol === 'BTCUSDT');
      if (phantom) {
        // No write at all, not a cleared body. The operator's correction is the PRICE; declining to apply it must leave the symbol exactly as it was found, and the ledger row it came from is the api's to own — the prune is what removes it.
        expect(write).toBeUndefined();
        expect(repoMocks.avgEntryPricesRemove).not.toHaveBeenCalled();
      } else {
        expect((write?.state as { heldQuantity: string | null }).heldQuantity).toBe('2');
      }
    },
  );

  it.each([
    ['below one lot-size increment', '5', '5', '1', '10', '1', 'no-op', true],
    ['valueless residue', '0.05', '0.05', '1', '0.00001', '10', 'flatten-sub-notional-dust', true],
    ['worth part of one minimum order', '5', '5', '1', '0.0001', '10', 'no-op', false],
    // The wallet is valueless residue while the recorded claim still prices, so only the value arm can decide, and it decides on the quantity this door is about to WRITE. Ask it under the ledger's 5 instead and the arm disarms, the wallet is written, and the very next reconcile pass flattens it — deleting the operator's row and paging a latching critical.
    [
      'a residue wallet under a claim that still prices',
      '0.09',
      '5',
      '1',
      '0.00001',
      '10',
      'adopt-wallet-smaller',
      true,
    ],
    // A real holding worth half a minimum order under a stale hundred-fold claim. `isUnsellableDust` reads it as a crumb and `adopt-wallet-smaller` names no quantity, but the prune keeps the row, so refusing here would strand a priced row no later pass can reach. The wallet is what gets written.
    // Split across both legs on purpose. Coins in a resting sell report as `locked`, the ordinary shape for a position this bot is trying to exit, and this is the one row where the total is what gets WRITTEN rather than merely judged — the reconciler computes its own `free + locked`, so anywhere it names the quantity a dropped leg is invisible.
    [
      'a crumb-share of a stale claim, held partly in a resting sell',
      '1',
      '1000',
      '1',
      '0.0001',
      '10',
      'adopt-wallet-smaller',
      false,
      '4',
    ],
    [
      'larger than the recorded quantity',
      '10',
      '2',
      '50',
      '0.00001',
      '10',
      'adopt-state-smaller',
      false,
    ],
  ])(
    'apply-avg-entry-price: refuses exactly what the prune deletes when the wallet is %s',
    async (
      _label,
      walletFree,
      ledgerQuantity,
      price,
      stepSize,
      minNotional,
      expectedClaimAction,
      expectedPhantom,
      walletLocked = '0',
    ) => {
      // The ordinary path, which the divergent stale-ledger rows above cannot reach. The api sizes `avg_entry_prices.quantity` as `free + locked` off the live wallet snapshot and enqueues this job seconds later, so the claim this door receives is the SAME number as the wallet it re-reads. `diff.lte(step)` then short-circuits to `no-op` with a non-null quantity, which is why the reconciler alone cannot decide whether a position may exist here: row 1 is below one LOT_SIZE step and would still be adopted as a position no sell can round up to.
      //
      // The bar that does decide is the boot prune's own predicate, and the two directions of getting it wrong are what the last two rows pin. Refuse MORE than the prune and row 3 is rejected while its ledger row survives every later pass, so the next boot revives the cost basis onto a position with no quantity — a strand strictly worse than the one this door was fixed to prevent. Refuse LESS and rows 1 and 2 are written as positions the next boot deletes the basis out from under. Only the same predicate gives both directions at once.
      const h = buildHarness();
      armReconcile(h, { walletFree, walletLocked, price, stepSize, minNotional });
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        symbol: 'BTCUSDT',
        avgEntryPrice: '50',
        quantity: ledgerQuantity,
      });
      repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);

      await h.invoke('apply-avg-entry-price', {
        userId: ids.userId,
        accountId: ids.accountId,
        profileId: ids.profileId,
        symbol: 'BTCUSDT',
      });

      const gateInput = {
        ...resolveWalletFields({ free: walletFree, locked: walletLocked }),
        stepSize,
        minNotional,
        referencePrice: price,
      };
      const walletTotal = new Decimal(walletFree).plus(walletLocked).toFixed();
      const claimVerdict = reconcileHeldQuantity({ ...gateInput, heldQuantity: ledgerQuantity });
      const phantom = isPhantomLedgerRow({
        ledgerAvgEntryPrice: '50',
        stateAvgEntryPrice: null,
        walletQuantity: walletTotal,
        stepSize,
        minNotional,
        referencePrice: price,
        // The claim the NEXT pass judges is what this door is about to write, not what it read. Asking under the ledger quantity disarms the prune's value arm for a wallet the very next reconcile flattens, and flatten DELETES the row and pages.
        preReconcileHeldQuantity: claimVerdict.nextHeldQuantity ?? walletTotal,
      });
      // Both anchored to the row's literals, so a rule change that collapsed either question into a permanent pass cannot satisfy the equalities below vacuously.
      expect(claimVerdict.action).toBe(expectedClaimAction);
      expect(phantom).toBe(expectedPhantom);

      const write = h.persistedSymbolStates.find((w) => w.symbol === 'BTCUSDT');
      if (phantom) {
        expect(write).toBeUndefined();
        expect(repoMocks.avgEntryPricesRemove).not.toHaveBeenCalled();
        return;
      }
      // The reconciler only SIZES; where it names no quantity the wallet the prune vouched for is written instead.
      const expectedHeld = claimVerdict.nextHeldQuantity ?? walletTotal;
      expect((write?.state as { heldQuantity: string | null }).heldQuantity).toBe(expectedHeld);
      // The applied line carries which arm sized it. Unpinned, the field is free to go null or stale and nothing downstream would notice that "the rule judged this" had quietly become "the rule never ran".
      expect(h.info.find((i) => i.msg === 'pipeline_apply_avg_entry_price_set')?.ctx).toMatchObject(
        {
          action: claimVerdict.action,
          heldQuantity: expectedHeld,
        },
      );
    },
  );

  it('apply-avg-entry-price: seeds every disarm reason at zero even when no bound stands down', async () => {
    // The seeds are what the `offset 2h` arm of the disarm alert compares against, and only a HEALTHY pass creates them: on a pass that fires, the reason that fired is born at its own increment whether or not the loop ran. So this is the only shape that can catch the loop being folded inside `if (gate.disarmed !== null)`, which every other test in this file would still pass.
    const h = buildHarness();
    armReconcile(h, { walletFree: '5', price: '10', stepSize: '0.0001', minNotional: '10' });
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      avgEntryPrice: '50',
      quantity: '5',
    });
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);

    await h.invoke('apply-avg-entry-price', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });

    const disarmCalls = h.metrics.record.mock.calls.filter(
      (c) => c[0] === 'reconcile_value_bound_disarmed_total',
    );
    expect(
      disarmCalls.filter((c) => c[1] === 0).map((c) => (c[2] as { reason: string }).reason),
    ).toEqual(['no-reference-price', 'no-min-notional', 'no-wallet-total']);
    // The seeds being the ONLY writes is what makes them load-bearing rather than incidental.
    expect(disarmCalls.filter((c) => c[1] !== 0)).toEqual([]);
  });

  /** The stand-down counter's writes on the pass just invoked, in the order they were recorded. */
  const seedGateCalls = (
    h: ReturnType<typeof buildHarness>,
  ): { value: number; reason: string; labels: Record<string, unknown>; index: number }[] =>
    h.metrics.record.mock.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call[0] === 'pipeline_apply_seed_gate_stood_down_total')
      .map(({ call, index }) => ({
        value: call[1] as number,
        reason: (call[2] as { reason: string }).reason,
        labels: call[2] as Record<string, unknown>,
        index,
      }));

  it('apply-avg-entry-price: seeds every stand-down reason at zero on the APPLIED arm', async () => {
    // The one shape that catches the seed being left inside the `stood-down` branch. This counter is incremented on the OTHER arm from its sibling disarm counter, so a profile whose gate always resolves cleanly would never have its children created — and its first real stand-down would export a series that has always read 1, which `increase()` reads as no change. Every other test in this file passes with the seed misplaced.
    const h = buildHarness();
    armReconcile(h, { walletFree: '5', price: '10', stepSize: '0.0001', minNotional: '10' });
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      avgEntryPrice: '50',
      quantity: '5',
    });
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);

    await h.invoke('apply-avg-entry-price', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });

    const calls = seedGateCalls(h);
    // Order-sensitive against the tuple the production loop iterates, so a reason added to the gate but not to the tuple is visible here as well as at the compiler.
    expect(calls.map((c) => c.reason)).toEqual([...APPLY_SEED_GATE_STAND_DOWN_REASONS]);
    expect(calls.every((c) => c.value === 0)).toBe(true);
    // The gate did resolve, so the pass really is the applied arm and not a stand-down that happened to seed.
    expect(
      h.warnings.some((w) => w.msg === 'pipeline_apply_avg_entry_price_gate_unavailable'),
    ).toBe(false);
  });

  it('apply-avg-entry-price: counts the stand-down reason that fired, labelled by profile and symbol', async () => {
    // The signal itself. Without it the only trace of a gate that could not run is one `warn` line in a worker the operator has no reason to be reading, and the fallback it takes writes the recorded quantity as though the rule had judged it.
    const h = buildHarness();
    armReconcile(h, { walletFree: '2', price: '50', stepSize: '0.00001', minNotional: '200' });
    h.resolveBinanceClient.mockResolvedValue(null);
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      avgEntryPrice: '50',
      quantity: '500',
    });
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);

    await h.invoke('apply-avg-entry-price', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });

    const calls = seedGateCalls(h);
    expect(calls.filter((c) => c.value === 0).map((c) => c.reason)).toEqual([
      ...APPLY_SEED_GATE_STAND_DOWN_REASONS,
    ]);
    const fired = calls.filter((c) => c.value === 1);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.labels).toMatchObject({
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
      reason: 'no-client',
    });
  });

  it('apply-avg-entry-price: records the zero-seed BEFORE the stand-down increment', async () => {
    // Order is the property, not presence. A seed written after the increment leaves the child born at 1 and then reset to 0 — strictly worse than no seed at all, and a test that only checks both calls exist cannot tell the two arrangements apart.
    const h = buildHarness();
    armReconcile(h, { walletFree: '2', price: '50', stepSize: '0.00001', minNotional: '200' });
    h.resolveBinanceClient.mockResolvedValue(null);
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      avgEntryPrice: '50',
      quantity: '500',
    });
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);

    await h.invoke('apply-avg-entry-price', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });

    const calls = seedGateCalls(h);
    const seedIndexes = calls.filter((c) => c.value === 0).map((c) => c.index);
    const firedIndexes = calls.filter((c) => c.value === 1).map((c) => c.index);
    expect(seedIndexes).toHaveLength(APPLY_SEED_GATE_STAND_DOWN_REASONS.length);
    expect(firedIndexes).toHaveLength(1);
    // Every seed, including the one for the reason that fired: the increment must land on a child that already exists at 0.
    expect(Math.max(...seedIndexes)).toBeLessThan(Math.min(...firedIndexes));
  });

  it.each([['-1']])(
    'apply-avg-entry-price: reads a recorded quantity of %s as no claim at all',
    async (quantity) => {
      // Zero is not the only way a row states no position. A negative quantity is the one other value that changes the outcome if it is let through as a claim: `adopt-state-smaller` writes it back verbatim, so the strategy ends up holding minus one coin. `NaN`, `Infinity` and an unparseable body are deliberately NOT tested here, because they cannot change the result — the reconciler's own parse rejects each of them and routes to a seed that the wallet fallback converges to the same quantity.
      const h = buildHarness();
      armReconcile(h, { walletFree: '5', price: '10', stepSize: '0.0001', minNotional: '10' });
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        symbol: 'BTCUSDT',
        avgEntryPrice: '50',
        quantity,
      });
      repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);

      await h.invoke('apply-avg-entry-price', {
        userId: ids.userId,
        accountId: ids.accountId,
        profileId: ids.profileId,
        symbol: 'BTCUSDT',
      });

      expect(h.persistedSymbolStates.at(-1)?.state).toMatchObject({
        avgEntryPrice: '50',
        heldQuantity: '5',
      });
    },
  );

  it('apply-avg-entry-price: stands every wallet bound down and keeps the recorded quantity when a balance leg will not parse', async () => {
    // The one input that makes `sumWalletLegs` return null, which is a different answer from an empty wallet: null means the question was never answered, and `isPhantomLedgerRow` would read a null total as "the operator holds none of this coin" and refuse. This is the only path that reaches the third rung of the sizing ladder, and the only one that produces `no-wallet-total` at this door.
    const h = buildHarness();
    armReconcile(h, { walletFree: '5', price: '10', stepSize: '0.0001', minNotional: '10' });
    repoMocks.binanceGetAccount.mockResolvedValue({
      balances: [{ asset: 'BTC', free: 'not-a-number', locked: '0' }],
    });
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      avgEntryPrice: '50',
      quantity: '7',
    });
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);

    await h.invoke('apply-avg-entry-price', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });

    // Written, not refused: an unevaluable bound must never be the thing that rejects an operator's write.
    expect(h.persistedSymbolStates.at(-1)?.state).toMatchObject({
      avgEntryPrice: '50',
      heldQuantity: '7',
    });
    // `rule`, not `ledger`: the reconciler's parse guard answers first and hands the claim straight back, so the ladder's third rung is reached only when the recorded quantity states no position either.
    expect(h.info.find((i) => i.msg === 'pipeline_apply_avg_entry_price_set')?.ctx).toMatchObject({
      sizedFrom: 'rule',
    });
    const disarms = h.metrics.record.mock.calls.filter(
      (c) => c[0] === 'reconcile_value_bound_disarmed_total' && c[1] === 1,
    );
    expect(disarms.map((c) => (c[2] as { reason: string }).reason)).toEqual(['no-wallet-total']);
  });

  it('apply-avg-entry-price: treats a recorded quantity of zero as no claim rather than as a claim of nothing', async () => {
    // Zero is how the rest of the module spells "no position", and handing it to the reconciler as a CLAIM inverts it into one: the flatten arm is guarded by `held.gt(0)` so it declines, and `adopt-state-smaller` then writes the zero back as the position's size, permanently. Normalising it to no claim sends the wallet down the cold-seed branch instead, which is the reading a row that prices nothing actually deserves.
    const h = buildHarness();
    armReconcile(h, { walletFree: '5', price: '10', stepSize: '0.0001', minNotional: '10' });
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      avgEntryPrice: '50',
      quantity: '0',
    });
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);

    await h.invoke('apply-avg-entry-price', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });

    expect(h.persistedSymbolStates.at(-1)?.state).toMatchObject({
      avgEntryPrice: '50',
      heldQuantity: '5',
    });
  });

  it("apply-avg-entry-price: refuses with a named reason and leaves the operator's ledger row alone", async () => {
    // The refusal has to be legible from the outside. A door that silently declines an operator's write is the same class of defect as the one it replaced: the symbol simply never picks the basis up, and nothing says why.
    const h = buildHarness();
    armReconcile(h, { walletFree: '2', price: '50', stepSize: '10', minNotional: '200' });
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      avgEntryPrice: '50',
      quantity: '500',
    });
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);

    await h.invoke('apply-avg-entry-price', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });

    const refusal = h.warnings.find(
      (w) => w.msg === 'pipeline_apply_avg_entry_price_no_sellable_position',
    );
    expect(refusal?.ctx).toMatchObject({ action: 'adopt-wallet-smaller', ledgerQuantity: '500' });
    // The api owns that row. Deleting a record it accepted seconds ago would leave the two surfaces contradicting each other.
    expect(repoMocks.avgEntryPricesRemove).not.toHaveBeenCalled();
    // And no "applied" line, so a log reader cannot conclude the basis reached the strategy.
    expect(h.info.some((i) => i.msg === 'pipeline_apply_avg_entry_price_set')).toBe(false);
  });

  it.each([
    ['no client resolves', 'no-client'],
    ['the symbol-info cache is empty', 'no-symbol-info'],
    ['the cached symbol-info does not parse', 'bad-symbol-info'],
    // Distinct from the null return above: that path never enters the catch. Without the catch an unreachable Redis escapes the handler and dead-letters an operator's write, and every other assertion in this table still passes.
    ['the symbol-info cache read throws', 'no-symbol-info-throws'],
    ['getAccount throws', 'getaccount-failed'],
  ])(
    'apply-avg-entry-price: stands the gate down and applies the ledger quantity when %s',
    async (_label, reason) => {
      // Standing down keeps the OLD behaviour rather than refusing. A bound that could not be evaluated must never be the thing that rejects an operator's write — the hazard is a position fabricated out of an untradeable wallet, and applying what the operator actually recorded fabricates nothing. Each arm is named, because a missing price is a cache problem and a missing symbol-info blob is an exchange-info refresh problem.
      const h = buildHarness();
      armReconcile(h, { walletFree: '2', price: '50', stepSize: '0.00001', minNotional: '200' });
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        symbol: 'BTCUSDT',
        avgEntryPrice: '50',
        quantity: '500',
      });
      repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);
      if (reason === 'no-client') h.resolveBinanceClient.mockResolvedValue(null);
      if (reason === 'no-symbol-info') h.redis.get.mockImplementation(async () => null);
      if (reason === 'no-symbol-info-throws') {
        // Scoped to the symbol-info key on purpose: a blanket rejection also takes down readers outside this door, and the fault being modelled is the gate's own cache read failing.
        h.redis.get.mockImplementation(async (key: string) => {
          if (key === buildSymbolInfoKey('BTCUSDT', 'live')) throw new Error('redis down');
          return null;
        });
      }
      if (reason === 'bad-symbol-info') h.redis.get.mockImplementation(async () => 'not json');
      if (reason === 'getaccount-failed') {
        repoMocks.binanceGetAccount.mockRejectedValue(new Error('binance down'));
      }

      await h.invoke('apply-avg-entry-price', {
        userId: ids.userId,
        accountId: ids.accountId,
        profileId: ids.profileId,
        symbol: 'BTCUSDT',
      });

      expect(
        h.warnings.find((w) => w.msg === 'pipeline_apply_avg_entry_price_gate_unavailable')?.ctx,
      ).toMatchObject({ reason: reason === 'no-symbol-info-throws' ? 'no-symbol-info' : reason });
      // The recorded quantity, NOT the 2-coin dust wallet: a gate that never ran cannot be the thing that sized the position either.
      expect(h.persistedSymbolStates.at(-1)?.state).toMatchObject({
        avgEntryPrice: '50',
        heldQuantity: '500',
      });
      // Null action, and pinned. It is the only thing separating "the rule judged this quantity" from "the rule never ran", and both lines otherwise read identically.
      expect(h.info.find((i) => i.msg === 'pipeline_apply_avg_entry_price_set')?.ctx).toMatchObject(
        {
          action: null,
        },
      );
    },
  );

  it.each([
    ['null'],
    ['123'],
    ['{}'],
    ['{"baseAsset":"BTC"}'],
    ['{"baseAsset":1,"filters":{}}'],
    // A well-formed blob carrying a zeroed increment, which the exchange-info refresh really caches for a pair with an incomplete filter set. A `typeof` check passes it, and then BOTH the reconciler and the prune take their own `step.lte(0)` stand-downs, so the door writes the recorded quantity as though the rule had judged it and nothing reports that it did not.
    ['{"baseAsset":"BTC","filters":{"stepSize":"0","minNotional":"10"}}'],
  ])(
    'apply-avg-entry-price: degrades to the ledger quantity on a symbol-info blob of %s rather than dead-lettering the job',
    async (blob) => {
      // `null`, `123` and `{}` are all VALID JSON, so a shape-wrong blob parses cleanly and only fails on the field read. A field read outside the parse guard throws a TypeError past it, out of the handler, and BullMQ retries then dead-letters a write the operator made — for a cache blob problem the gate is supposed to shrug at. The last row is the other half: a blob whose fields are merely the wrong TYPE never throws at all, and an unparseable `stepSize` would put the reconciler back on the silent no-op this gate exists to close.
      const h = buildHarness();
      armReconcile(h, { walletFree: '2', price: '50', stepSize: '0.00001', minNotional: '200' });
      h.redis.get.mockImplementation(async (key: string) =>
        key === buildSymbolInfoKey('BTCUSDT', 'live') ? blob : null,
      );
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        symbol: 'BTCUSDT',
        avgEntryPrice: '50',
        quantity: '500',
      });
      repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);

      await expect(
        h.invoke('apply-avg-entry-price', {
          userId: ids.userId,
          accountId: ids.accountId,
          profileId: ids.profileId,
          symbol: 'BTCUSDT',
        }),
      ).resolves.toBeUndefined();

      expect(
        h.warnings.find((w) => w.msg === 'pipeline_apply_avg_entry_price_gate_unavailable')?.ctx,
      ).toMatchObject({ reason: 'bad-symbol-info' });
      expect(h.persistedSymbolStates.at(-1)?.state).toMatchObject({ heldQuantity: '500' });
    },
  );

  it('apply-avg-entry-price: treats a getAccount response with no balances as the call having failed', async () => {
    // `getAccount` is a cast over the REST payload with no runtime validation, so `balances` can simply be absent. Reading it outside the try turns that into a TypeError that dead-letters the job; inside, it is what it is — the call did not produce an account.
    const h = buildHarness();
    armReconcile(h, { walletFree: '2', price: '50', stepSize: '0.00001', minNotional: '200' });
    repoMocks.binanceGetAccount.mockResolvedValue({});
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      avgEntryPrice: '50',
      quantity: '500',
    });
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);

    await expect(
      h.invoke('apply-avg-entry-price', {
        userId: ids.userId,
        accountId: ids.accountId,
        profileId: ids.profileId,
        symbol: 'BTCUSDT',
      }),
    ).resolves.toBeUndefined();

    expect(
      h.warnings.find((w) => w.msg === 'pipeline_apply_avg_entry_price_gate_unavailable')?.ctx,
    ).toMatchObject({ reason: 'getaccount-failed' });
    expect(h.persistedSymbolStates.at(-1)?.state).toMatchObject({ heldQuantity: '500' });
  });

  it.each([
    ['the Binance client factory throws', 'no-client'],
    ['getAccount throws', 'getaccount-failed'],
  ])('apply-avg-entry-price: carries the cause when %s', async (_label, reason) => {
    // Without the cause an expired key, an IP-allowlist rejection and a socket timeout are one indistinguishable line. They have three different remedies and the operator has to pick one.
    const h = buildHarness();
    armReconcile(h, { walletFree: '2', price: '50', stepSize: '0.00001', minNotional: '200' });
    const cause = new Error('binance down');
    if (reason === 'no-client') h.resolveBinanceClient.mockRejectedValue(cause);
    else repoMocks.binanceGetAccount.mockRejectedValue(cause);
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      avgEntryPrice: '50',
      quantity: '500',
    });
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);

    await h.invoke('apply-avg-entry-price', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });

    const ctx = h.warnings.find((w) => w.msg === 'pipeline_apply_avg_entry_price_gate_unavailable')
      ?.ctx as { reason?: string; err?: unknown } | undefined;
    expect(ctx?.reason).toBe(reason);
    expect(ctx?.err).toBe(cause);
  });

  it('apply-avg-entry-price: seeds every disarm reason at zero before counting the one that fired', async () => {
    // The zero-seed is the whole signal. A prom-client child does not exist until its first write and is born holding that write's value, so an unseeded counter's first incident reads as a series that has always been 1, which `increase()` sees as no change — and this door reaches the disarm arm exactly when nobody is watching it.
    const h = buildHarness();
    armReconcile(h, { walletFree: '2', price: '50', stepSize: '0.00001', minNotional: '200' });
    // Neither the ticker cache nor the batched REST fallback can price the symbol, which is what disarms the value bound.
    h.redis.get.mockImplementation(async (key: string) =>
      key === buildSymbolInfoKey('BTCUSDT', 'live')
        ? JSON.stringify({
            baseAsset: 'BTC',
            filters: { stepSize: '0.00001', minNotional: '200' },
          })
        : null,
    );
    repoMocks.binanceGetPriceTickers.mockResolvedValue([]);
    repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
      symbol: 'BTCUSDT',
      avgEntryPrice: '50',
      quantity: '500',
    });
    repoMocks.symbolStatesFindBySymbol.mockResolvedValue(null);

    await h.invoke('apply-avg-entry-price', {
      userId: ids.userId,
      accountId: ids.accountId,
      profileId: ids.profileId,
      symbol: 'BTCUSDT',
    });

    const disarmCalls = h.metrics.record.mock.calls.filter(
      (c) => c[0] === 'reconcile_value_bound_disarmed_total',
    );
    // Every reason seeded, not only the one that fired: the next incident may be a different reason on the same symbol, and that child has to exist at zero before its own first increment.
    expect(
      disarmCalls.filter((c) => c[1] === 0).map((c) => (c[2] as { reason: string }).reason),
    ).toEqual(['no-reference-price', 'no-min-notional', 'no-wallet-total']);
    const fired = disarmCalls.filter((c) => c[1] === 1);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.[2]).toMatchObject({ symbol: 'BTCUSDT', reason: 'no-reference-price' });
    expect(
      h.warnings.some((w) => w.msg === 'pipeline_apply_avg_entry_price_value_bound_disarmed'),
    ).toBe(true);
    // A disarmed bound reports; it does not veto. Folding `disarmed !== null` into the refusal would reject an operator's write every time the ticker cache is cold, and every other assertion here would still pass. The quantity is the WALLET's 2, not the recorded 500: only the VALUE bounds stood down, and "adopt the smaller" is an increment comparison that needs no price at all.
    expect(h.persistedSymbolStates.at(-1)?.state).toMatchObject({
      avgEntryPrice: '50',
      heldQuantity: '2',
    });
    expect(h.info.some((i) => i.msg === 'pipeline_apply_avg_entry_price_set')).toBe(true);
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
