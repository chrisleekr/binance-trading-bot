// Base-asset BUY commission must be netted out of the tracked held quantity.
//
// Binance charges the BUY fee in the BASE asset, so the wallet is credited
// `executedQty - commission`, not `executedQty`. Folding the GROSS quantity
// leaves the tracked number permanently above the wallet: the protective stop
// is sized from the real balance, so a full exit always falls short of the
// tracked quantity by a fee's worth, the fill resolves `sell-reduce` instead of
// `clear`, and the closed cycle is never archived.
//
// Reproduces the live TSTUSDT close (2026-08-10): BUY 1682.30 with 1.6823 TST
// commission (wallet 1680.6177), protective SELL 1680.60 (1680.6177 floored to
// the 0.1 LOT_SIZE step). Gross residual 1.70 exceeds the step and strands the
// position; fee-net residual 0.0177 is sub-step and clears.
//
// Fees charged in a NON-base asset (BNB discount) and reports carrying no
// commission fields at all must keep the full gross quantity: those are the
// regression guard against over-netting.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { Decimal } from '@app/money';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';

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
  appliedFills: { tryRecord: repoMocks.appliedFillsTryRecord },
  profile: { findById: repoMocks.profileFindById },
  symbolStates: { findBySymbol: repoMocks.symbolStatesFindBySymbol },
  profileSymbols: {
    findForSymbol: repoMocks.profileSymbolsFindForSymbol,
    upsert: repoMocks.profileSymbolsUpsert,
  },
  actionLogs: { append: repoMocks.actionLogsAppend },
  orders: {
    markFilledByBinanceOrderId: repoMocks.ordersMarkFilled,
    stampBaseCommissionNetted: repoMocks.ordersStampBaseCommissionNetted,
    stampRealizedPnl: repoMocks.ordersStampRealizedPnl,
    findByBinanceOrderId: repoMocks.ordersFindByBinanceOrderId,
  },
  manualOrders: { findByBinanceOrderId: repoMocks.manualOrdersFindByBinanceOrderId },
};

vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return {
    ...orig,
    toAccountScope: vi.fn((scope: unknown) => scope),
    accountRepoFromScope: vi.fn(() => testRepo),
    profileRepo: vi.fn(async () => testRepo),
    profileRepoFromScope: vi.fn(() => testRepo),
    withTx: vi.fn((scope: unknown) => scope),
  };
});

const silentLogger = new Proxy({} as Logger, { get: () => () => undefined }) as Logger;

const USER_ID = asUserId('00000000-0000-0000-0000-000000000001');
const ACCOUNT_ID = asAccountId('00000000-0000-0000-0000-000000000003');
const PROFILE_ID = asProfileId('00000000-0000-0000-0000-000000000002');
const SYMBOL = 'TSTUSDT';
const BASE_ASSET = 'TST';
// TSTUSDT LOT_SIZE increment, the smallest sellable amount of the base asset.
const STEP_SIZE = '0.1';

// Live TSTUSDT numbers, copied from the stranded 2026-08-10 cycle.
const BUY_GROSS_QTY = '1682.30';
const BUY_QUOTE = '25.18403100';
const BUY_COMMISSION = '1.6823';
const BUY_NET_QTY = '1680.6177';
const SELL_QTY = '1680.60';
const SELL_QUOTE = '31.29277200';

type AdoptArg = Parameters<ReturnType<typeof createFillAdopter>['adopt']>[0];

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
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  } as unknown as Redis;
  return { redis, store };
};

