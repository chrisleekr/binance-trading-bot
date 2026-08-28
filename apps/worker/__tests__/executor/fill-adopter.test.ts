// Fill-adopter contract tests.
//
// Drive the adopter against a hoisted-mock `profileRepo` + an
// in-memory Redis stub so every state mutation can be asserted
// deterministically. Covers:
//   - BUY fill seeds LBP + qty when no row exists; weighted-averages
//     when one does
//   - SELL fill emptying the held position clears LBP row + state
//   - Partial SELL reduces quantity, leaves LBP and grid index intact
//   - Idempotency on (orderId, tradeId)
//   - Non-FILLED events skip
//   - Zero orderId / tradeId refused
//   - Concurrent BUYs on different symbols of the same profile do not
//     clobber each other (#275 acceptance)

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { SiblingQuoteConflictError, SymbolOwnershipConflictError } from '@app/db';

import { trailingTradePositionAdapter } from '@app/strategy-trailing-trade';

import { createFillAdopter } from '../../src/executor/fill-adopter.js';
import { createChainByKey } from '../../src/lib/chain-by-key.js';
import { createStatePort } from '../../src/state/state-port.js';
import { buildSymbolStateKey } from '../../src/executor/redis-namespace.js';

const repoMocks = vi.hoisted(() => ({
  avgEntryPricesFindBySymbol: vi.fn(),
  avgEntryPricesUpsert: vi.fn(),
  conditionRecordCondition: vi.fn(async () => ({ changed: false, sinceMs: null })),
  avgEntryPricesRemove: vi.fn(),
  appliedFillsTryRecord: vi.fn(),
  profileFindById: vi.fn(),
  symbolStatesFindBySymbol: vi.fn(),
  persistSymbolState: vi.fn(),
  profileSymbolsFindForSymbol: vi.fn(),
  profileSymbolsUpsert: vi.fn(),
  actionLogsAppend: vi.fn(),
  ordersMarkFilled: vi.fn(),
  ordersStampBaseCommissionNetted: vi.fn(),
  ordersStampRealizedPnl: vi.fn(),
  ordersFindByBinanceOrderId: vi.fn(),
  manualOrdersFindByBinanceOrderId: vi.fn(),
}));

const testRepo = {
  scope: {
    db: undefined as unknown,
    operatorId: undefined as unknown,
    accountId: undefined as unknown,
    profileId: undefined as unknown,
  },
  avgEntryPrices: {
    findBySymbol: repoMocks.avgEntryPricesFindBySymbol,
    upsert: repoMocks.avgEntryPricesUpsert,
    remove: repoMocks.avgEntryPricesRemove,
  },
  // A buy fill proves the coin is really held, so the adopter closes any open seed refusal on it.
  conditionStates: { recordCondition: repoMocks.conditionRecordCondition },
  appliedFills: {
    tryRecord: repoMocks.appliedFillsTryRecord,
  },
  profile: {
    findById: repoMocks.profileFindById,
  },
  symbolStates: {
    findBySymbol: repoMocks.symbolStatesFindBySymbol,
  },
  profileSymbols: {
    findForSymbol: repoMocks.profileSymbolsFindForSymbol,
    upsert: repoMocks.profileSymbolsUpsert,
  },
  actionLogs: {
    append: repoMocks.actionLogsAppend,
  },
  orders: {
    markFilledByBinanceOrderId: repoMocks.ordersMarkFilled,
    stampBaseCommissionNetted: repoMocks.ordersStampBaseCommissionNetted,
    stampRealizedPnl: repoMocks.ordersStampRealizedPnl,
    findByBinanceOrderId: repoMocks.ordersFindByBinanceOrderId,
  },
  manualOrders: {
    findByBinanceOrderId: repoMocks.manualOrdersFindByBinanceOrderId,
  },
};

vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return {
    ...orig,
    // Order reconciliation is account-domain now, so the adopter widens its proven
    // profile scope. Collapse both helpers onto the same hoisted mocks.
    toAccountScope: vi.fn((scope: unknown) => scope),
    accountRepoFromScope: vi.fn(() => testRepo),
    profileRepo: vi.fn(async () => testRepo),
    // The tx-scoped surface in production routes through these two
    // helpers; in tests collapse both to identity so the in-tx writes
    // still hit the same hoisted mocks as the post-tx state mutation.
    profileRepoFromScope: vi.fn(() => testRepo),
    withTx: vi.fn((scope: unknown) => scope),
  };
});

interface LogEntry {
  readonly level: string;
  readonly msg: string;
}

// Recording logger: a stepSize-lookup failure must SURFACE the un-flattenable
// residual, so the log line is an assertable contract, not noise.
const makeRecordingLogger = (): { logger: Logger; entries: LogEntry[] } => {
  const entries: LogEntry[] = [];
  const at =
    (level: string) =>
    (_obj: unknown, msg?: unknown): void => {
      entries.push({ level, msg: String(msg ?? '') });
    };
  const logger = {
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: () => logger,
  } as unknown as Logger;
  return { logger, entries };
};

const USER_ID = asUserId('00000000-0000-0000-0000-000000000001');
const ACCOUNT_ID = asAccountId('00000000-0000-0000-0000-000000000003');
const PROFILE_ID = asProfileId('00000000-0000-0000-0000-000000000002');
const SYMBOL = 'BTCUSDT';

interface RedisStub {
  redis: Redis;
  store: Map<string, unknown>;
}

const makeRedisStub = (): RedisStub => {
  const store = new Map<string, unknown>();
  const redis = {
    get: vi.fn(async (key: string) => {
      const v = store.get(key);
      return typeof v === 'string' ? v : null;
    }),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      const had = store.delete(key) ? 1 : 0;
      return had;
    }),
  } as unknown as Redis;
  return { redis, store };
};

