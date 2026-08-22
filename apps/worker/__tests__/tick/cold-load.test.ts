import { describe, it, expect, vi, type Mock } from 'vitest';
import pino, { type Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { BinanceRestClient } from '@app/binance';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import { createProductionColdLoad } from '../../src/tick/cold-load.js';
import { buildAccountInfoKey } from '../../src/executor/redis-namespace.js';
import { Decimal } from '@app/money';

const silentLogger = pino({ level: 'silent' });
const USER_ID = 'u1' as unknown as UserId;
const ACCOUNT_ID = 'a1' as unknown as AccountId;
const PROFILE_ID = 'p1' as unknown as ProfileId;

const stubRestClient = (overrides: Partial<BinanceRestClient> = {}): BinanceRestClient =>
  ({
    startListenKey: vi.fn(async () => 'legacy'),
    keepaliveListenKey: vi.fn(),
    closeListenKey: vi.fn(),
    getAccount: vi.fn(async () => ({
      balances: [{ asset: 'USDT', free: '100', locked: '0' }],
      canTrade: true,
    })),
    getOpenOrders: vi.fn(async () => []),
    getKlines: vi.fn(async () => []),
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    ctx: vi.fn(() => ({ weightUsed1m: undefined })),
    signWsApiPayload: vi.fn(() => ({ id: 'x', method: 'y', params: {} })),
    ...overrides,
  }) as unknown as BinanceRestClient;

type StubRedis = Redis & { set: Mock<(key: string, value: string) => Promise<'OK'>> };

const stubRedis = (initial: Record<string, string> = {}): StubRedis => {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    get: vi.fn(async (k: string) => data.get(k) ?? null),
    set: vi.fn(async () => 'OK'),
  } as unknown as StubRedis;
};

describe('createProductionColdLoad.loadAccount', () => {
  it('returns account snapshot keyed by asset via REST fallback', async () => {
    const rest = stubRestClient();
    const coldLoad = createProductionColdLoad({
      db: {} as never,
      redis: stubRedis(),
      logger: silentLogger,
      resolveBinance: async () => rest,
    });

    const snap = await coldLoad.loadAccount(USER_ID, ACCOUNT_ID, PROFILE_ID);

    expect(snap.balances).toEqual({
      USDT: { asset: 'USDT', free: new Decimal('100'), locked: new Decimal('0') },
    });
    expect(rest.getAccount).toHaveBeenCalledTimes(1);
  });

  it('throws when resolveBinance returns null (profile / key missing)', async () => {
    const coldLoad = createProductionColdLoad({
      db: {} as never,
      redis: stubRedis(),
      logger: silentLogger,
      resolveBinance: async () => null,
    });

    await expect(coldLoad.loadAccount(USER_ID, ACCOUNT_ID, PROFILE_ID)).rejects.toThrow(
      /no credentials/,
    );
  });

  it('writes account-info through with EX 35 on cold-load', async () => {
    const rest = stubRestClient({
      getAccount: vi.fn(async () => ({
        balances: [{ asset: 'USDT', free: '100', locked: '0' }],
        canTrade: true,
      })),
    });
    const redis = stubRedis();
    const coldLoad = createProductionColdLoad({
      db: {} as never,
      redis,
      logger: silentLogger,
      resolveBinance: async () => rest,
    });

    await coldLoad.loadAccount(USER_ID, ACCOUNT_ID, PROFILE_ID);

    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      buildAccountInfoKey(ACCOUNT_ID, PROFILE_ID),
      JSON.stringify({ balances: { USDT: { free: '100', locked: '0' } } }),
      'EX',
      35,
    );
  });

  it('survives a failed account-info write-through (fail-safe)', async () => {
    const rest = stubRestClient();
    const redis = stubRedis();
    redis.set.mockRejectedValueOnce(new Error('redis down'));
    // Spy logger (not silentLogger) so the "warn, don't swallow" half of the
    // no-silent-failure invariant is actually asserted, matching the sibling
    // open-orders fail-safe test.
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
    const coldLoad = createProductionColdLoad({
      db: {} as never,
      redis,
      logger,
      resolveBinance: async () => rest,
    });

    const snap = await coldLoad.loadAccount(USER_ID, ACCOUNT_ID, PROFILE_ID);

    expect(snap.balances).toEqual({
      USDT: { asset: 'USDT', free: new Decimal('100'), locked: new Decimal('0') },
    });
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

describe('createProductionColdLoad.loadOpenOrders', () => {
  it('maps OpenOrderDto array to strategy-core OpenOrder via REST fallback', async () => {
    const rest = stubRestClient({
      getOpenOrders: vi.fn<BinanceRestClient['getOpenOrders']>(async () => [
        {
          symbol: 'BTCUSDT',
          orderId: 1,
          clientOrderId: 'c1',
          side: 'BUY',
          type: 'LIMIT',
          price: '50000',
          origQty: '0.001',
          executedQty: '0',
          status: 'NEW',
          stopPrice: '0',
          time: 1_700_000_000_000,
          updateTime: 1_700_000_000_500,
          cummulativeQuoteQty: '0',
          timeInForce: 'GTC',
        },
      ]),
    });
    const coldLoad = createProductionColdLoad({
      db: {} as never,
      redis: stubRedis(),
      logger: silentLogger,
      resolveBinance: async () => rest,
    });

    const orders = await coldLoad.loadOpenOrders(USER_ID, ACCOUNT_ID, PROFILE_ID, 'BTCUSDT');

    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      orderId: 1,
      clientOrderId: 'c1',
      transactTimeMs: 1_700_000_000_000,
      updateTimeMs: 1_700_000_000_500,
    });
  });
});
