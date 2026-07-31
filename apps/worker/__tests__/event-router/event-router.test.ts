import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { createEventRouter } from '../../src/event-router/event-router.js';
import type { ProfileManager } from 'profile-manager/profile-manager.js';
import type { FillAdopter } from 'executor/fill-adopter.js';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { TickJobData } from 'queues/job-payloads.js';

const noopLogger = pino({ level: 'silent' });

const makeProfileManager = (overrides?: Partial<ProfileManager>): ProfileManager => ({
  start: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  setSymbols: vi.fn(),
  profilesUsing: () => [],
  symbolsFor: () => [],
  userOf: () => undefined,
  operatorOf: () => undefined,
  accountOf: () => undefined,
  shutdown: vi.fn(),
  ...overrides,
});

const makeQueue = (): Queue<TickJobData> => {
  const calls: { name: string; data: TickJobData; jobId?: string }[] = [];
  return {
    add: vi.fn(async (name: string, data: TickJobData, opts?: { jobId?: string }) => {
      const entry: { name: string; data: TickJobData; jobId?: string } = { name, data };
      if (opts?.jobId !== undefined) entry.jobId = opts.jobId;
      calls.push(entry);
      return { id: opts?.jobId };
    }),
    addCalls: calls,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
};

const makeRedis = (): Redis =>
  ({ set: vi.fn(async () => 'OK'), del: vi.fn(async () => 1) }) as unknown as Redis;

// Issue #649 C1: the open-orders cache mutates IN PLACE via a single atomic
// Lua EVAL (GET→patch→SET, no owner/lock), instead of DELeting the whole key
// on every execution report. The router still calls raw `deps.redis`, so the
// mutation is observable as a `redis.eval(script, 1, key, op, ...argv)` call —
// mirroring the BUCKET_LUA governor's positional-ARGV grammar. `op` is one of
// 'upsert' | 'remove' | 'patch'; the last ARGV is the refreshed TTL.
const makeRedisWithEval = (): Redis =>
  ({
    set: vi.fn(async () => 'OK'),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 1),
    eval: vi.fn(async () => null),
  }) as unknown as Redis;

// The four money-path deps are REQUIRED on EventRouterDeps: omitting the
// ownership gate would have to assume `own` and adopt every sibling's fill.
// Tests that don't exercise those paths still have to name their stance, so it
// lives here once rather than as a permissive default in the production type.
// Spread first in each literal; a test that cares overrides the key after it.
const moneyDeps = () => ({
  fillAdopter: { adopt: vi.fn(), reconcileDetachedFill: vi.fn() } as unknown as FillAdopter,
  backfillFills: vi.fn(async () => undefined),
  mergeAccount: vi.fn(async () => undefined),
  classifyOrder: vi.fn(async () => 'own' as const),
});

// The keys a spy saw as its first argument, for "no open-orders write" checks.
const firstArgs = (spy: unknown): string[] =>
  (spy as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));

