// Multi-symbol concurrency for the fill-adopter.
//
// The sibling `fill-adopter.test.ts` has a 2-symbol concurrency case
// (BTC + ETH) that locks the no-clobber invariant. This file extends to
// 3 symbols (BTC, ETH, SOL) so the test surface actually exercises the
// per-symbol map shape: a single-key map can hide a global-write bug
// that only surfaces when N > 2 (e.g. the second symbol's write
// happening to land on the same in-memory slot the third symbol then
// reads). The 3-symbol fan-out is the smallest size that pins
// "per-symbol slice" rather than "two-bucket toggle".
//
// Mirrors the hoisted-mock + in-memory Redis stub harness from
// `fill-adopter.test.ts` so a divergence in the production wiring (e.g.
// `mutateSymbolState` losing its per-symbol routing) trips both files.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { asProfileId, asUserId } from '@app/contracts';
import { trailingTradePositionAdapter } from '@app/strategy-trailing-trade';

import { createFillAdopter } from '../../src/executor/fill-adopter.js';
import { createChainByKey } from '../../src/lib/chain-by-key.js';
import { createStatePort } from '../../src/state/state-port.js';
import { buildSymbolStateKey } from '../../src/executor/redis-namespace.js';

const repoMocks = vi.hoisted(() => ({
  avgEntryPricesFindBySymbol: vi.fn(),
  avgEntryPricesUpsert: vi.fn(),
  avgEntryPricesRemove: vi.fn(),
  appliedFillsTryRecord: vi.fn(),
  profileFindById: vi.fn(),
  symbolStatesFindBySymbol: vi.fn(),
  persistSymbolState: vi.fn(),
  profileSymbolsFindForSymbol: vi.fn(),
  profileSymbolsUpsert: vi.fn(),
  actionLogsAppend: vi.fn(),
  ordersFindByBinanceOrderId: vi.fn(),
  manualOrdersFindByBinanceOrderId: vi.fn(),
}));

const testRepo = {
  scope: { userId: undefined as unknown, profileId: undefined as unknown },
  avgEntryPrices: {
    findBySymbol: repoMocks.avgEntryPricesFindBySymbol,
    upsert: repoMocks.avgEntryPricesUpsert,
    remove: repoMocks.avgEntryPricesRemove,
  },
  appliedFills: { tryRecord: repoMocks.appliedFillsTryRecord },
  profile: { findById: repoMocks.profileFindById },
  symbolStates: { findBySymbol: repoMocks.symbolStatesFindBySymbol },
  profileSymbols: {
    findForSymbol: repoMocks.profileSymbolsFindForSymbol,
    upsert: repoMocks.profileSymbolsUpsert,
  },
  orders: { findByBinanceOrderId: repoMocks.ordersFindByBinanceOrderId },
  manualOrders: { findByBinanceOrderId: repoMocks.manualOrdersFindByBinanceOrderId },
  actionLogs: { append: repoMocks.actionLogsAppend },
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
    profileRepoFromScope: vi.fn(() => testRepo),
    withTx: vi.fn((scope: unknown) => scope),
  };
});

const silentLogger = new Proxy({} as Logger, { get: () => () => undefined }) as Logger;

const USER_ID = asUserId('00000000-0000-0000-0000-000000000001');
const PROFILE_ID = asProfileId('00000000-0000-0000-0000-000000000002');

const makeRedisStub = (): { redis: Redis; store: Map<string, unknown> } => {
  const store = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
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
      sets.delete(key);
      return had;
    }),
    sadd: vi.fn(async (key: string, member: string) => {
      let set = sets.get(key);
      if (!set) {
        set = new Set();
        sets.set(key, set);
      }
      if (set.has(member)) return 0;
      set.add(member);
      return 1;
    }),
    srem: vi.fn(async (key: string, member: string) => {
      const set = sets.get(key);
      if (!set) return 0;
      return set.delete(member) ? 1 : 0;
    }),
    expire: vi.fn(async () => 1),
  } as unknown as Redis;
  return { redis, store };
};