const makeAdopter = (
  stepSize = '0.00000001',
  stepSizeThrows = false,
  notifyEvent?: Parameters<typeof createFillAdopter>[0]['notifyEvent'],
  // Defaults to '0', which disarms the NOTIONAL bound so every pre-existing case keeps its old meaning. A stub WITHOUT this field is worse than a wrong value: the adopter's Decimal parse would fail and silently push every SELL in the suite down the symbol-info-failure path.
  minNotional = '0',
) => {
  const { redis, store } = makeRedisStub();
  const { logger, entries: logs } = makeRecordingLogger();
  // Phase A RED: the clear-SELL branch must enqueue the existing
  // archive-grid-trade pipeline job. Fake the queue so the call is asserted.
  const pipelineQueue = { add: vi.fn() };
  // Production wires the adopter through `mutateSymbolState`, which
  // routes the durable write through the atomic two-column persister
  // for `symbol_states`. Stub it so the test asserts against
  // `persistSymbolState` calls + the per-symbol Redis cache the helper
  // writes.
  const persistSymbolState = vi.fn(
    async (
      _scope: unknown,
      sym: string,
      next: unknown,
      _v: string,
      _expectedVersion: number | null,
    ): Promise<boolean> => {
      store.set(buildSymbolStateKey(ACCOUNT_ID, PROFILE_ID, sym), JSON.stringify(next));
      repoMocks.persistSymbolState(sym, next);
      return true;
    },
  );
  const registry = {
    get: vi.fn(() => ({
      name: 'trailing-trade',
      version: '2.0.0',
      initialState: (_cfg: unknown) => ({ schemaVersion: '2.0.0' }),
      migrateState: vi.fn(),
      position: trailingTradePositionAdapter,
    })),
  };
  // The adopter wraps the in-tx LBP+ledger writes in db.transaction —
  // tests do not need a real PG tx, so route the callback straight
  // through with a fake tx handle the mocks ignore.
  const fakeDb = {
    transaction: vi.fn(async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb({})),
  } as unknown as Parameters<typeof createFillAdopter>[0]['db'];
  const statePort = createStatePort({
    redis,
    logger,
    registry,
    // The adopter only uses the scope-based `mutate` path, which never
    // touches cold-load; supply a stub that throws if it is unexpectedly
    // exercised (the tick read path is the only `coldLoad` caller).
    coldLoad: {
      loadSymbolState: vi.fn(async () => {
        throw new Error('fill-adopter test: coldLoad.loadSymbolState should not be called');
      }),
    } as unknown as Parameters<typeof createStatePort>[0]['coldLoad'],
    persistSymbolState,
  });
  const adopter = createFillAdopter({
    db: fakeDb,
    chain: createChainByKey(),
    logger,
    statePort,
    registry,
    pipelineQueue: pipelineQueue as unknown as Parameters<
      typeof createFillAdopter
    >[0]['pipelineQueue'],
    // Stub the symbol-info cache so a SELL fill can resolve LOT_SIZE stepSize.
    // Default is dust-small so existing SELL residuals never trip the flatten;
    // the dedicated sub-step test passes a larger value. `stepSizeThrows`
    // simulates a delisted-symbol lookup failure so the degrade path is tested.
    symbolInfo: {
      get: vi.fn(async () => {
        if (stepSizeThrows) throw new Error('symbol-info-cache: delisted');
        return { baseAsset: 'BTC', filters: { stepSize, minNotional } };
      }),
    } as unknown as Parameters<typeof createFillAdopter>[0]['symbolInfo'],
    ...(notifyEvent ? { notifyEvent } : {}),
  });
  return { adopter, redis, store, persistSymbolState, registry, pipelineQueue, logs };
};

const defaultProfile = () => ({
  strategyName: 'trailing-trade',
  config: {},
});

const defaultSymbolRow = (state: unknown = { schemaVersion: '2.0.0' }, version = 0) => ({
  profileId: PROFILE_ID,
  symbol: SYMBOL,
  state,
  strategyVersion: '2.0.0',
  version,
});

const reset = (): void => {
  testRepo.scope = {
    db: {},
    operatorId: USER_ID,
    accountId: ACCOUNT_ID,
    profileId: PROFILE_ID,
  };
  repoMocks.avgEntryPricesFindBySymbol.mockReset();
  repoMocks.avgEntryPricesUpsert.mockReset();
  repoMocks.avgEntryPricesRemove.mockReset();
  repoMocks.appliedFillsTryRecord.mockReset();
  repoMocks.profileFindById.mockReset();
  repoMocks.symbolStatesFindBySymbol.mockReset();
  repoMocks.persistSymbolState.mockReset();
  repoMocks.profileSymbolsFindForSymbol.mockReset();
  repoMocks.profileSymbolsUpsert.mockReset();
  repoMocks.actionLogsAppend.mockReset();
  repoMocks.ordersMarkFilled.mockReset();
  // Default: one orders row reconciled to FILLED per fill.
  repoMocks.ordersMarkFilled.mockResolvedValue(1);
  repoMocks.ordersStampBaseCommissionNetted.mockReset();
  repoMocks.ordersStampBaseCommissionNetted.mockResolvedValue(1);
  repoMocks.ordersStampRealizedPnl.mockReset();
  repoMocks.ordersStampRealizedPnl.mockResolvedValue(1);
  // Origin gate default: the fill matches a local strategy order (`orders`
  // row present), so every existing test still adopts. The external-fill and
  // bot-manual tests override these.
  repoMocks.ordersFindByBinanceOrderId.mockReset();
  repoMocks.ordersFindByBinanceOrderId.mockResolvedValue({ symbol: SYMBOL, profileId: PROFILE_ID });
  repoMocks.manualOrdersFindByBinanceOrderId.mockReset();
  repoMocks.manualOrdersFindByBinanceOrderId.mockResolvedValue(null);
  // Default to first-apply for all existing tests; the replay tests
  // override this to simulate a second delivery hitting the PG dedupe
  // ledger.
  repoMocks.appliedFillsTryRecord.mockResolvedValue(true);
  repoMocks.profileFindById.mockResolvedValue(defaultProfile());
  // Default: the symbol is already subscribed, so a fill never triggers the
  // orphan re-subscribe path. The orphan tests override this to null.
  repoMocks.profileSymbolsFindForSymbol.mockResolvedValue({ symbol: SYMBOL, source: 'manual' });
  repoMocks.profileSymbolsUpsert.mockResolvedValue({ symbol: SYMBOL, source: 'manual' });
  repoMocks.actionLogsAppend.mockResolvedValue(undefined);
  // Default symbol_states row is at-version 2.0.0; tests override per
  // symbol when they care about it.
  repoMocks.symbolStatesFindBySymbol.mockResolvedValue(defaultSymbolRow());
};

const mkFill = (
  overrides: Partial<Parameters<ReturnType<typeof createFillAdopter>['adopt']>[0]> = {},
) => ({
  operatorId: USER_ID,
  accountId: ACCOUNT_ID,
  profileId: PROFILE_ID,
  symbol: SYMBOL,
  orderId: 1,
  tradeId: 1,
  orderStatus: 'FILLED',
  side: 'BUY' as const,
  cumQty: '0.001',
  cumQuoteQty: '76.66',
  ...overrides,
});