describe('EventRouter', () => {
  it('fans miniTicker out to every profile using the symbol with deterministic jobId', async () => {
    const tickQueue = makeQueue();
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue,
      redis: makeRedis(),
      profileManager: makeProfileManager({
        profilesUsing: (s) => (s === 'BTCUSDT' ? [asProfileId('p1'), asProfileId('p2')] : []),
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
      }),
      indicatorComputer: { recompute: vi.fn() },
      logger: noopLogger,
      clock: { nowMs: () => 1234 },
    });
    await router.onMarketEvent({
      kind: 'mini-ticker',
      symbol: 'BTCUSDT',
      closePrice: '50000',
      eventTimeMs: 100,
    });
    expect(tickQueue.add).toHaveBeenCalledTimes(2);
    expect(tickQueue.add).toHaveBeenNthCalledWith(
      1,
      'tick',
      expect.objectContaining({
        profileId: 'p1',
        accountId: 'a1',
        symbol: 'BTCUSDT',
        event: 'mini-ticker',
      }),
      expect.objectContaining({ jobId: 'tick:p1:BTCUSDT' }),
    );
    expect(tickQueue.add).toHaveBeenNthCalledWith(
      2,
      'tick',
      expect.objectContaining({ profileId: 'p2', accountId: 'a1' }),
      expect.objectContaining({ jobId: 'tick:p2:BTCUSDT' }),
    );
  });

  it('enqueues tick jobs with removeOnComplete/removeOnFail set so the static jobId is reusable after each tick', async () => {
    // Regression: static jobId (`tick:<pid>:<sym>`) coalesces in-flight
    // ticks. If completed/failed jobs are RETAINED (count/age opts),
    // BullMQ rejects every subsequent .add() as a duplicate and the
    // tick pipeline silently stops. The terminal-state slot MUST be
    // released, so both options must be `true`.
    const tickQueue = makeQueue();
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue,
      redis: makeRedis(),
      profileManager: makeProfileManager({
        profilesUsing: () => [asProfileId('p1')],
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
      }),
      indicatorComputer: { recompute: vi.fn() },
      logger: noopLogger,
    });
    await router.onMarketEvent({
      kind: 'mini-ticker',
      symbol: 'BTCUSDT',
      closePrice: '50000',
      eventTimeMs: 100,
    });
    expect(tickQueue.add).toHaveBeenCalledWith(
      'tick',
      expect.anything(),
      expect.objectContaining({
        jobId: 'tick:p1:BTCUSDT',
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
  });

  it('miniTicker persists the symbol-global ticker key with a TTL', async () => {
    const redis = makeRedis();
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue: makeQueue(),
      redis,
      profileManager: makeProfileManager({
        profilesUsing: () => [asProfileId('p1')],
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
      }),
      indicatorComputer: { recompute: vi.fn() },
      logger: noopLogger,
      clock: { nowMs: () => 1234 },
    });
    await router.onMarketEvent({
      kind: 'mini-ticker',
      symbol: 'BTCUSDT',
      closePrice: '50000',
      eventTimeMs: 100,
    });
    expect(redis.set).toHaveBeenCalledWith(
      'ticker:BTCUSDT',
      JSON.stringify({ price: '50000', ts: 1234 }),
      'EX',
      60,
    );
  });

  it('skips kline events that are not closed', async () => {
    const tickQueue = makeQueue();
    const indicator = { recompute: vi.fn() };
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue,
      redis: makeRedis(),
      profileManager: makeProfileManager({
        profilesUsing: () => [asProfileId('p1')],
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
      }),
      indicatorComputer: indicator,
      logger: noopLogger,
    });
    await router.onMarketEvent({
      kind: 'kline',
      symbol: 'BTCUSDT',
      interval: '1h',
      openTimeMs: 0,
      closeTimeMs: 1,
      open: '1',
      high: '1',
      low: '1',
      close: '1',
      volume: '1',
      isClosed: false,
    });
    expect(indicator.recompute).not.toHaveBeenCalled();
    expect(tickQueue.add).not.toHaveBeenCalled();
  });

  it('on closed kline: recomputes indicator then enqueues kline-close tick', async () => {
    const tickQueue = makeQueue();
    const indicator = { recompute: vi.fn(async () => undefined) };
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue,
      redis: makeRedis(),
      profileManager: makeProfileManager({
        profilesUsing: () => [asProfileId('p1')],
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
      }),
      indicatorComputer: indicator,
      logger: noopLogger,
    });
    await router.onMarketEvent({
      kind: 'kline',
      symbol: 'BTCUSDT',
      interval: '1h',
      openTimeMs: 0,
      closeTimeMs: 3_600_000,
      open: '1',
      high: '2',
      low: '0.5',
      close: '1.5',
      volume: '10',
      isClosed: true,
    });
    expect(indicator.recompute).toHaveBeenCalledWith('BTCUSDT', '1h', expect.any(Object));
    expect(tickQueue.add).toHaveBeenCalledWith(
      'tick',
      expect.objectContaining({ event: 'kline-close' }),
      expect.objectContaining({ jobId: 'tick:p1:BTCUSDT' }),
    );
  });

  it('user execution-report routes only to the owning profile', async () => {
    const tickQueue = makeQueue();
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue,
      redis: makeRedis(),
      profileManager: makeProfileManager({
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
        symbolsFor: () => ['BTCUSDT'],
      }),
      indicatorComputer: { recompute: vi.fn() },
      logger: noopLogger,
    });
    await router.onUserEvent({
      kind: 'execution-report',
      userId: asUserId('u1'),
      profileId: asProfileId('p1'),
      symbol: 'BTCUSDT',
      orderId: 1,
      clientOrderId: 'v1-x',
      orderStatus: 'FILLED',
      side: 'BUY',
      executionType: 'TRADE',
      priceLastFilled: '0',
      qtyLastFilled: '0',
      cumQty: '1',
      cumQuoteQty: '50',
      eventTimeMs: 0,
    });
    expect(tickQueue.add).toHaveBeenCalledTimes(1);
    expect(tickQueue.add).toHaveBeenCalledWith(
      'tick',
      expect.objectContaining({
        profileId: 'p1',
        accountId: 'a1',
        symbol: 'BTCUSDT',
        event: 'execution-report',
      }),
      expect.any(Object),
    );
  });

  it('drops an execution-report for an order owned by a sibling profile (shared master-account listenKey)', async () => {
    const tickQueue = makeQueue();
    const redis = makeRedis();
    const adopt = vi.fn(async () => undefined);
    const classifyOrder = vi.fn(async () => 'sibling' as const);
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue,
      redis,
      profileManager: makeProfileManager({
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
        symbolsFor: () => ['BTCUSDT'],
      }),
      indicatorComputer: { recompute: vi.fn() },
      fillAdopter: { adopt } as unknown as FillAdopter,
      classifyOrder,
      logger: noopLogger,
    });
    // A sibling profile's XPL fill arriving on this profile's shared stream.
    await router.onUserEvent({
      kind: 'execution-report',
      userId: asUserId('u1'),
      profileId: asProfileId('p2'),
      symbol: 'XPLUSDT',
      orderId: 99,
      clientOrderId: 'tt-foreign',
      orderStatus: 'FILLED',
      side: 'BUY',
      executionType: 'TRADE',
      priceLastFilled: '0',
      qtyLastFilled: '0',
      cumQty: '1',
      cumQuoteQty: '50',
      eventTimeMs: 0,
    });
    expect(classifyOrder).toHaveBeenCalledWith(
      asUserId('u1'),
      asAccountId('a1'),
      asProfileId('p2'),
      99,
    );
    // No adoption (would write a foreign position), no tick (would run the
    // strategy on a symbol this profile never subscribed), no cache write.
    expect(adopt).not.toHaveBeenCalled();
    expect(tickQueue.add).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('routes a DETACHED order’s terminal report to the ledger-only reconcile: no adopt, no tick', async () => {
    const tickQueue = makeQueue();
    const redis = makeRedis();
    const adopt = vi.fn(async () => undefined);
    const reconcileDetachedFill = vi.fn(async () => undefined);
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue,
      redis,
      profileManager: makeProfileManager({
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
        symbolsFor: () => ['BTCUSDT'],
      }),
      indicatorComputer: { recompute: vi.fn() },
      fillAdopter: { adopt, reconcileDetachedFill } as unknown as FillAdopter,
      classifyOrder: vi.fn(async () => 'detached' as const),
      clock: { nowMs: () => 1_700_000_000_000 },
      logger: noopLogger,
    });
    // An order whose profile was deleted fills on the account's stream. Nobody can
    // adopt it, but its ledger row must close or it is phantom exposure forever.
    await router.onUserEvent({
      kind: 'execution-report',
      userId: asUserId('u1'),
      profileId: asProfileId('p1'),
      symbol: 'XPLUSDT',
      orderId: 77,
      clientOrderId: 'tt-detached',
      orderStatus: 'FILLED',
      side: 'SELL',
      executionType: 'TRADE',
      priceLastFilled: '0',
      qtyLastFilled: '0',
      cumQty: '3',
      cumQuoteQty: '150',
      eventTimeMs: 0,
    });
    expect(reconcileDetachedFill).toHaveBeenCalledWith({
      operatorId: asUserId('u1'),
      accountId: asAccountId('a1'),
      symbol: 'XPLUSDT',
      orderId: 77,
      orderStatus: 'FILLED',
      cumQty: '3',
      cumQuoteQty: '150',
      eventTimeMs: 1_700_000_000_000,
    });
    // Ledger close only: no cost basis / strategy state (adopt), and no tick for a
    // profile that does not own the symbol.
    expect(adopt).not.toHaveBeenCalled();
    expect(tickQueue.add).not.toHaveBeenCalled();
  });

  it('forwards the EXCHANGE’s event time, not the worker clock, when the report carries one', async () => {
    // The same row can be settled by this path or by detached-orders-reconcile
    // (which passes Binance's `updateTime`). Stamping `closed_at` from the wall
    // clock here would give one row two different close times depending on which
    // path happened to win.
    const reconcileDetachedFill = vi.fn(async () => undefined);
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue: makeQueue(),
      redis: makeRedis(),
      profileManager: makeProfileManager({
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
        symbolsFor: () => ['BTCUSDT'],
      }),
      indicatorComputer: { recompute: vi.fn() },
      fillAdopter: { adopt: vi.fn(), reconcileDetachedFill } as unknown as FillAdopter,
      classifyOrder: vi.fn(async () => 'detached' as const),
      clock: { nowMs: () => 1_700_000_000_000 },
      logger: noopLogger,
    });
    await router.onUserEvent({
      kind: 'execution-report',
      userId: asUserId('u1'),
      profileId: asProfileId('p1'),
      symbol: 'XPLUSDT',
      orderId: 77,
      clientOrderId: 'tt-detached',
      orderStatus: 'FILLED',
      side: 'SELL',
      executionType: 'TRADE',
      priceLastFilled: '0',
      qtyLastFilled: '0',
      cumQty: '3',
      cumQuoteQty: '150',
      eventTimeMs: 1_699_999_999_111,
    });
    expect(reconcileDetachedFill).toHaveBeenCalledWith(
      expect.objectContaining({ eventTimeMs: 1_699_999_999_111 }),
    );
  });

  it('a throwing detached reconcile is swallowed: the stream keeps flowing and the cron retries', async () => {
    const reconcileDetachedFill = vi.fn(async () => {
      throw new Error('pg down');
    });
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue: makeQueue(),
      redis: makeRedis(),
      profileManager: makeProfileManager({
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
        symbolsFor: () => ['BTCUSDT'],
      }),
      indicatorComputer: { recompute: vi.fn() },
      fillAdopter: { adopt: vi.fn(), reconcileDetachedFill } as unknown as FillAdopter,
      classifyOrder: vi.fn(async () => 'detached' as const),
      logger: noopLogger,
    });
    await expect(
      router.onUserEvent({
        kind: 'execution-report',
        userId: asUserId('u1'),
        profileId: asProfileId('p1'),
        symbol: 'XPLUSDT',
        orderId: 77,
        clientOrderId: 'tt-detached',
        orderStatus: 'CANCELED',
        side: 'SELL',
        executionType: 'CANCELED',
        priceLastFilled: '0',
        qtyLastFilled: '0',
        cumQty: '0',
        cumQuoteQty: '0',
        eventTimeMs: 0,
      }),
    ).resolves.toBeUndefined();
    expect(reconcileDetachedFill).toHaveBeenCalledTimes(1);
  });

  it('processes an execution-report for an own order (committed or not yet): adopts the fill and enqueues the tick', async () => {
    const tickQueue = makeQueue();
    const adopt = vi.fn(async () => undefined);
    // 'own' covers both an own committed order and an own just-placed order whose
    // row has not committed (owned by no profile yet, hence not foreign).
    const classifyOrder = vi.fn(async () => 'own' as const);
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue,
      redis: makeRedis(),
      profileManager: makeProfileManager({
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
        symbolsFor: () => ['BTCUSDT'],
      }),
      indicatorComputer: { recompute: vi.fn() },
      fillAdopter: { adopt } as unknown as FillAdopter,
      classifyOrder,
      logger: noopLogger,
    });
    await router.onUserEvent({
      kind: 'execution-report',
      userId: asUserId('u1'),
      profileId: asProfileId('p1'),
      symbol: 'BTCUSDT',
      orderId: 1,
      clientOrderId: 'tt-own',
      orderStatus: 'FILLED',
      side: 'BUY',
      executionType: 'TRADE',
      priceLastFilled: '0',
      qtyLastFilled: '0',
      cumQty: '1',
      cumQuoteQty: '50',
      eventTimeMs: 0,
    });
    expect(classifyOrder).toHaveBeenCalledWith(
      asUserId('u1'),
      asAccountId('a1'),
      asProfileId('p1'),
      1,
    );
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(tickQueue.add).toHaveBeenCalledTimes(1);
    expect(tickQueue.add).toHaveBeenCalledWith(
      'tick',
      expect.objectContaining({
        profileId: 'p1',
        accountId: 'a1',
        symbol: 'BTCUSDT',
        event: 'execution-report',
      }),
      expect.any(Object),
    );
  });

  it('execution-report mutates the ACCOUNT-domain open-orders cache in place (no profile segment, no whole-key DEL)', async () => {
    const redis = makeRedisWithEval();
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue: makeQueue(),
      redis,
      profileManager: makeProfileManager({
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
        symbolsFor: () => ['BTCUSDT'],
      }),
      indicatorComputer: { recompute: vi.fn() },
      logger: noopLogger,
    });
    await router.onUserEvent({
      kind: 'execution-report',
      userId: asUserId('u1'),
      profileId: asProfileId('p1'),
      symbol: 'BTCUSDT',
      orderId: 1,
      clientOrderId: 'v1-x',
      orderStatus: 'PARTIALLY_FILLED',
      side: 'BUY',
      executionType: 'TRADE',
      priceLastFilled: '0',
      qtyLastFilled: '0',
      cumQty: '1',
      cumQuoteQty: '50',
      eventTimeMs: 0,
    });
    // The key carries the account but NO profile segment: siblings share it.
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'tenant:a1:open-orders:BTCUSDT',
      'patch',
      '1',
      expect.anything(),
      expect.anything(),
      'PARTIALLY_FILLED',
      expect.anything(),
    );
    // The whole-key DEL (today's invalidation) is gone.
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('user events stamp the WS-liveness marker for account-snapshot-safety', async () => {
    const redis = makeRedis();
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue: makeQueue(),
      redis,
      profileManager: makeProfileManager({
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
        symbolsFor: () => ['BTCUSDT'],
      }),
      indicatorComputer: { recompute: vi.fn() },
      logger: noopLogger,
      clock: { nowMs: () => 1234 },
    });
    await router.onUserEvent({
      kind: 'account-position',
      userId: asUserId('u1'),
      profileId: asProfileId('p1'),
      balances: [{ asset: 'BTC', free: '1', locked: '0' }],
      eventTimeMs: 0,
    });
    expect(redis.set).toHaveBeenCalledWith(
      'tenant:a1:profile:p1:user-stream:last-event',
      '1234',
      'EX',
      3_600,
    );
  });

  it('account-position merges the changed balances into the account-info cache', async () => {
    const mergeAccount = vi.fn(async () => undefined);
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue: makeQueue(),
      redis: makeRedis(),
      profileManager: makeProfileManager({
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
        symbolsFor: () => ['BTCUSDT'],
      }),
      indicatorComputer: { recompute: vi.fn() },
      mergeAccount,
      logger: noopLogger,
    });
    await router.onUserEvent({
      kind: 'account-position',
      userId: asUserId('u1'),
      profileId: asProfileId('p1'),
      balances: [
        { asset: 'BTC', free: '0.12421', locked: '0' },
        { asset: 'USDT', free: '78516.99160750', locked: '0' },
      ],
      eventTimeMs: 0,
    });
    expect(mergeAccount).toHaveBeenCalledTimes(1);
    expect(mergeAccount).toHaveBeenCalledWith(asAccountId('a1'), asProfileId('p1'), [
      { asset: 'BTC', free: '0.12421', locked: '0' },
      { asset: 'USDT', free: '78516.99160750', locked: '0' },
    ]);
  });

  it('balance-update events do NOT invalidate the cache — they carry only a delta, not the authoritative balances', async () => {
    const mergeAccount = vi.fn(async () => undefined);
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue: makeQueue(),
      redis: makeRedis(),
      profileManager: makeProfileManager({
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
        symbolsFor: () => ['BTCUSDT'],
      }),
      indicatorComputer: { recompute: vi.fn() },
      mergeAccount,
      logger: noopLogger,
    });
    await router.onUserEvent({
      kind: 'balance-update',
      userId: asUserId('u1'),
      profileId: asProfileId('p1'),
      asset: 'BTC',
      delta: '0.00019',
      eventTimeMs: 0,
    });
    expect(mergeAccount).not.toHaveBeenCalled();
  });

  it('account-position tick enqueue is unaffected when mergeAccount throws', async () => {
    const mergeAccount = vi.fn(async () => Promise.reject(new Error('redis blip')));
    const tickQueue = makeQueue();
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue,
      redis: makeRedis(),
      profileManager: makeProfileManager({
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
        symbolsFor: () => ['BTCUSDT', 'ETHUSDT'],
      }),
      indicatorComputer: { recompute: vi.fn() },
      mergeAccount,
      logger: noopLogger,
    });
    await router.onUserEvent({
      kind: 'account-position',
      userId: asUserId('u1'),
      profileId: asProfileId('p1'),
      balances: [{ asset: 'BTC', free: '1', locked: '0' }],
      eventTimeMs: 0,
    });
    // Both symbol-fan-out tick enqueues still ran despite mergeAccount throw.
    expect(tickQueue.add).toHaveBeenCalledTimes(2);
  });

  it('market reconnect resync enqueues per subscriber', async () => {
    const tickQueue = makeQueue();
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue,
      redis: makeRedis(),
      profileManager: makeProfileManager({
        profilesUsing: () => [asProfileId('p1'), asProfileId('p2')],
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
      }),
      indicatorComputer: { recompute: vi.fn() },
      logger: noopLogger,
    });
    await router.onResync('BTCUSDT');
    expect(tickQueue.add).toHaveBeenCalledTimes(2);
    expect(tickQueue.add).toHaveBeenNthCalledWith(
      1,
      'tick',
      expect.objectContaining({ event: 'resync' }),
      expect.any(Object),
    );
  });

  it('user-stream reconnect backfills fills per symbol BEFORE enqueuing the resync tick', async () => {
    const order: string[] = [];
    const tickQueue = makeQueue();
    (tickQueue.add as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('enqueue');
      return { id: 'x' };
    });
    const backfillFills = vi.fn(async () => {
      order.push('backfill');
    });
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue,
      redis: makeRedis(),
      profileManager: makeProfileManager({
        symbolsFor: () => ['BTCUSDT'],
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
      }),
      indicatorComputer: { recompute: vi.fn() },
      backfillFills,
      logger: noopLogger,
    });
    await router.onProfileResync(asUserId('u1'), asProfileId('p1'));
    expect(backfillFills).toHaveBeenCalledWith(
      asUserId('u1'),
      asAccountId('a1'),
      asProfileId('p1'),
      'BTCUSDT',
    );
    expect(order).toEqual(['backfill', 'enqueue']);
  });

  it('still enqueues the resync tick when the fill backfill throws', async () => {
    const tickQueue = makeQueue();
    const backfillFills = vi.fn(async () => {
      throw new Error('binance down');
    });
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue,
      redis: makeRedis(),
      profileManager: makeProfileManager({
        symbolsFor: () => ['BTCUSDT'],
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
      }),
      indicatorComputer: { recompute: vi.fn() },
      backfillFills,
      logger: noopLogger,
    });
    await router.onProfileResync(asUserId('u1'), asProfileId('p1'));
    expect(tickQueue.add).toHaveBeenCalledWith(
      'tick',
      expect.objectContaining({ event: 'resync', symbol: 'BTCUSDT' }),
      expect.any(Object),
    );
  });

  // ---------------------------------------------------------------------------
  // Issue #649 C1 — WS-merge of the open-orders cache (RED until Phase B).
  // Today every execution report DELs the whole open-orders key, forcing the
  // next tick to cold-load from REST. These assert the new behaviour: a
  // terminal report REMOVES just that order in place, a partial fill PATCHes it,
  // and neither DELs the key nor fabricates an entry. The key suffix
  // (`open-orders:BTCUSDT`) is matched so the test is agnostic to the Phase-B
  // account-domain key collapse (that grammar is pinned in redis-namespace.test).
  // ---------------------------------------------------------------------------

  const OPEN_ORDERS_SUFFIX = /open-orders:BTCUSDT$/;

  it('terminal executionReport REMOVES the order in place and does NOT DEL the key (E1)', async () => {
    const redis = makeRedisWithEval();
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue: makeQueue(),
      redis,
      profileManager: makeProfileManager({
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
        symbolsFor: () => ['BTCUSDT'],
      }),
      indicatorComputer: { recompute: vi.fn() },
      logger: noopLogger,
    });
    await router.onUserEvent({
      kind: 'execution-report',
      userId: asUserId('u1'),
      profileId: asProfileId('p1'),
      symbol: 'BTCUSDT',
      orderId: 1,
      clientOrderId: 'v1-x',
      orderStatus: 'FILLED',
      side: 'BUY',
      executionType: 'TRADE',
      priceLastFilled: '0',
      qtyLastFilled: '0',
      cumQty: '1',
      cumQuoteQty: '50',
      eventTimeMs: 0,
    });
    // Remove-by-orderId via the atomic Lua, TTL refreshed (last ARGV).
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringMatching(OPEN_ORDERS_SUFFIX),
      'remove',
      '1',
      expect.anything(),
    );
    // The whole-key DEL (today's behaviour) must be gone.
    expect(firstArgs(redis.del).some((k) => OPEN_ORDERS_SUFFIX.test(k))).toBe(false);
  });

  it('PARTIALLY_FILLED PATCHes executedQty/cumQuote/status in place, not DEL (E2)', async () => {
    const redis = makeRedisWithEval();
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue: makeQueue(),
      redis,
      profileManager: makeProfileManager({
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
        symbolsFor: () => ['BTCUSDT'],
      }),
      indicatorComputer: { recompute: vi.fn() },
      logger: noopLogger,
    });
    await router.onUserEvent({
      kind: 'execution-report',
      userId: asUserId('u1'),
      profileId: asProfileId('p1'),
      symbol: 'BTCUSDT',
      orderId: 7,
      clientOrderId: 'v1-x',
      orderStatus: 'PARTIALLY_FILLED',
      side: 'BUY',
      executionType: 'TRADE',
      priceLastFilled: '0',
      qtyLastFilled: '0',
      cumQty: '0.4',
      cumQuoteQty: '20',
      eventTimeMs: 0,
    });
    // patch: orderId, executedQty←cumQty, cumQuote←cumQuoteQty, status, ttl.
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringMatching(OPEN_ORDERS_SUFFIX),
      'patch',
      '7',
      '0.4',
      '20',
      'PARTIALLY_FILLED',
      expect.anything(),
    );
    expect(firstArgs(redis.del).some((k) => OPEN_ORDERS_SUFFIX.test(k))).toBe(false);
  });

  it('PARTIALLY_FILLED issues the patch but never fabricates an insert or DEL (E5)', async () => {
    // The router always issues the patch op; whether a MISSING key stays absent
    // (no cold-load fabricated here) is the Lua's job, covered by the Phase-B
    // GET→patch→SET Lua unit test. At the router seam the observable contract is:
    // it neither writes the open-orders key with a plain SET nor DELs it.
    const redis = makeRedisWithEval();
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue: makeQueue(),
      redis,
      profileManager: makeProfileManager({
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
        symbolsFor: () => ['BTCUSDT'],
      }),
      indicatorComputer: { recompute: vi.fn() },
      logger: noopLogger,
    });
    await router.onUserEvent({
      kind: 'execution-report',
      userId: asUserId('u1'),
      profileId: asProfileId('p1'),
      symbol: 'BTCUSDT',
      orderId: 9,
      clientOrderId: 'v1-x',
      orderStatus: 'PARTIALLY_FILLED',
      side: 'BUY',
      executionType: 'TRADE',
      priceLastFilled: '0',
      qtyLastFilled: '0',
      cumQty: '0.4',
      cumQuoteQty: '20',
      eventTimeMs: 0,
    });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringMatching(OPEN_ORDERS_SUFFIX),
      'patch',
      '9',
      expect.anything(),
      expect.anything(),
      'PARTIALLY_FILLED',
      expect.anything(),
    );
    // No fabricated write of the open-orders key (the liveness SET is a different
    // key), and no whole-key DEL.
    expect(firstArgs(redis.set).some((k) => OPEN_ORDERS_SUFFIX.test(k))).toBe(false);
    expect(firstArgs(redis.del).some((k) => OPEN_ORDERS_SUFFIX.test(k))).toBe(false);
  });

  it('onProfileResync DELs the (account,symbol) open-orders key so the reconnect cold-loads once (E6)', async () => {
    const redis = makeRedisWithEval();
    const router = createEventRouter({
      ...moneyDeps(),
      tickQueue: makeQueue(),
      redis,
      profileManager: makeProfileManager({
        symbolsFor: () => ['BTCUSDT', 'ETHUSDT'],
        operatorOf: () => asUserId('u1'),
        accountOf: () => asAccountId('a1'),
      }),
      indicatorComputer: { recompute: vi.fn() },
      logger: noopLogger,
    });
    await router.onProfileResync(asUserId('u1'), asProfileId('p1'));
    // One DEL per owned symbol; today onProfileResync touches no open-orders key.
    expect(redis.del).toHaveBeenCalledWith(expect.stringMatching(/open-orders:BTCUSDT$/));
    expect(redis.del).toHaveBeenCalledWith(expect.stringMatching(/open-orders:ETHUSDT$/));
  });
});