/** `symbolInfoThrows` simulates the delisted / cold-cache lookup failure. */
const makeAdopter = (symbolInfoThrows = false) => {
  const { redis, store } = makeRedisStub();
  const pipelineQueue = { add: vi.fn() };
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
  const fakeDb = {
    transaction: vi.fn(async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb({})),
  } as unknown as Parameters<typeof createFillAdopter>[0]['db'];
  const statePort = createStatePort({
    redis,
    logger: silentLogger,
    registry,
    coldLoad: {
      loadSymbolState: vi.fn(async () => {
        throw new Error('fee-net test: coldLoad.loadSymbolState should not be called');
      }),
    } as unknown as Parameters<typeof createStatePort>[0]['coldLoad'],
    persistSymbolState,
  });
  const adopter = createFillAdopter({
    db: fakeDb,
    chain: createChainByKey(),
    logger: silentLogger,
    statePort,
    registry,
    pipelineQueue: pipelineQueue as unknown as Parameters<
      typeof createFillAdopter
    >[0]['pipelineQueue'],
    symbolInfo: {
      get: vi.fn(async () => {
        if (symbolInfoThrows) throw new Error('symbol-info-cache: delisted');
        return { baseAsset: BASE_ASSET, filters: { stepSize: STEP_SIZE, minNotional: '0' } };
      }),
    } as unknown as Parameters<typeof createFillAdopter>[0]['symbolInfo'],
  });
  return { adopter, store, pipelineQueue };
};

/** Durable `avg_entry_prices` row, so a BUY and its later SELL chain for real. */
interface LedgerRow {
  avgEntryPrice: string;
  quantity: string;
}

const reset = (): { ledger: { row: LedgerRow | null } } => {
  testRepo.scope = {
    db: {},
    operatorId: USER_ID,
    accountId: ACCOUNT_ID,
    profileId: PROFILE_ID,
  };
  for (const m of Object.values(repoMocks)) m.mockReset();

  // Stateful cost-basis ledger: the SELL must read exactly what the BUY wrote,
  // otherwise the end-to-end clear/sell-reduce outcome is hard-coded, not proven.
  const ledger: { row: LedgerRow | null } = { row: null };
  repoMocks.avgEntryPricesFindBySymbol.mockImplementation(async () => ledger.row);
  repoMocks.avgEntryPricesUpsert.mockImplementation(async (_sym: string, next: LedgerRow) => {
    ledger.row = { ...next };
    return ledger.row;
  });
  repoMocks.avgEntryPricesRemove.mockImplementation(async () => {
    ledger.row = null;
  });

  repoMocks.ordersMarkFilled.mockResolvedValue(1);
  repoMocks.ordersStampBaseCommissionNetted.mockResolvedValue(1);
  repoMocks.ordersStampRealizedPnl.mockResolvedValue(1);
  repoMocks.ordersFindByBinanceOrderId.mockResolvedValue({ symbol: SYMBOL, profileId: PROFILE_ID });
  repoMocks.manualOrdersFindByBinanceOrderId.mockResolvedValue(null);
  repoMocks.appliedFillsTryRecord.mockResolvedValue(true);
  repoMocks.profileFindById.mockResolvedValue({ strategyName: 'trailing-trade', config: {} });
  repoMocks.profileSymbolsFindForSymbol.mockResolvedValue({ symbol: SYMBOL, source: 'manual' });
  repoMocks.profileSymbolsUpsert.mockResolvedValue({ symbol: SYMBOL, source: 'manual' });
  repoMocks.actionLogsAppend.mockResolvedValue(undefined);
  repoMocks.symbolStatesFindBySymbol.mockResolvedValue({
    profileId: PROFILE_ID,
    symbol: SYMBOL,
    state: { schemaVersion: '2.0.0' },
    strategyVersion: '2.0.0',
    version: 0,
  });
  return { ledger };
};

const mkFill = (overrides: Partial<AdoptArg> = {}): AdoptArg => ({
  operatorId: USER_ID,
  accountId: ACCOUNT_ID,
  profileId: PROFILE_ID,
  symbol: SYMBOL,
  orderId: 1,
  tradeId: 1,
  orderStatus: 'FILLED',
  side: 'BUY' as const,
  cumQty: BUY_GROSS_QTY,
  cumQuoteQty: BUY_QUOTE,
  ...overrides,
});