describe('createFillAdopter', () => {
  describe('BUY fills', () => {
    it('seeds avg_entry_prices when no row exists and resets highSinceBuy in TT state', async () => {
      reset();
      const { adopter, store } = makeAdopter();
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
      repoMocks.avgEntryPricesUpsert.mockResolvedValue({});
      repoMocks.symbolStatesFindBySymbol.mockResolvedValue(
        defaultSymbolRow({ schemaVersion: '2.0.0', avgEntryPrice: null, highSinceBuy: '100' }),
      );

      await adopter.adopt(mkFill());

      expect(repoMocks.avgEntryPricesUpsert).toHaveBeenCalledTimes(1);
      const upsertArgs = repoMocks.avgEntryPricesUpsert.mock.calls[0];
      expect(upsertArgs?.[0]).toBe(SYMBOL);
      expect(upsertArgs?.[1]).toEqual({
        avgEntryPrice: '76660',
        quantity: '0.001',
      });
      const stateKey = buildSymbolStateKey(ACCOUNT_ID, PROFILE_ID, SYMBOL);
      const updated = JSON.parse(String(store.get(stateKey))) as Record<string, unknown>;
      expect(updated['avgEntryPrice']).toBe('76660');
      expect(updated['highSinceBuy']).toBeNull();
      expect(updated['heldQuantity']).toBe('0.001');
    });

    it('closes a standing seed refusal, because a real fill is what falsifies it', async () => {
      // The other half of the recovery: the operator's cost basis was refused when nothing sellable backed it, then the strategy bought in. No delete happens on that path, so the refusal has no other way to close and would sit over a genuine holding for good.
      reset();
      const { adopter } = makeAdopter();
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
      repoMocks.avgEntryPricesUpsert.mockResolvedValue({});
      repoMocks.symbolStatesFindBySymbol.mockResolvedValue(
        defaultSymbolRow({ schemaVersion: '2.0.0', avgEntryPrice: null }),
      );

      await adopter.adopt(mkFill());

      expect(repoMocks.conditionRecordCondition).toHaveBeenCalledWith(
        expect.objectContaining({
          condition: 'position-seed-refused',
          symbol: SYMBOL,
          code: null,
        }),
      );
    });

    it('weighted-averages LBP with asymmetric quantities (proves the weighting, not just the mean)', async () => {
      reset();
      const { adopter } = makeAdopter();
      // 1 BTC @ 60000
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        avgEntryPrice: '60000',
        quantity: '1',
      });
      // Fill: 3 BTC @ 80000
      await adopter.adopt(mkFill({ orderId: 2, tradeId: 2, cumQty: '3', cumQuoteQty: '240000' }));

      // Weighted: (60000*1 + 80000*3) / 4 = 75000
      const upsertArgs = repoMocks.avgEntryPricesUpsert.mock.calls[0];
      expect(upsertArgs?.[1]).toEqual({
        avgEntryPrice: '75000',
        quantity: '4',
      });
    });
  });

  describe('SELL fills', () => {
    it('clears LBP row and TT position state when held quantity is consumed', async () => {
      reset();
      const { adopter, store } = makeAdopter();
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        avgEntryPrice: '60000',
        quantity: '0.001',
      });
      repoMocks.symbolStatesFindBySymbol.mockResolvedValue(
        defaultSymbolRow({
          schemaVersion: '2.0.0',
          avgEntryPrice: '60000',
          highSinceBuy: '65000',
          currentGridTradeIndex: 1,
        }),
      );

      await adopter.adopt(
        mkFill({ side: 'SELL', orderId: 3, tradeId: 3, cumQty: '0.001', cumQuoteQty: '63000' }),
      );

      expect(repoMocks.avgEntryPricesRemove).toHaveBeenCalledTimes(1);
      expect(repoMocks.avgEntryPricesUpsert).not.toHaveBeenCalled();
      const stateKey = buildSymbolStateKey(ACCOUNT_ID, PROFILE_ID, SYMBOL);
      const updated = JSON.parse(String(store.get(stateKey))) as Record<string, unknown>;
      expect(updated['avgEntryPrice']).toBeNull();
      expect(updated['highSinceBuy']).toBeNull();
      // Flat clears the grid index to null so the next entry re-fires level 0;
      // a leftover 0 wedges re-entry (grid entry needs idx === null).
      expect(updated['currentGridTradeIndex']).toBeNull();
      expect(updated['heldQuantity']).toBeNull();
    });

    it('enqueues an archive job when a SELL fill empties the position', async () => {
      reset();
      const { adopter, pipelineQueue } = makeAdopter();
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        avgEntryPrice: '60000',
        quantity: '0.001',
      });
      repoMocks.symbolStatesFindBySymbol.mockResolvedValue(
        defaultSymbolRow({
          schemaVersion: '2.0.0',
          avgEntryPrice: '60000',
          highSinceBuy: '65000',
          currentGridTradeIndex: 1,
        }),
      );

      await adopter.adopt(
        mkFill({ side: 'SELL', orderId: 7, tradeId: 7, cumQty: '0.001', cumQuoteQty: '63000' }),
      );

      expect(pipelineQueue.add).toHaveBeenCalledTimes(1);
      expect(pipelineQueue.add).toHaveBeenCalledWith(
        'archive-grid-trade',
        expect.objectContaining({
          symbol: SYMBOL,
          profileId: PROFILE_ID,
          userId: USER_ID,
          accountId: ACCOUNT_ID,
        }),
        expect.objectContaining({ jobId: expect.stringMatching(/^archive-grid:/) }),
      );
    });

    it('swallows a pipelineQueue enqueue failure (fill already applied)', async () => {
      reset();
      const { adopter, pipelineQueue } = makeAdopter();
      pipelineQueue.add.mockRejectedValueOnce(new Error('redis down'));
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        avgEntryPrice: '60000',
        quantity: '0.001',
      });
      repoMocks.symbolStatesFindBySymbol.mockResolvedValue(
        defaultSymbolRow({ schemaVersion: '2.0.0', avgEntryPrice: '60000', highSinceBuy: '65000' }),
      );

      // The enqueue throws, but adopt() must resolve (fill is committed).
      await expect(
        adopter.adopt(
          mkFill({ side: 'SELL', orderId: 8, tradeId: 8, cumQty: '0.001', cumQuoteQty: '63000' }),
        ),
      ).resolves.toBeUndefined();
      expect(pipelineQueue.add).toHaveBeenCalledTimes(1);
      // The clearing state write still landed.
      expect(repoMocks.avgEntryPricesRemove).toHaveBeenCalledTimes(1);
    });

    it('does not enqueue an archive job on a BUY fill', async () => {
      reset();
      const { adopter, pipelineQueue } = makeAdopter();
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
      repoMocks.symbolStatesFindBySymbol.mockResolvedValue(
        defaultSymbolRow({ schemaVersion: '2.0.0', avgEntryPrice: null, highSinceBuy: '100' }),
      );

      await adopter.adopt(mkFill());

      expect(pipelineQueue.add).not.toHaveBeenCalled();
    });

    it('does not enqueue an archive job on a partial SELL (position not emptied)', async () => {
      reset();
      const { adopter, pipelineQueue } = makeAdopter();
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        avgEntryPrice: '60000',
        quantity: '0.005',
      });
      repoMocks.symbolStatesFindBySymbol.mockResolvedValue(
        defaultSymbolRow({ schemaVersion: '2.0.0', avgEntryPrice: '60000', highSinceBuy: '65000' }),
      );

      await adopter.adopt(
        mkFill({ side: 'SELL', orderId: 9, tradeId: 9, cumQty: '0.001', cumQuoteQty: '63000' }),
      );

      expect(pipelineQueue.add).not.toHaveBeenCalled();
    });

    it('flattens a residual that clears the step but is worth less than minNotional (ENAUSDT filters)', async () => {
      reset();
      // ENAUSDT's real filters, on a residual constructed to land between them: a fee-net 420.88184 ENA held, the protective stop sells 420.87 at ~0.1094, leaving 0.01184 against a 0.01 step and a 5 USDT floor. 1.18 steps wide so the step test passes it, worth 0.0013 USDT so no sell of it can ever be placed. The live exit did NOT leave this behind — it emptied its position and the cycle archived — so this covers a residual of that shape rather than the observed strand.
      const { adopter, store, pipelineQueue, logs } = makeAdopter('0.01', false, undefined, '5');
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        avgEntryPrice: '0.0984',
        quantity: '420.88184',
      });
      repoMocks.symbolStatesFindBySymbol.mockResolvedValue(
        defaultSymbolRow({ schemaVersion: '2.0.0', avgEntryPrice: '0.0984' }),
      );

      await adopter.adopt(
        mkFill({
          side: 'SELL',
          orderId: 41,
          tradeId: 41,
          cumQty: '420.87',
          cumQuoteQty: '46.0432',
        }),
      );

      expect(repoMocks.avgEntryPricesRemove).toHaveBeenCalledTimes(1);
      expect(repoMocks.avgEntryPricesUpsert).not.toHaveBeenCalled();
      const updated = JSON.parse(
        String(store.get(buildSymbolStateKey(ACCOUNT_ID, PROFILE_ID, SYMBOL))),
      ) as Record<string, unknown>;
      expect(updated['heldQuantity']).toBeNull();
      expect(pipelineQueue.add).toHaveBeenCalledTimes(1);
      // The LOT_SIZE lookup succeeded, so the operator must NOT see the unverified-position alert.
      expect(logs.filter((l) => String(l.msg).includes('symbol-info lookup failed'))).toHaveLength(
        0,
      );
    });

    it('drops a zero-cumQty SELL report before it can touch a live position', async () => {
      reset();
      // The guard at the top of `adopt` returns on a non-positive cumQty/cumQuoteQty, so this never reaches `resolveSell` and the VWAP is never computed. That is what makes the notional bound's `price.gt(0)` skip unreachable FROM THIS CALLER, and it is the property worth pinning: a degenerate report must leave the position exactly as it found it, not merely decline to flatten it.
      const { adopter, pipelineQueue, persistSymbolState } = makeAdopter(
        '0.01',
        false,
        undefined,
        '5',
      );
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        avgEntryPrice: '0.0984',
        quantity: '420.88184',
      });
      repoMocks.symbolStatesFindBySymbol.mockResolvedValue(
        defaultSymbolRow({ schemaVersion: '2.0.0', avgEntryPrice: '0.0984' }),
      );

      await adopter.adopt(
        mkFill({ side: 'SELL', orderId: 42, tradeId: 42, cumQty: '0', cumQuoteQty: '0' }),
      );

      expect(repoMocks.avgEntryPricesRemove).not.toHaveBeenCalled();
      // No read, no write, no archive: the early return fires before any of them.
      expect(repoMocks.avgEntryPricesFindBySymbol).not.toHaveBeenCalled();
      expect(repoMocks.avgEntryPricesUpsert).not.toHaveBeenCalled();
      expect(persistSymbolState).not.toHaveBeenCalled();
      expect(repoMocks.appliedFillsTryRecord).not.toHaveBeenCalled();
      expect(pipelineQueue.add).not.toHaveBeenCalled();
    });

    it('flattens the position when the SELL residual is below one LOT_SIZE step (fee dust)', async () => {
      reset();
      // Held GROSS qty 0.001; the full exit sells 0.00099 (a base-asset fee
      // crumb short). The 0.00001 residual is below the 0.0001 stepSize, so it
      // is unsellable — the position must clear, not linger and block re-entry.
      const { adopter, store, pipelineQueue } = makeAdopter('0.0001');
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        avgEntryPrice: '60000',
        quantity: '0.001',
      });
      repoMocks.symbolStatesFindBySymbol.mockResolvedValue(
        defaultSymbolRow({
          schemaVersion: '2.0.0',
          avgEntryPrice: '60000',
          highSinceBuy: '65000',
          currentGridTradeIndex: 1,
        }),
      );

      await adopter.adopt(
        mkFill({ side: 'SELL', orderId: 31, tradeId: 31, cumQty: '0.00099', cumQuoteQty: '62370' }),
      );

      // Residual 0.00001 < step 0.0001 ⇒ flatten: LBP row removed, never reduced.
      expect(repoMocks.avgEntryPricesRemove).toHaveBeenCalledTimes(1);
      expect(repoMocks.avgEntryPricesUpsert).not.toHaveBeenCalled();
      const stateKey = buildSymbolStateKey(ACCOUNT_ID, PROFILE_ID, SYMBOL);
      const updated = JSON.parse(String(store.get(stateKey))) as Record<string, unknown>;
      expect(updated['avgEntryPrice']).toBeNull();
      expect(updated['heldQuantity']).toBeNull();
      // A full exit archives the closed cycle.
      expect(pipelineQueue.add).toHaveBeenCalledTimes(1);
    });

    it('degrades to the no-flatten behavior when the stepSize lookup fails, and surfaces the strand', async () => {
      reset();
      // symbolInfo.get throws (delisted). sellStepSize falls back to undefined,
      // so resolveFill uses the historical exact-zero residual rule: a sub-step
      // residual is NOT flattened — the fill still completes (never blocked).
      // The residual is unverifiable, not proven real, so it must be surfaced
      // rather than left as a silent phantom position that blocks re-entry.
      const { adopter, logs } = makeAdopter('0.0001', true);
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        avgEntryPrice: '60000',
        quantity: '0.001',
      });
      repoMocks.symbolStatesFindBySymbol.mockResolvedValue(
        defaultSymbolRow({ schemaVersion: '2.0.0', avgEntryPrice: '60000', highSinceBuy: '65000' }),
      );

      await expect(
        adopter.adopt(
          mkFill({
            side: 'SELL',
            orderId: 33,
            tradeId: 33,
            cumQty: '0.00099',
            cumQuoteQty: '62370',
          }),
        ),
      ).resolves.toBeUndefined();

      // Residual 0.00001 would flatten WITH stepSize, but the lookup failed ⇒
      // legacy behavior: reduce, not remove.
      expect(repoMocks.avgEntryPricesRemove).not.toHaveBeenCalled();
      expect(repoMocks.avgEntryPricesUpsert).toHaveBeenCalledWith(SYMBOL, {
        avgEntryPrice: '60000',
        quantity: '0.00001',
      });
      // Not silent: an operator-visible activity row plus an error-level log
      // naming the residual, so a stranded position is diagnosable.
      const msgs = repoMocks.actionLogsAppend.mock.calls.map((c) => (c[0] as { msg: string }).msg);
      expect(msgs).toContain(
        `Could not confirm ${SYMBOL} was fully sold: 0.00001 still tracked, and the exchange's trading rules were unavailable to check whether that amount is too small to sell`,
      );
      expect(
        logs.filter((l) => l.level === 'error' && l.msg.includes('could not be checked against')),
      ).toHaveLength(1);
    });

    it('does not repeat the strand row when Binance replays the terminal report', async () => {
      reset();
      // Same strand as above, but a replay: `resolveSell` still reports `set`,
      // so an ungated write would hand the operator a second row for one strand
      // and imply a second incident.
      repoMocks.appliedFillsTryRecord.mockResolvedValue(false);
      const { adopter, logs, store } = makeAdopter('0.0001', true);
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        avgEntryPrice: '60000',
        quantity: '0.001',
      });
      repoMocks.symbolStatesFindBySymbol.mockResolvedValue(
        defaultSymbolRow({ schemaVersion: '2.0.0', avgEntryPrice: '60000', highSinceBuy: '65000' }),
      );

      await adopter.adopt(
        mkFill({ side: 'SELL', orderId: 33, tradeId: 33, cumQty: '0.00099', cumQuoteQty: '62370' }),
      );

      // The replay still converges state off the persisted LBP, which is what
      // makes the resolution a `set` — the premise the silence below depends on.
      // Without it the two empty assertions would also pass on a fill that never
      // reached the strand gate at all.
      const updated = JSON.parse(
        String(store.get(buildSymbolStateKey(ACCOUNT_ID, PROFILE_ID, SYMBOL))),
      ) as Record<string, unknown>;
      expect(updated['avgEntryPrice']).toBe('60000');

      const msgs = repoMocks.actionLogsAppend.mock.calls.map((c) => (c[0] as { msg: string }).msg);
      expect(msgs.filter((m) => m.includes('Could not confirm'))).toHaveLength(0);
      expect(
        logs.filter((l) => l.level === 'error' && l.msg.includes('could not be checked against')),
      ).toHaveLength(0);
    });

    it('keeps the position when the SELL residual is at or above one LOT_SIZE step', async () => {
      reset();
      // Residual 0.0002 >= step 0.0001 ⇒ a real partial: reduce, do not flatten.
      const { adopter } = makeAdopter('0.0001');
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        avgEntryPrice: '60000',
        quantity: '0.001',
      });
      repoMocks.symbolStatesFindBySymbol.mockResolvedValue(
        defaultSymbolRow({ schemaVersion: '2.0.0', avgEntryPrice: '60000', highSinceBuy: '65000' }),
      );

      await adopter.adopt(
        mkFill({ side: 'SELL', orderId: 32, tradeId: 32, cumQty: '0.0008', cumQuoteQty: '50400' }),
      );

      expect(repoMocks.avgEntryPricesRemove).not.toHaveBeenCalled();
      expect(repoMocks.avgEntryPricesUpsert).toHaveBeenCalledWith(SYMBOL, {
        avgEntryPrice: '60000',
        quantity: '0.0002',
      });
    });

    it('clears stale TT position state when SELL arrives with no LBP row (replay-after-clear)', async () => {
      reset();
      const { adopter, store } = makeAdopter();
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
      repoMocks.symbolStatesFindBySymbol.mockResolvedValue(
        defaultSymbolRow({
          schemaVersion: '2.0.0',
          avgEntryPrice: '60000',
          highSinceBuy: '65000',
          currentGridTradeIndex: 1,
        }),
      );

      await adopter.adopt(
        mkFill({ side: 'SELL', orderId: 5, tradeId: 5, cumQty: '0.001', cumQuoteQty: '63000' }),
      );

      expect(repoMocks.avgEntryPricesRemove).not.toHaveBeenCalled();
      expect(repoMocks.avgEntryPricesUpsert).not.toHaveBeenCalled();
      const stateKey = buildSymbolStateKey(ACCOUNT_ID, PROFILE_ID, SYMBOL);
      const updated = JSON.parse(String(store.get(stateKey))) as Record<string, unknown>;
      expect(updated['avgEntryPrice']).toBeNull();
      expect(updated['highSinceBuy']).toBeNull();
      // Flat clears the grid index to null so re-entry can fire (see above).
      expect(updated['currentGridTradeIndex']).toBeNull();
    });

    it('reduces quantity on a partial sell, leaving LBP intact', async () => {
      reset();
      const { adopter, store } = makeAdopter();
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        avgEntryPrice: '60000',
        quantity: '0.002',
      });
      repoMocks.symbolStatesFindBySymbol.mockResolvedValue(
        defaultSymbolRow({
          schemaVersion: '2.0.0',
          avgEntryPrice: '60000',
          heldQuantity: '0.002',
          highSinceBuy: null,
        }),
      );

      await adopter.adopt(
        mkFill({ side: 'SELL', orderId: 4, tradeId: 4, cumQty: '0.001', cumQuoteQty: '63000' }),
      );

      expect(repoMocks.avgEntryPricesRemove).not.toHaveBeenCalled();
      expect(repoMocks.avgEntryPricesUpsert).toHaveBeenCalledTimes(1);
      const upsertArgs = repoMocks.avgEntryPricesUpsert.mock.calls[0];
      expect(upsertArgs?.[1]).toEqual({
        avgEntryPrice: '60000',
        quantity: '0.001',
      });
      const stateKey = buildSymbolStateKey(ACCOUNT_ID, PROFILE_ID, SYMBOL);
      const updated = JSON.parse(String(store.get(stateKey))) as Record<string, unknown>;
      expect(updated['heldQuantity']).toBe('0.001');
      expect(updated['avgEntryPrice']).toBe('60000');
    });
  });

  describe('idempotency', () => {
    it('mutates exactly once when the same fill is delivered twice', async () => {
      reset();
      const { adopter } = makeAdopter();
      // First delivery: no prior LBP row, tryRecord inserts → first-apply
      // path runs the weighted-average upsert. Second delivery: tryRecord
      // returns false (PG dedupe), the BUY replay path reads the persisted
      // LBP and skips the upsert instead of double-counting fillQty.
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValueOnce(null);
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValueOnce({
        avgEntryPrice: '76660',
        quantity: '0.001',
      });
      repoMocks.appliedFillsTryRecord.mockResolvedValueOnce(true);
      repoMocks.appliedFillsTryRecord.mockResolvedValueOnce(false);

      await adopter.adopt(mkFill());
      await adopter.adopt(mkFill());

      expect(repoMocks.avgEntryPricesUpsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('guards', () => {
    it('skips non-FILLED orderStatus', async () => {
      reset();
      const { adopter } = makeAdopter();
      await adopter.adopt(mkFill({ orderStatus: 'PARTIALLY_FILLED' }));
      expect(repoMocks.avgEntryPricesUpsert).not.toHaveBeenCalled();
      expect(repoMocks.avgEntryPricesFindBySymbol).not.toHaveBeenCalled();
    });

    it('refuses to apply a fill with zero orderId or tradeId (dedupe key would not be unique)', async () => {
      reset();
      const { adopter } = makeAdopter();
      await adopter.adopt(mkFill({ orderId: 0 }));
      await adopter.adopt(mkFill({ tradeId: 0 }));
      expect(repoMocks.avgEntryPricesUpsert).not.toHaveBeenCalled();
    });
  });

  describe('in-tx failure window (atomic LBP + ledger)', () => {
    it('rejects and does not state-converge when the LBP write throws inside the tx', async () => {
      reset();
      const { adopter, persistSymbolState } = makeAdopter();
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
      repoMocks.appliedFillsTryRecord.mockResolvedValue(true);
      repoMocks.avgEntryPricesUpsert.mockRejectedValue(new Error('lbp write boom'));

      await expect(adopter.adopt(mkFill({ orderId: 31, tradeId: 31 }))).rejects.toThrow(
        /lbp write boom/,
      );

      // State convergence was NOT reached.
      expect(persistSymbolState).not.toHaveBeenCalled();
    });
  });

  describe('replay-after-failure', () => {
    it('BUY: replay does NOT double-count fillQty after state-mutation failure', async () => {
      reset();
      const { adopter } = makeAdopter();

      // First apply: no prior LBP row, state mutation throws.
      repoMocks.appliedFillsTryRecord.mockResolvedValueOnce(true);
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValueOnce(null);
      repoMocks.avgEntryPricesUpsert.mockResolvedValueOnce({});

      // Track which call we're on so persistSymbolState fails on the
      // first apply but succeeds on the replay.
      let persistCalls = 0;
      repoMocks.persistSymbolState.mockImplementation(() => {
        persistCalls += 1;
        if (persistCalls === 1) {
          throw new Error('mutate boom');
        }
      });

      await expect(
        adopter.adopt(mkFill({ orderId: 11, tradeId: 11, cumQty: '0.001', cumQuoteQty: '60' })),
      ).rejects.toThrow(/mutate boom/);

      // First-apply LBP upsert wrote (0.001 @ 60000).
      expect(repoMocks.avgEntryPricesUpsert).toHaveBeenCalledTimes(1);
      expect(repoMocks.avgEntryPricesUpsert.mock.calls[0]?.[1]).toEqual({
        avgEntryPrice: '60000',
        quantity: '0.001',
      });

      // Replay: PG ledger says already applied; the persisted LBP row
      // now reflects the committed first-apply values.
      repoMocks.appliedFillsTryRecord.mockResolvedValueOnce(false);
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValueOnce({
        avgEntryPrice: '60000',
        quantity: '0.001',
      });

      await adopter.adopt(mkFill({ orderId: 11, tradeId: 11, cumQty: '0.001', cumQuoteQty: '60' }));

      // The replay must NOT re-upsert the LBP — that's the bug. The
      // weighted-average recompute would have produced quantity=0.002.
      expect(repoMocks.avgEntryPricesUpsert).toHaveBeenCalledTimes(1);
      expect(persistCalls).toBe(2);
    });

    it('SELL partial: replay does NOT re-subtract soldQty after state-mutation failure', async () => {
      reset();
      const { adopter } = makeAdopter();

      // First apply.
      repoMocks.appliedFillsTryRecord.mockResolvedValueOnce(true);
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValueOnce({
        avgEntryPrice: '60000',
        quantity: '0.002',
      });
      repoMocks.avgEntryPricesUpsert.mockResolvedValueOnce({});

      let persistCalls = 0;
      repoMocks.persistSymbolState.mockImplementation(() => {
        persistCalls += 1;
        if (persistCalls === 1) {
          throw new Error('mutate boom');
        }
      });

      await expect(
        adopter.adopt(
          mkFill({ side: 'SELL', orderId: 21, tradeId: 21, cumQty: '0.001', cumQuoteQty: '63' }),
        ),
      ).rejects.toThrow(/mutate boom/);

      expect(repoMocks.avgEntryPricesUpsert).toHaveBeenCalledTimes(1);
      expect(repoMocks.avgEntryPricesUpsert.mock.calls[0]?.[1]).toEqual({
        avgEntryPrice: '60000',
        quantity: '0.001',
      });
      expect(repoMocks.avgEntryPricesRemove).not.toHaveBeenCalled();

      // Replay: ledger says applied; LBP now persistently reflects
      // the reduction.
      repoMocks.appliedFillsTryRecord.mockResolvedValueOnce(false);
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValueOnce({
        avgEntryPrice: '60000',
        quantity: '0.001',
      });

      await adopter.adopt(
        mkFill({ side: 'SELL', orderId: 21, tradeId: 21, cumQty: '0.001', cumQuoteQty: '63' }),
      );

      expect(repoMocks.avgEntryPricesUpsert).toHaveBeenCalledTimes(1);
      expect(repoMocks.avgEntryPricesRemove).not.toHaveBeenCalled();
      expect(persistCalls).toBe(2);
    });
  });

  describe('per-symbol isolation (#275)', () => {
    it('concurrent BUYs on two different symbols of the same profile mutate disjoint slices', async () => {
      reset();
      const { adopter, store } = makeAdopter();

      // Per-symbol mocks: each symbol has its own LBP row and symbol_states row.
      const btcLbp = { avgEntryPrice: '50000', quantity: '0.5' };
      const ethLbp = { avgEntryPrice: '2000', quantity: '5' };
      repoMocks.avgEntryPricesFindBySymbol.mockImplementation(async (sym: string) =>
        sym === 'BTCUSDT' ? btcLbp : sym === 'ETHUSDT' ? ethLbp : null,
      );
      repoMocks.avgEntryPricesUpsert.mockResolvedValue({});
      repoMocks.symbolStatesFindBySymbol.mockImplementation(async (sym: string) => ({
        profileId: PROFILE_ID,
        symbol: sym,
        state: { schemaVersion: '2.0.0', avgEntryPrice: sym === 'BTCUSDT' ? '50000' : '2000' },
        strategyVersion: '2.0.0',
      }));

      // Fire two BUYs concurrently on different symbols.
      await Promise.all([
        adopter.adopt(
          mkFill({
            symbol: 'BTCUSDT',
            orderId: 101,
            tradeId: 101,
            cumQty: '0.5',
            cumQuoteQty: '35000',
          }),
        ),
        adopter.adopt(
          mkFill({
            symbol: 'ETHUSDT',
            orderId: 102,
            tradeId: 102,
            cumQty: '5',
            cumQuoteQty: '15000',
          }),
        ),
      ]);

      // Each symbol's LBP row got its own upsert; no cross-write.
      expect(repoMocks.avgEntryPricesUpsert).toHaveBeenCalledTimes(2);
      const upsertsBySymbol = new Map(
        repoMocks.avgEntryPricesUpsert.mock.calls.map((c) => [c[0] as string, c[1]]),
      );
      // BTC weighted: (50000*0.5 + 70000*0.5) / 1 = 60000
      expect(upsertsBySymbol.get('BTCUSDT')).toEqual({ avgEntryPrice: '60000', quantity: '1' });
      // ETH weighted: (2000*5 + 3000*5) / 10 = 2500
      expect(upsertsBySymbol.get('ETHUSDT')).toEqual({ avgEntryPrice: '2500', quantity: '10' });

      // Per-symbol Redis keys carry per-symbol bodies — no clobber.
      const btcStateKey = buildSymbolStateKey(ACCOUNT_ID, PROFILE_ID, 'BTCUSDT');
      const ethStateKey = buildSymbolStateKey(ACCOUNT_ID, PROFILE_ID, 'ETHUSDT');
      const btcState = JSON.parse(String(store.get(btcStateKey))) as Record<string, unknown>;
      const ethState = JSON.parse(String(store.get(ethStateKey))) as Record<string, unknown>;
      expect(btcState['avgEntryPrice']).toBe('60000');
      expect(btcState['heldQuantity']).toBe('1');
      expect(ethState['avgEntryPrice']).toBe('2500');
      expect(ethState['heldQuantity']).toBe('10');

      // persistSymbolState called once per symbol with the correct symbol arg.
      expect(repoMocks.persistSymbolState).toHaveBeenCalledTimes(2);
      const persistedSymbols = repoMocks.persistSymbolState.mock.calls.map((c) => c[0]);
      expect(new Set(persistedSymbols)).toEqual(new Set(['BTCUSDT', 'ETHUSDT']));
    });
  });

  describe('orphan recovery + activity logging', () => {
    it('re-subscribes a symbol whose buy fill lands while unsubscribed, UNPINNED and provenance unknown', async () => {
      reset();
      const { adopter } = makeAdopter();
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
      repoMocks.avgEntryPricesUpsert.mockResolvedValue({});
      // No profile_symbols row: the symbol was reaped/deleted before the fill
      // was adopted (the WLDUSDT orphan scenario).
      repoMocks.profileSymbolsFindForSymbol.mockResolvedValue(null);

      await adopter.adopt(mkFill({ side: 'BUY', cumQty: '0.001', cumQuoteQty: '50' }));

      // `unknown`, not `manual`: nobody chose this coin, the bot rescued a position on it. And UNPINNED, so discovery reaps it once the position closes instead of it holding a rotation slot forever.
      expect(repoMocks.profileSymbolsUpsert).toHaveBeenCalledWith(SYMBOL, 'BTC', {
        source: 'unknown',
        pinned: false,
      });
      // Operator-visible recovery line on the activity feed, which has to say the coin is not pinned or the operator reads the recovery as a decision the bot made to keep it.
      const msgs = repoMocks.actionLogsAppend.mock.calls.map((c) => (c[0] as { msg: string }).msg);
      expect(msgs).toContain(
        `Re-subscribed ${SYMBOL}: the bot found a position it was not tracking and is managing it again. It did not pin the coin, so once the position is closed auto-discovery may rotate it out.`,
      );
    });

    it('keeps the applied fill but logs a conflict when a sibling profile owns the symbol', async () => {
      reset();
      const { adopter } = makeAdopter();
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
      repoMocks.avgEntryPricesUpsert.mockResolvedValue({});
      // Orphaned (not bound), and re-subscribe is refused because a sibling
      // profile on the same account already manages the symbol.
      repoMocks.profileSymbolsFindForSymbol.mockResolvedValue(null);
      repoMocks.profileSymbolsUpsert.mockRejectedValue(
        new SymbolOwnershipConflictError(SYMBOL, 'sibling-profile-id', 'Sibling'),
      );

      // Must NOT throw — the fill is already applied, re-subscribe is best-effort.
      await expect(
        adopter.adopt(mkFill({ side: 'BUY', cumQty: '0.001', cumQuoteQty: '50' })),
      ).resolves.toBeUndefined();

      const msgs = repoMocks.actionLogsAppend.mock.calls.map((c) => (c[0] as { msg: string }).msg);
      // The conflict is surfaced on the activity feed...
      expect(msgs).toContain(
        `Could not re-subscribe ${SYMBOL}: sibling profile "Sibling" conflicts with it on this account`,
      );
      // ...and the buy fill still landed (position recorded).
      expect(msgs).toContain(`Bought ${SYMBOL}`);
    });

    it('keeps the applied fill but logs a conflict when a sibling profile settles in the base', async () => {
      reset();
      const { adopter } = makeAdopter();
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
      repoMocks.avgEntryPricesUpsert.mockResolvedValue({});
      // Orphaned (not bound), and re-subscribe is refused because a sibling
      // profile on the same account settles (quotes) in the symbol's base asset.
      repoMocks.profileSymbolsFindForSymbol.mockResolvedValue(null);
      repoMocks.profileSymbolsUpsert.mockRejectedValue(
        new SiblingQuoteConflictError(SYMBOL, 'sibling-profile-id', 'Sibling'),
      );

      // Must NOT throw — the fill is already applied, re-subscribe is best-effort.
      await expect(
        adopter.adopt(mkFill({ side: 'BUY', cumQty: '0.001', cumQuoteQty: '50' })),
      ).resolves.toBeUndefined();

      const msgs = repoMocks.actionLogsAppend.mock.calls.map((c) => (c[0] as { msg: string }).msg);
      expect(msgs).toContain(
        `Could not re-subscribe ${SYMBOL}: sibling profile "Sibling" conflicts with it on this account`,
      );
      expect(msgs).toContain(`Bought ${SYMBOL}`);
    });

    it('does not re-subscribe when the symbol is already managed', async () => {
      reset();
      const { adopter } = makeAdopter();
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
      repoMocks.avgEntryPricesUpsert.mockResolvedValue({});
      // Default findForSymbol returns an existing row.

      await adopter.adopt(mkFill({ side: 'BUY', cumQty: '0.001', cumQuoteQty: '50' }));

      expect(repoMocks.profileSymbolsUpsert).not.toHaveBeenCalled();
    });

    it('writes a "Bought" activity-feed row for an adopted buy fill', async () => {
      reset();
      const { adopter } = makeAdopter();
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
      repoMocks.avgEntryPricesUpsert.mockResolvedValue({});

      await adopter.adopt(mkFill({ side: 'BUY', cumQty: '0.001', cumQuoteQty: '50' }));

      const msgs = repoMocks.actionLogsAppend.mock.calls.map((c) => (c[0] as { msg: string }).msg);
      expect(msgs).toContain(`Bought ${SYMBOL}`);
    });

    it('writes a "Closed ... position" row and no re-subscribe when a sell empties the position', async () => {
      reset();
      const { adopter } = makeAdopter();
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        avgEntryPrice: '50000',
        quantity: '0.001',
      });
      repoMocks.avgEntryPricesRemove.mockResolvedValue(undefined);

      await adopter.adopt(mkFill({ side: 'SELL', cumQty: '0.001', cumQuoteQty: '60' }));

      expect(repoMocks.profileSymbolsUpsert).not.toHaveBeenCalled();
      const msgs = repoMocks.actionLogsAppend.mock.calls.map((c) => (c[0] as { msg: string }).msg);
      expect(msgs).toContain(`Closed ${SYMBOL} position (sold out)`);
    });

    it('writes a "Sold part" row and keeps the symbol subscribed on a partial sell', async () => {
      reset();
      const { adopter } = makeAdopter();
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        avgEntryPrice: '60000',
        quantity: '0.002',
      });

      await adopter.adopt(mkFill({ side: 'SELL', cumQty: '0.001', cumQuoteQty: '63000' }));

      // A reduced (still-live) position stays managed — no orphan re-subscribe.
      expect(repoMocks.profileSymbolsUpsert).not.toHaveBeenCalled();
      const msgs = repoMocks.actionLogsAppend.mock.calls.map((c) => (c[0] as { msg: string }).msg);
      expect(msgs).toContain(`Sold part of ${SYMBOL}`);
    });
  });

  describe('origin gate (adopt only bot-placed orders)', () => {
    it('does NOT adopt an external fill (no local order row) — no cost basis, state, or re-subscribe', async () => {
      reset();
      const { adopter } = makeAdopter();
      // A coin bought manually on Binance, outside the bot: neither the
      // strategy `orders` table nor `manual_orders` has the order id.
      repoMocks.ordersFindByBinanceOrderId.mockResolvedValue(null);
      repoMocks.manualOrdersFindByBinanceOrderId.mockResolvedValue(null);
      // The symbol is not subscribed, so an adoption would try to re-subscribe.
      repoMocks.profileSymbolsFindForSymbol.mockResolvedValue(null);

      await adopter.adopt(
        mkFill({ orderId: 555, tradeId: 555, cumQty: '0.001', cumQuoteQty: '50' }),
      );

      expect(repoMocks.avgEntryPricesUpsert).not.toHaveBeenCalled();
      expect(repoMocks.avgEntryPricesRemove).not.toHaveBeenCalled();
      expect(repoMocks.persistSymbolState).not.toHaveBeenCalled();
      expect(repoMocks.profileSymbolsUpsert).not.toHaveBeenCalled();
      // The dedupe ledger is never touched for an external fill.
      expect(repoMocks.appliedFillsTryRecord).not.toHaveBeenCalled();
    });

    it('adopts a bot strategy fill (orders row present)', async () => {
      reset();
      const { adopter } = makeAdopter();
      repoMocks.ordersFindByBinanceOrderId.mockResolvedValue({
        symbol: SYMBOL,
        profileId: PROFILE_ID,
      });
      repoMocks.manualOrdersFindByBinanceOrderId.mockResolvedValue(null);
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
      repoMocks.avgEntryPricesUpsert.mockResolvedValue({});

      await adopter.adopt(
        mkFill({ orderId: 601, tradeId: 601, cumQty: '0.001', cumQuoteQty: '50' }),
      );

      expect(repoMocks.avgEntryPricesUpsert).toHaveBeenCalledTimes(1);
    });

    it('adopts a bot-manual fill (manual_orders row present, orders null)', async () => {
      reset();
      const { adopter } = makeAdopter();
      repoMocks.ordersFindByBinanceOrderId.mockResolvedValue(null);
      repoMocks.manualOrdersFindByBinanceOrderId.mockResolvedValue({ symbol: SYMBOL });
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
      repoMocks.avgEntryPricesUpsert.mockResolvedValue({});

      await adopter.adopt(
        mkFill({ orderId: 602, tradeId: 602, cumQty: '0.001', cumQuoteQty: '50' }),
      );

      expect(repoMocks.avgEntryPricesUpsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('orders-row reconciliation', () => {
    it('marks the orders row FILLED with the fill totals on a BUY fill', async () => {
      reset();
      const { adopter } = makeAdopter();
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
      repoMocks.avgEntryPricesUpsert.mockResolvedValue({});

      await adopter.adopt(mkFill({ orderId: 925411723, cumQty: '163.2', cumQuoteQty: '15.14496' }));

      expect(repoMocks.ordersMarkFilled).toHaveBeenCalledTimes(1);
      const [id, fill] = repoMocks.ordersMarkFilled.mock.calls[0] ?? [];
      expect(id).toBe(925411723n);
      expect(fill).toEqual({
        executedQty: '163.2',
        cummulativeQuoteQty: '15.14496',
      });
    });

    it('reconciles a SELL fill and stamps cost-basis-matched realised P/L separately', async () => {
      reset();
      const { adopter } = makeAdopter();
      // Hold 0.002 @ 60000 (cost 120); sell all 0.002 for 130 → realised +10.
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        avgEntryPrice: '60000',
        quantity: '0.002',
      });

      await adopter.adopt(
        mkFill({ side: 'SELL', orderId: 42, cumQty: '0.002', cumQuoteQty: '130' }),
      );

      // markFilled flips the (resting) row's status — totals only.
      expect(repoMocks.ordersMarkFilled).toHaveBeenCalledWith(42n, {
        executedQty: '0.002',
        cummulativeQuoteQty: '130',
      });
      // The realised P/L is stamped by the status-independent path, so a MARKET
      // sell (already FILLED, markFilled no-ops) still gets its cost basis.
      expect(repoMocks.ordersStampRealizedPnl).toHaveBeenCalledWith(42n, {
        realizedPnl: '10',
        costBasisQuote: '120',
      });
    });

    it('stamps realised P/L BEFORE enqueuing the archive (else the archiver reads NULL)', async () => {
      reset();
      const { adopter, pipelineQueue } = makeAdopter();
      // A full exit: sell all held, which empties the position and enqueues the
      // archive job inside applyResolution.
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue({
        avgEntryPrice: '60000',
        quantity: '0.002',
      });

      await adopter.adopt(
        mkFill({ side: 'SELL', orderId: 77, cumQty: '0.002', cumQuoteQty: '130' }),
      );

      // The stamp must commit before the archive job is enqueued — otherwise the
      // archive handler reads a NULL realized_pnl and silently under-counts.
      const stampOrder = repoMocks.ordersStampRealizedPnl.mock.invocationCallOrder[0];
      const enqueueOrder = pipelineQueue.add.mock.invocationCallOrder[0];
      expect(stampOrder).toBeDefined();
      expect(enqueueOrder).toBeDefined();
      expect(stampOrder).toBeLessThan(enqueueOrder as number);
    });

    it('does not stamp realised P/L on a BUY fill', async () => {
      reset();
      const { adopter } = makeAdopter();
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
      repoMocks.avgEntryPricesUpsert.mockResolvedValue({});

      await adopter.adopt(mkFill({ side: 'BUY', cumQty: '163.2', cumQuoteQty: '15.14496' }));

      expect(repoMocks.ordersStampRealizedPnl).not.toHaveBeenCalled();
    });

    it('does not stamp realised P/L on a SELL with no cost basis (never fabricate)', async () => {
      reset();
      const { adopter } = makeAdopter();
      // No ledger row → realizedPnlOnSell returns null → no stamp.
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);

      await adopter.adopt(mkFill({ side: 'SELL', orderId: 43, cumQty: '5', cumQuoteQty: '100' }));

      expect(repoMocks.ordersMarkFilled).toHaveBeenCalledTimes(1);
      expect(repoMocks.ordersStampRealizedPnl).not.toHaveBeenCalled();
    });

    it('does NOT reconcile on a non-FILLED event', async () => {
      reset();
      const { adopter } = makeAdopter();

      await adopter.adopt(mkFill({ orderStatus: 'NEW' }));

      expect(repoMocks.ordersMarkFilled).not.toHaveBeenCalled();
    });

    it('swallows a reconciliation failure — the committed position is not rolled back', async () => {
      reset();
      const { adopter } = makeAdopter();
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
      repoMocks.avgEntryPricesUpsert.mockResolvedValue({});
      repoMocks.ordersMarkFilled.mockRejectedValue(new Error('db down'));

      await expect(adopter.adopt(mkFill())).resolves.toBeUndefined();
      expect(repoMocks.avgEntryPricesUpsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('order-filled notification', () => {
    it('fires once on a fresh fill with side, quantity, and avg price', async () => {
      reset();
      repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(null);
      repoMocks.avgEntryPricesUpsert.mockResolvedValue({});
      const notifyEvent = vi.fn<
        NonNullable<Parameters<typeof createFillAdopter>[0]['notifyEvent']>
      >(async () => undefined);
      const { adopter } = makeAdopter('0.00000001', false, notifyEvent);

      // avg price = cumQuoteQty / cumQty = 100 / 0.002 = 50000.
      await adopter.adopt(mkFill({ side: 'BUY', cumQty: '0.002', cumQuoteQty: '100' }));

      expect(notifyEvent).toHaveBeenCalledTimes(1);
      const arg = notifyEvent.mock.calls[0]?.[0];
      expect(arg).toMatchObject({ category: 'order-filled', symbol: SYMBOL });
      expect(arg?.body).toContain('Bought');
      expect(arg?.body).toContain('50000');
    });

    it('does not fire on a Binance replay (tryRecord=false is not a fresh fill)', async () => {
      reset();
      repoMocks.appliedFillsTryRecord.mockResolvedValue(false);
      const notifyEvent = vi.fn<
        NonNullable<Parameters<typeof createFillAdopter>[0]['notifyEvent']>
      >(async () => undefined);
      const { adopter } = makeAdopter('0.00000001', false, notifyEvent);

      await adopter.adopt(mkFill());

      expect(notifyEvent).not.toHaveBeenCalled();
    });
  });
});