const makeAdopter = () => {
  const { redis, store } = makeRedisStub();
  // Match the production wiring: `persistSymbolState` writes the Redis
  // cache alongside the durable upsert. The stub records the per-symbol
  // call so the test asserts the symbol arg, not just the count.
  const persistSymbolState = vi.fn(
    async (
      _scope: unknown,
      sym: string,
      next: unknown,
      _v: string,
      _expectedVersion: number | null,
    ): Promise<boolean> => {
      store.set(buildSymbolStateKey(USER_ID, PROFILE_ID, sym), JSON.stringify(next));
      repoMocks.persistSymbolState(sym, next);
      return true;
    },
  );
  const registry = {
    get: vi.fn(() => ({
      name: 'trailing-trade',
      version: '2.0.0',
      // `initialState` is consumed when `symbol_states.findBySymbol`
      // returns null. Each symbol's mock returns a row here so the seed
      // path is not the one under test; the row's body is the slice the
      // mutator patches.
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
        throw new Error('fill-adopter test: coldLoad.loadSymbolState should not be called');
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
  });
  return { adopter, store, persistSymbolState };
};

const reset = (): void => {
  testRepo.scope = { userId: USER_ID, profileId: PROFILE_ID };
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
  repoMocks.ordersFindByBinanceOrderId.mockReset();
  repoMocks.manualOrdersFindByBinanceOrderId.mockReset();
  repoMocks.appliedFillsTryRecord.mockResolvedValue(true);
  repoMocks.profileFindById.mockResolvedValue({ strategyName: 'trailing-trade', config: {} });
  // Each concurrent BUY is a bot-placed order, so the origin gate finds a
  // matching `orders` row and adoption proceeds (manual_orders never matches).
  repoMocks.ordersFindByBinanceOrderId.mockResolvedValue({
    binanceOrderId: 0n,
    profileId: PROFILE_ID,
  });
  repoMocks.manualOrdersFindByBinanceOrderId.mockResolvedValue(null);
  // All concurrent-test symbols are already subscribed, so the orphan
  // re-subscribe path is never taken.
  repoMocks.profileSymbolsFindForSymbol.mockResolvedValue({ source: 'manual' });
  repoMocks.actionLogsAppend.mockResolvedValue(undefined);
};

interface SymbolFixture {
  readonly symbol: string;
  readonly priorLbp: string;
  readonly priorQty: string;
  // Fill: `cumQuoteQty / cumQty` = effective price.
  readonly fillQty: string;
  readonly fillQuote: string;
  readonly expectedLbp: string;
  readonly expectedQty: string;
  readonly orderId: number;
}

// Three symbols with distinct prior LBP/qty AND distinct fill sizes so
// the expected post-weight LBP differs per symbol. A regression that
// re-uses one symbol's prior row for another's fill cannot satisfy all
// three assertions at once.
const FIXTURES: readonly SymbolFixture[] = [
  {
    symbol: 'BTCUSDT',
    priorLbp: '50000',
    priorQty: '0.5',
    fillQty: '0.5',
    fillQuote: '35000', // effective 70000
    expectedLbp: '60000', // (50000*0.5 + 70000*0.5) / 1
    expectedQty: '1',
    orderId: 1001,
  },
  {
    symbol: 'ETHUSDT',
    priorLbp: '2000',
    priorQty: '5',
    fillQty: '5',
    fillQuote: '15000', // effective 3000
    expectedLbp: '2500', // (2000*5 + 3000*5) / 10
    expectedQty: '10',
    orderId: 1002,
  },
  {
    symbol: 'SOLUSDT',
    priorLbp: '100',
    priorQty: '10',
    fillQty: '10',
    fillQuote: '1400', // effective 140
    expectedLbp: '120', // (100*10 + 140*10) / 20
    expectedQty: '20',
    orderId: 1003,
  },
];

const mkFill = (f: SymbolFixture) => ({
  userId: USER_ID,
  profileId: PROFILE_ID,
  symbol: f.symbol,
  orderId: f.orderId,
  tradeId: f.orderId,
  orderStatus: 'FILLED' as const,
  side: 'BUY' as const,
  cumQty: f.fillQty,
  cumQuoteQty: f.fillQuote,
});

describe('createFillAdopter — 3-symbol concurrent BUYs (per-(profile, symbol) isolation)', () => {
  it('disjoint LBP upserts and disjoint symbol_states writes for BTC + ETH + SOL', async () => {
    reset();
    const { adopter, store } = makeAdopter();

    const lbpBySymbol = new Map(FIXTURES.map((f) => [f.symbol, f]));
    repoMocks.avgEntryPricesFindBySymbol.mockImplementation(async (sym: string) => {
      const f = lbpBySymbol.get(sym);
      return f ? { avgEntryPrice: f.priorLbp, quantity: f.priorQty } : null;
    });
    repoMocks.avgEntryPricesUpsert.mockResolvedValue({});
    // Each symbol's prior state carries a marker field so the test can
    // assert the post-write body preserved its own pre-fill shape (no
    // cross-symbol marker bled into another row).
    repoMocks.symbolStatesFindBySymbol.mockImplementation(async (sym: string) => ({
      profileId: PROFILE_ID,
      symbol: sym,
      state: {
        schemaVersion: '2.0.0',
        avgEntryPrice: lbpBySymbol.get(sym)?.priorLbp ?? null,
        heldQuantity: lbpBySymbol.get(sym)?.priorQty ?? null,
        // Per-symbol marker. After the BUY adopt, the symbol_states row
        // for `sym` must still carry `marker: sym` (the adopter resets
        // highSinceBuy but does not touch arbitrary fields).
        marker: sym,
      },
      strategyVersion: '2.0.0',
    }));

    await Promise.all(FIXTURES.map((f) => adopter.adopt(mkFill(f))));

    // One LBP upsert per symbol with the symbol's own weighted result.
    expect(repoMocks.avgEntryPricesUpsert).toHaveBeenCalledTimes(FIXTURES.length);
    const upsertsBySymbol = new Map(
      repoMocks.avgEntryPricesUpsert.mock.calls.map((c) => [c[0] as string, c[1]]),
    );
    for (const f of FIXTURES) {
      expect(upsertsBySymbol.get(f.symbol)).toEqual({
        avgEntryPrice: f.expectedLbp,
        quantity: f.expectedQty,
      });
    }

    // One persistSymbolState call per symbol, with the symbol arg
    // matching the slice body. A reuse of one symbol's body for another
    // would either trip the LBP-mismatch assertion below or the marker
    // assertion.
    expect(repoMocks.persistSymbolState).toHaveBeenCalledTimes(FIXTURES.length);
    const persistedSymbols = repoMocks.persistSymbolState.mock.calls.map((c) => c[0]);
    expect(new Set(persistedSymbols)).toEqual(new Set(FIXTURES.map((f) => f.symbol)));

    // Per-symbol Redis cache lands with the per-symbol post-fill body.
    // `marker: sym` proves the row's pre-fill identity survived the
    // adopt: a global-write bug would land the last-written marker on
    // every key.
    for (const f of FIXTURES) {
      const key = buildSymbolStateKey(USER_ID, PROFILE_ID, f.symbol);
      const body = JSON.parse(String(store.get(key))) as Record<string, unknown>;
      expect(body['marker']).toBe(f.symbol);
      expect(body['avgEntryPrice']).toBe(f.expectedLbp);
      expect(body['heldQuantity']).toBe(f.expectedQty);
      expect(body['schemaVersion']).toBe('2.0.0');
    }
  });
});
