// Tests for the user-stream-reconnect fill backfiller (#372). Drives
// `createFillBackfiller` against a hoisted-mock `profileRepo` (for the
// applied-fills anchor), a stub per-profile REST client, and a stub
// fill-adopter so the test asserts the aggregation + fromId-anchor logic
// without the DB/Binance stack.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import type { MyTradeDto } from '@app/binance';

import { createFillBackfiller } from '../../src/executor/fill-backfiller.js';
import type { FillAdopter, FillEvent } from '../../src/executor/fill-adopter.js';

const repoMocks = vi.hoisted(() => ({ maxTradeId: vi.fn() }));

vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return {
    ...orig,
    profileRepo: vi.fn(async () => ({
      appliedFills: { maxTradeId: repoMocks.maxTradeId },
    })),
  };
});

const silentLogger = new Proxy({} as Logger, { get: () => () => undefined }) as Logger;
const USER_ID = asUserId('00000000-0000-0000-0000-000000000001');
const ACCOUNT_ID = asAccountId('00000000-0000-0000-0000-000000000003');
const PROFILE_ID = asProfileId('00000000-0000-0000-0000-000000000002');
const SYMBOL = 'BTCUSDT';

const trade = (over: Partial<MyTradeDto>): MyTradeDto => ({
  id: 1,
  orderId: 1,
  symbol: SYMBOL,
  price: '100',
  qty: '1',
  quoteQty: '100',
  commission: '0',
  commissionAsset: 'BNB',
  time: 0,
  isBuyer: true,
  isMaker: false,
  ...over,
});

const makeDeps = (opts: { client?: null; trades?: MyTradeDto[]; adoptThrowsOn?: number } = {}) => {
  let adoptCall = 0;
  const adopt = vi.fn(async (_e: FillEvent): Promise<void> => {
    adoptCall += 1;
    if (opts.adoptThrowsOn === adoptCall) throw new Error('adopt blew up');
  });
  const getMyTrades = vi.fn(async () => opts.trades ?? []);
  const resolveBinanceClient = vi.fn(async () =>
    opts.client === null ? null : ({ getMyTrades } as unknown as never),
  );
  const fillAdopter: FillAdopter = { adopt };
  const deps = {
    db: {} as never,
    resolveBinanceClient,
    fillAdopter,
    logger: silentLogger,
  };
  return { deps, adopt, getMyTrades, resolveBinanceClient };
};

beforeEach(() => repoMocks.maxTradeId.mockReset());