/** Numeric-exact comparison; `.toFixed()` keeps the failure message readable. */
const expectQty = (actual: unknown, expected: string): void => {
  expect(new Decimal(String(actual)).toFixed()).toBe(new Decimal(expected).toFixed());
};

const readState = (store: Map<string, unknown>): Record<string, unknown> =>
  JSON.parse(String(store.get(buildSymbolStateKey(ACCOUNT_ID, PROFILE_ID, SYMBOL)))) as Record<
    string,
    unknown
  >;

describe('fill-adopter: base-asset commission is netted out of the held quantity', () => {
  it('tracks the fee-net quantity a BUY actually credited to the wallet', async () => {
    reset();
    const { adopter, store } = makeAdopter();

    await adopter.adopt(
      mkFill({
        orderId: 4001,
        tradeId: 4001,
        commissions: { [BASE_ASSET]: BUY_COMMISSION },
      }),
    );

    expect(repoMocks.avgEntryPricesUpsert).toHaveBeenCalledTimes(1);
    expectQty(repoMocks.avgEntryPricesUpsert.mock.calls[0]?.[1]?.quantity, BUY_NET_QTY);
    expectQty(readState(store)['heldQuantity'], BUY_NET_QTY);
    expect(repoMocks.ordersStampBaseCommissionNetted).toHaveBeenCalledWith(
      SYMBOL,
      4001n,
      BUY_COMMISSION,
    );
  });

  it('fails the fill transaction when its base-commission proof matches no order', async () => {
    reset();
    repoMocks.ordersStampBaseCommissionNetted.mockResolvedValueOnce(0);
    const { adopter, store } = makeAdopter();

    await expect(
      adopter.adopt(
        mkFill({
          orderId: 4009,
          tradeId: 4009,
          commissions: { [BASE_ASSET]: BUY_COMMISSION },
        }),
      ),
    ).rejects.toThrow('base-commission proof did not match one order');

    expect(repoMocks.ordersMarkFilled).not.toHaveBeenCalled();
    expect(repoMocks.persistSymbolState).not.toHaveBeenCalled();
    expect(store.has(buildSymbolStateKey(ACCOUNT_ID, PROFILE_ID, SYMBOL))).toBe(false);
  });

  it('subtracts only the base-asset subtotal from a mixed-fee BUY', async () => {
    reset();
    const { adopter, store } = makeAdopter();
    const mixedFeeFill = mkFill({
      orderId: 4008,
      tradeId: 4008,
      commissions: { BNB: '0.00004', [BASE_ASSET]: BUY_COMMISSION },
    });

    await adopter.adopt(mixedFeeFill);

    expectQty(repoMocks.avgEntryPricesUpsert.mock.calls[0]?.[1]?.quantity, BUY_NET_QTY);
    expectQty(readState(store)['heldQuantity'], BUY_NET_QTY);
  });

  it('clears the position and archives the cycle when the protective SELL exits the fee-net quantity', async () => {
    reset();
    const { adopter, store, pipelineQueue } = makeAdopter();

    await adopter.adopt(
      mkFill({
        orderId: 4001,
        tradeId: 4001,
        commissions: { [BASE_ASSET]: BUY_COMMISSION },
      }),
    );

    // The protective stop is sized from the real wallet balance floored to the
    // LOT_SIZE step, so it can never reach the gross tracked quantity.
    await adopter.adopt(
      mkFill({
        side: 'SELL',
        orderId: 4002,
        tradeId: 4002,
        cumQty: SELL_QTY,
        cumQuoteQty: SELL_QUOTE,
        commissions: { USDT: '0.03129277' },
      }),
    );

    // Residual 0.0177 is below the 0.1 step, so the position IS flat.
    expect(repoMocks.avgEntryPricesRemove).toHaveBeenCalledTimes(1);
    const state = readState(store);
    expect(state['heldQuantity']).toBeNull();
    expect(state['avgEntryPrice']).toBeNull();
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

  it('keeps the full gross quantity when the commission was charged in BNB', async () => {
    reset();
    const { adopter, store } = makeAdopter();

    // BNB-discounted fee leaves the base-asset credit untouched.
    await adopter.adopt(
      mkFill({ orderId: 4003, tradeId: 4003, commissions: { BNB: '0.00004521' } }),
    );

    expectQty(repoMocks.avgEntryPricesUpsert.mock.calls[0]?.[1]?.quantity, BUY_GROSS_QTY);
    expectQty(readState(store)['heldQuantity'], BUY_GROSS_QTY);
    expect(repoMocks.ordersStampBaseCommissionNetted).not.toHaveBeenCalled();
  });

  it('keeps the full gross quantity when the report carries no commission fields', async () => {
    reset();
    const { adopter, store } = makeAdopter();

    await adopter.adopt(mkFill({ orderId: 4004, tradeId: 4004 }));

    expectQty(repoMocks.avgEntryPricesUpsert.mock.calls[0]?.[1]?.quantity, BUY_GROSS_QTY);
    expectQty(readState(store)['heldQuantity'], BUY_GROSS_QTY);
  });

  it('keeps the full gross quantity when the commission string cannot be parsed', async () => {
    reset();
    const { adopter, store } = makeAdopter();

    // An unmeasured fee must not be guessed at: subtracting anything here would
    // track a position the wallet does not hold in the opposite direction.
    await adopter.adopt(
      mkFill({
        orderId: 4005,
        tradeId: 4005,
        commissions: { [BASE_ASSET]: 'not-a-number' },
      }),
    );

    expectQty(repoMocks.avgEntryPricesUpsert.mock.calls[0]?.[1]?.quantity, BUY_GROSS_QTY);
    expectQty(readState(store)['heldQuantity'], BUY_GROSS_QTY);
  });

  it('keeps gross when a valid base subtotal is accompanied by a malformed foreign subtotal', async () => {
    reset();
    const { adopter, store } = makeAdopter();

    await adopter.adopt(
      mkFill({
        orderId: 4009,
        tradeId: 4009,
        commissions: { [BASE_ASSET]: BUY_COMMISSION, BNB: 'not-a-number' },
      }),
    );

    expectQty(repoMocks.avgEntryPricesUpsert.mock.calls[0]?.[1]?.quantity, BUY_GROSS_QTY);
    expectQty(readState(store)['heldQuantity'], BUY_GROSS_QTY);
  });

  it('keeps the full gross quantity when the base asset cannot be resolved at all', async () => {
    reset();
    const { adopter, store } = makeAdopter(true);

    // The symbol-info lookup is what names the base asset, so a failed lookup
    // leaves the fee's asset unidentifiable. Netting on the guess that the fee
    // is base-denominated would understate a BNB-paid position instead.
    await adopter.adopt(
      mkFill({
        orderId: 4007,
        tradeId: 4007,
        commissions: { [BASE_ASSET]: BUY_COMMISSION },
      }),
    );

    expectQty(repoMocks.avgEntryPricesUpsert.mock.calls[0]?.[1]?.quantity, BUY_GROSS_QTY);
    expectQty(readState(store)['heldQuantity'], BUY_GROSS_QTY);
  });

  it.each([
    ['equals', BUY_GROSS_QTY],
    ['exceeds', '1682.31'],
  ])(
    'keeps the full gross quantity when the base-asset fee %s the filled quantity',
    async (_case, fee) => {
      reset();
      const { adopter, store } = makeAdopter();

      // A fee at or above the whole fill is not a fee. Netting it would write a
      // zero or negative quantity and divide by zero on the entry-price VWAP.
      await adopter.adopt(
        mkFill({
          orderId: 4006,
          tradeId: 4006,
          commissions: { [BASE_ASSET]: fee },
        }),
      );

      expectQty(repoMocks.avgEntryPricesUpsert.mock.calls[0]?.[1]?.quantity, BUY_GROSS_QTY);
      expectQty(readState(store)['heldQuantity'], BUY_GROSS_QTY);
    },
  );
});
