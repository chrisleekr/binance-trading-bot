// Real-Redis integration test for the shared weight bucket (epic #561, WS2).
//
// Verifies the properties the fake-eval unit tests cannot: the Lua token
// bucket is atomic under concurrency (no lost update), the counter is shared
// across pod instances, weight decays by wall-clock, and the priority band is
// enforced server-side. Runs under TESTCONTAINERS=1 (local Docker) or
// REDIS_TEST_URL (the CI worker-integration service container); neither skips.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';

import { createRedisWeightGovernor } from '@app/binance';
import { withRedis } from '@app/testcontainers';

const HAS_INFRA = process.env['TESTCONTAINERS'] === '1' || Boolean(process.env['REDIS_TEST_URL']);
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const fakeClock = (start = 1_700_000_000_000): { nowMs(): number; advance(ms: number): void } => {
  let now = start;
  return {
    nowMs: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describeIfInfra('shared Redis weight bucket', () => {
  let redis: Redis;
  let stop: () => Promise<void>;
  let keySeq = 0;
  const nextKey = (): string => `binance:weight:test-${(keySeq += 1)}`;

  beforeAll(async () => {
    const fx = await withRedis();
    redis = new Redis(fx.redisUrl, { maxRetriesPerRequest: null });
    // Clear this suite's namespace. The per-case key counter restarts at 0 each
    // run, so a reused Redis (the CI path) would otherwise carry a prior run's
    // `used` counter into these buckets and break the atomic-sum assertions.
    const stale = await redis.keys('binance:weight:test-*');
    if (stale.length > 0) await redis.del(...stale);
    stop = async () => {
      redis.disconnect();
      await fx.stop();
    };
  }, 180_000);

  afterAll(async () => {
    if (stop) await stop();
  });

  const logger = { warn: () => undefined };

  it('sums concurrent admits atomically — no lost update', async () => {
    const key = nextKey();
    const clock = fakeClock();
    // budget 1000 * 0.8 = ceiling 800. Eight concurrent reserves of 100 sum to
    // exactly 800; with an atomic Lua counter all admit and `used` lands on 800.
    // A client-side read-modify-write would race and under-count.
    const g = createRedisWeightGovernor({ budget: 1000, clock, redis, logger, key });

    await Promise.all(Array.from({ length: 8 }, () => g.reserve(100)));

    const used = await redis.hget(key, 'used');
    expect(Number(used)).toBe(800);
  });

  it('shares the budget across pods, decays over time, and never mutates on reject', async () => {
    const key = nextKey();
    const clock = fakeClock();
    // Capture the counter mid-wait — while Pod B's first attempt has been
    // rejected but not yet re-admitted — to prove the reject path wrote nothing.
    let usedDuringWait: number | null = null;
    const advanceSleep = vi.fn(async (ms: number) => {
      if (usedDuringWait === null) usedDuringWait = Number(await redis.hget(key, 'used'));
      clock.advance(ms);
    });
    const opts = { budget: 1000, clock, sleep: advanceSleep, redis, logger, key } as const;
    const podA = createRedisWeightGovernor(opts);
    const podB = createRedisWeightGovernor(opts);

    // Pod A fills the shared bucket to the ceiling.
    await podA.reserve(800);
    expect(Number(await redis.hget(key, 'used'))).toBe(800);

    // Pod B sees A's consumption (shared key) and must wait for decay.
    await podB.reserve(100);
    expect(advanceSleep).toHaveBeenCalledOnce();
    // Consume-and-decay, no refund: B's rejected attempt left the counter at A's
    // 800 — a reject that wrote state would show a different value here.
    expect(usedDuringWait).toBe(800);
    // B waited exactly long enough for 100 to decay (7500ms at 800/60000 per ms),
    // then admitted its 100 → back to the ceiling. toBeCloseTo, not toBe: the
    // decay arithmetic (elapsed × 800/60000) carries float rounding, so the
    // stored value is 799.999… not a clean 800. This is a real, non-tautological
    // check — a lost update or a fresh bucket would land far from 800.
    expect(Number(await redis.hget(key, 'used'))).toBeCloseTo(800, 6);
  });

  it('enforces the priority band server-side', async () => {
    const key = nextKey();
    const clock = fakeClock();
    const advanceSleep = vi.fn((ms: number) => {
      clock.advance(ms);
      return Promise.resolve();
    });
    // orderReserve 8 → bulk limit 792, priority limit 800.
    const g = createRedisWeightGovernor({
      budget: 1000,
      orderReserve: 8,
      clock,
      sleep: advanceSleep,
      redis,
      logger,
      key,
    });

    // Fill the bulk band to its limit (792), no waiting.
    await g.reserve(792);
    expect(advanceSleep).not.toHaveBeenCalled();

    // A priority order admits immediately against the full ceiling (792 + 1 ≤ 800).
    await g.reserve(1, { priority: true });
    expect(advanceSleep).not.toHaveBeenCalled();

    // A further bulk read is over the bulk limit (793 + 1 > 792) → it must wait.
    await g.reserve(1);
    expect(advanceSleep).toHaveBeenCalled();
  });
});