describe('createFillBackfiller', () => {
  it('no-ops when no fill has ever been adopted (null anchor) without hitting Binance', async () => {
    repoMocks.maxTradeId.mockResolvedValue(null);
    const { deps, resolveBinanceClient, adopt } = makeDeps();
    await createFillBackfiller(deps).backfill(USER_ID, ACCOUNT_ID, PROFILE_ID, SYMBOL);
    expect(resolveBinanceClient).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
  });

  it('no-ops when no signed client is available (missing key / deletion race)', async () => {
    repoMocks.maxTradeId.mockResolvedValue(10);
    const { deps, adopt } = makeDeps({ client: null });
    await createFillBackfiller(deps).backfill(USER_ID, ACCOUNT_ID, PROFILE_ID, SYMBOL);
    expect(adopt).not.toHaveBeenCalled();
  });

  it('fetches from anchor+1 and adopts one cumulative fill per order in trade-id order', async () => {
    repoMocks.maxTradeId.mockResolvedValue(10);
    const { deps, adopt, getMyTrades } = makeDeps({
      // Deliberately out of order, spanning two orders.
      trades: [
        trade({ id: 13, orderId: 21, qty: '1', quoteQty: '130', isBuyer: false }),
        trade({ id: 11, orderId: 20, qty: '1', quoteQty: '100', isBuyer: true }),
        trade({ id: 12, orderId: 20, qty: '2', quoteQty: '220', isBuyer: true }),
      ],
    });
    await createFillBackfiller(deps).backfill(USER_ID, ACCOUNT_ID, PROFILE_ID, SYMBOL);

    expect(getMyTrades).toHaveBeenCalledWith({ symbol: SYMBOL, fromId: 11, limit: 1000 });
    expect(adopt).toHaveBeenCalledTimes(2);
    // Order 20 (terminal trade 12) folds before order 21 (terminal 13).
    expect(adopt.mock.calls[0]?.[0]).toMatchObject({
      orderId: 20,
      tradeId: 12,
      side: 'BUY',
      orderStatus: 'FILLED',
      cumQty: '3',
      cumQuoteQty: '320',
    });
    expect(adopt.mock.calls[1]?.[0]).toMatchObject({
      orderId: 21,
      tradeId: 13,
      side: 'SELL',
      cumQty: '1',
      cumQuoteQty: '130',
    });
  });

  it('adopts nothing when Binance returns no trades past the anchor', async () => {
    repoMocks.maxTradeId.mockResolvedValue(99);
    const { deps, adopt } = makeDeps({ trades: [] });
    await createFillBackfiller(deps).backfill(USER_ID, ACCOUNT_ID, PROFILE_ID, SYMBOL);
    expect(adopt).not.toHaveBeenCalled();
  });

  it('counts an exact duplicate trade id only once', async () => {
    repoMocks.maxTradeId.mockResolvedValue(0);
    const repeated = trade({
      id: 1,
      orderId: 20,
      qty: '2',
      quoteQty: '200',
      commission: '0.2',
      commissionAsset: 'TST',
    });
    const { deps, adopt } = makeDeps({ trades: [repeated, { ...repeated }] });

    await createFillBackfiller(deps).backfill(USER_ID, ACCOUNT_ID, PROFILE_ID, SYMBOL);

    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt.mock.calls[0]?.[0]).toMatchObject({
      cumQty: '2',
      cumQuoteQty: '200',
      commissions: { TST: '0.2' },
    });
  });

  it.each([
    ['order', { orderId: 21 }],
    ['symbol', { symbol: 'ETHUSDT' }],
    ['side', { isBuyer: false }],
    ['quantity', { qty: '2' }],
    ['quote quantity', { quoteQty: '200' }],
    ['commission', { commission: '0.2' }],
    ['commission asset', { commissionAsset: 'TST' }],
  ])('adopts nothing when a duplicate trade id conflicts on %s', async (_case, conflict) => {
    repoMocks.maxTradeId.mockResolvedValue(0);
    const original = trade({ id: 2, orderId: 20, commission: '0.1', commissionAsset: 'BNB' });
    const { deps, adopt } = makeDeps({
      trades: [trade({ id: 1, orderId: 10 }), original, { ...original, ...conflict }],
    });

    await createFillBackfiller(deps).backfill(USER_ID, ACCOUNT_ID, PROFILE_ID, SYMBOL);

    expect(adopt).not.toHaveBeenCalled();
  });

  it('adopts nothing when any REST row belongs to another symbol', async () => {
    repoMocks.maxTradeId.mockResolvedValue(0);
    const { deps, adopt } = makeDeps({
      trades: [trade({ id: 1, orderId: 10 }), trade({ id: 2, orderId: 20, symbol: 'ETHUSDT' })],
    });

    await createFillBackfiller(deps).backfill(USER_ID, ACCOUNT_ID, PROFILE_ID, SYMBOL);

    expect(adopt).not.toHaveBeenCalled();
  });

  it('adopts nothing when semantic duplicate ids differ by runtime type', async () => {
    repoMocks.maxTradeId.mockResolvedValue(0);
    const numericId = trade({ id: 1, orderId: 20 });
    const { deps, adopt } = makeDeps({
      trades: [numericId, { ...numericId, id: '1' } as never],
    });

    await createFillBackfiller(deps).backfill(USER_ID, ACCOUNT_ID, PROFILE_ID, SYMBOL);

    expect(adopt).not.toHaveBeenCalled();
  });

  it.each([
    ['string order id', { orderId: '20' }],
    ['side string', { isBuyer: 'true' }],
    ['side number', { isBuyer: 1 }],
    ['numeric quantity', { qty: 1 }],
    ['null quantity', { qty: null }],
    ['negative quantity', { qty: '-1' }],
    ['numeric quote quantity', { quoteQty: 100 }],
    ['object quote quantity', { quoteQty: {} }],
    ['negative quote quantity', { quoteQty: '-100' }],
  ])('adopts nothing for an ill-typed %s', async (_case, invalid) => {
    repoMocks.maxTradeId.mockResolvedValue(0);
    const { deps, adopt } = makeDeps({
      trades: [trade({ id: 1, orderId: 20, ...invalid } as never)],
    });

    await createFillBackfiller(deps).backfill(USER_ID, ACCOUNT_ID, PROFILE_ID, SYMBOL);

    expect(adopt).not.toHaveBeenCalled();
  });

  it("sums each order's per-trade commission so the recovery path nets the same fee as the live one", async () => {
    repoMocks.maxTradeId.mockResolvedValue(0);
    const { deps, adopt } = makeDeps({
      trades: [
        trade({
          id: 1,
          orderId: 20,
          qty: '600',
          quoteQty: '9',
          commission: '0.6',
          commissionAsset: 'TST',
        }),
        trade({
          id: 2,
          orderId: 20,
          qty: '1082.3',
          quoteQty: '16.18',
          commission: '1.0823',
          commissionAsset: 'TST',
        }),
      ],
    });
    await createFillBackfiller(deps).backfill(USER_ID, ACCOUNT_ID, PROFILE_ID, SYMBOL);

    expect(adopt.mock.calls[0]?.[0]).toMatchObject({
      cumQty: '1682.3',
      commissions: { TST: '1.6823' },
    });
  });

  it("preserves each fee asset when one order's trades mixed commission assets", async () => {
    repoMocks.maxTradeId.mockResolvedValue(0);
    const { deps, adopt } = makeDeps({
      // A BNB balance running out mid-order switches the fee asset.
      trades: [
        trade({ id: 1, orderId: 20, commission: '0.00004', commissionAsset: 'BNB' }),
        trade({ id: 2, orderId: 20, commission: '0.9323', commissionAsset: 'TST' }),
      ],
    });
    await createFillBackfiller(deps).backfill(USER_ID, ACCOUNT_ID, PROFILE_ID, SYMBOL);

    const arg = adopt.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(arg['commissions']).toEqual({ BNB: '0.00004', TST: '0.9323' });
  });

  it.each(['not-a-number', 'NaN', 'Infinity'])(
    'does not expose a partial fee total after a malformed %s commission',
    async (malformed) => {
      repoMocks.maxTradeId.mockResolvedValue(0);
      const { deps, adopt } = makeDeps({
        trades: [
          trade({ id: 1, orderId: 20, commission: '0.5', commissionAsset: 'TST' }),
          trade({ id: 2, orderId: 20, commission: malformed, commissionAsset: 'TST' }),
        ],
      });

      await createFillBackfiller(deps).backfill(USER_ID, ACCOUNT_ID, PROFILE_ID, SYMBOL);

      const arg = adopt.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
      expect(arg['commissions']).toBeUndefined();
      expect(arg['commission']).toBeUndefined();
    },
  );

  it.each([
    ['numeric commission', { commission: 1 }],
    ['null commission', { commission: null }],
    ['object commission', { commission: {} }],
    ['numeric commission asset', { commissionAsset: 1 }],
    ['null commission asset', { commissionAsset: null }],
    ['object commission asset', { commissionAsset: {} }],
  ])('treats an ill-typed %s as an unknown fee', async (_case, malformed) => {
    repoMocks.maxTradeId.mockResolvedValue(0);
    const { deps, adopt } = makeDeps({
      trades: [trade({ id: 1, orderId: 20, ...malformed } as never)],
    });

    await createFillBackfiller(deps).backfill(USER_ID, ACCOUNT_ID, PROFILE_ID, SYMBOL);

    expect(adopt.mock.calls[0]?.[0]).not.toHaveProperty('commissions');
  });

  it.each([
    ['an empty asset', [trade({ id: 1, orderId: 20, commission: '0.5', commissionAsset: '' })]],
    [
      'a malformed fee followed by a valid fee',
      [
        trade({ id: 1, orderId: 20, commission: 'not-a-number', commissionAsset: 'TST' }),
        trade({ id: 2, orderId: 20, commission: '0.5', commissionAsset: 'TST' }),
      ],
    ],
  ])('does not expose commissions after %s', async (_case, trades) => {
    repoMocks.maxTradeId.mockResolvedValue(0);
    const { deps, adopt } = makeDeps({ trades });

    await createFillBackfiller(deps).backfill(USER_ID, ACCOUNT_ID, PROFILE_ID, SYMBOL);

    expect(adopt.mock.calls[0]?.[0]).not.toHaveProperty('commissions');
  });

  it('keeps adopting remaining orders when one adopt throws', async () => {
    repoMocks.maxTradeId.mockResolvedValue(0);
    const { deps, adopt } = makeDeps({
      trades: [
        trade({ id: 1, orderId: 1, isBuyer: true }),
        trade({ id: 2, orderId: 2, isBuyer: false }),
      ],
      adoptThrowsOn: 1,
    });
    await expect(
      createFillBackfiller(deps).backfill(USER_ID, ACCOUNT_ID, PROFILE_ID, SYMBOL),
    ).resolves.toBeUndefined();
    expect(adopt).toHaveBeenCalledTimes(2);
  });
});
