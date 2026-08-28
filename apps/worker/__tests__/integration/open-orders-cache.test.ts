// Real-Redis integration test for the lock-free open-orders cache Lua.
//
// Verifies the server-side GET→patch→SET semantics the fake-eval unit tests
// cannot: upsert-in-place, remove-by-id, patch of filled amounts, and — the
// safety property the whole design rests on — that remove/patch NEVER fabricate
// an absent key (a dropped snapshot cold-loads, it is not reconstructed from one
// event).

import { afterAll, beforeAll, expect, it } from 'vitest';
import { Redis } from 'ioredis';

import { withRedis } from '@app/testcontainers';
import {
  OPEN_ORDERS_TTL_S,
  patchOpenOrder,
  removeOpenOrder,
  upsertOpenOrder,
} from '../../src/executor/open-orders-cache.js';

import { describeInfra } from './_infra-gate.js';

interface CachedOrder {
  orderId: number;
  status: string;
  executedQty: string;
  cummulativeQuoteQty: string;
}

const order = (orderId: number, over: Partial<CachedOrder> = {}): CachedOrder => ({
  orderId,
  status: 'NEW',
  executedQty: '0',
  cummulativeQuoteQty: '0',
  ...over,
});

describeInfra('redis', 'open-orders cache Lua', () => {
  let redis: Redis;
  let stop: () => Promise<void>;
  let keySeq = 0;
  const nextKey = (): string => `tenant:acct-x:open-orders:S${(keySeq += 1)}`;

  const read = async (key: string): Promise<CachedOrder[] | null> => {
    const raw = await redis.get(key);
    return raw === null ? null : (JSON.parse(raw) as CachedOrder[]);
  };

  beforeAll(async () => {
    const fx = await withRedis();
    redis = new Redis(fx.redisUrl, { maxRetriesPerRequest: null });
    const stale = await redis.keys('tenant:acct-x:open-orders:*');
    if (stale.length > 0) await redis.del(...stale);
    stop = async () => {
      redis.disconnect();
      await fx.stop();
    };
  }, 180_000);

  afterAll(async () => {
    if (stop) await stop();
  });

  it('upsert creates an absent key, then replaces by orderId and appends new ids', async () => {
    const key = nextKey();
    await upsertOpenOrder(redis, key, order(1) as never);
    expect(await read(key)).toEqual([order(1)]);

    // Same orderId replaces in place (no duplicate).
    await upsertOpenOrder(redis, key, order(1, { status: 'PARTIALLY_FILLED' }) as never);
    expect(await read(key)).toEqual([order(1, { status: 'PARTIALLY_FILLED' })]);

    // New orderId appends.
    await upsertOpenOrder(redis, key, order(2) as never);
    expect(await read(key)).toEqual([order(1, { status: 'PARTIALLY_FILLED' }), order(2)]);

    // TTL is refreshed to the safety ceiling on every write.
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(OPEN_ORDERS_TTL_S - 30);
    expect(ttl).toBeLessThanOrEqual(OPEN_ORDERS_TTL_S);
  });

  it('remove drops one order by id, leaves the rest, and stores [] when the last goes', async () => {
    const key = nextKey();
    await upsertOpenOrder(redis, key, order(1) as never);
    await upsertOpenOrder(redis, key, order(2) as never);

    await removeOpenOrder(redis, key, 1);
    expect(await read(key)).toEqual([order(2)]);

    await removeOpenOrder(redis, key, 2);
    // Empty, but present — a definitive "no open orders", not a cold-load miss.
    expect(await read(key)).toEqual([]);
  });

  it('patch updates the filled amounts + status of one order, leaving others intact', async () => {
    const key = nextKey();
    await upsertOpenOrder(redis, key, order(1) as never);
    await upsertOpenOrder(redis, key, order(2) as never);

    await patchOpenOrder(redis, key, 1, {
      executedQty: '0.4',
      cumQuote: '20',
      status: 'PARTIALLY_FILLED',
    });
    expect(await read(key)).toEqual([
      order(1, { executedQty: '0.4', cummulativeQuoteQty: '20', status: 'PARTIALLY_FILLED' }),
      order(2),
    ]);
  });

  it('remove/patch never fabricate an absent key (cold-load, not reconstruct)', async () => {
    const key = nextKey();
    await removeOpenOrder(redis, key, 42);
    expect(await redis.exists(key)).toBe(0);

    await patchOpenOrder(redis, key, 42, {
      executedQty: '1',
      cumQuote: '5',
      status: 'PARTIALLY_FILLED',
    });
    expect(await redis.exists(key)).toBe(0);
  });

  it('patch of an id not present leaves the list unchanged', async () => {
    const key = nextKey();
    await upsertOpenOrder(redis, key, order(1) as never);
    await patchOpenOrder(redis, key, 999, {
      executedQty: '9',
      cumQuote: '9',
      status: 'FILLED',
    });
    expect(await read(key)).toEqual([order(1)]);
  });
});
