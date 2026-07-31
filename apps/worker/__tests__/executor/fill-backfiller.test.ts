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
