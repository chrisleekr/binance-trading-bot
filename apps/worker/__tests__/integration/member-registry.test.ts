// Real-Redis integration for the fleet membership registry (epic #561 WS1).
// Proves the SCAN/MGET round-trip and the register → ready → deregister
// lifecycle against actual ioredis. Runs under TESTCONTAINERS=1 (local Docker)
// or REDIS_TEST_URL (the CI worker-integration service container).

import { countWorkerMembers, FLEET_COUNT_KEY, MEMBER_KEY_PREFIX, parseFleetCount } from '@app/db';
import { createMetricsRegistry } from '@app/observability';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { withRedis } from '@app/testcontainers';

import { createMemberRegistry } from '../../src/boot/member-registry.js';

const HAS_INFRA = process.env['TESTCONTAINERS'] === '1' || Boolean(process.env['REDIS_TEST_URL']);
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const logger = pino({ level: 'silent' });

describeIfInfra('membership registry — real Redis', () => {
  let redis: Redis;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const fx = await withRedis();
    redis = new Redis(fx.redisUrl, { maxRetriesPerRequest: null });
    stop = async () => {
      redis.disconnect();
      await fx.stop();
    };
  }, 180_000);

  afterAll(async () => {
    if (stop) await stop();
  });

  // The container is shared across tests; clear fleet keys between them.
  beforeEach(async () => {
    const keys = await redis.keys(`${MEMBER_KEY_PREFIX}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.del(FLEET_COUNT_KEY);
  });

  const mkRegistry = (id: string, ttlS = 60) =>
    createMemberRegistry({
      redis,
      logger,
      id,
      sha: 'abc',
      bootedAt: '2026-07-08T00:00:00.000Z',
      metrics: createMetricsRegistry({ service: `test-${id}` }),
      ttlS,
      refreshMs: 1_000_000,
    });

  it('registers not-ready, flips to ready, and deregisters', async () => {
    const reg = mkRegistry('pod-a:1');
    await reg.start();
    expect(await countWorkerMembers(redis)).toEqual({ total: 1, ready: 0 });

    // The member key carries a TTL — the crash-only expiry mechanism.
    const ttl = await redis.ttl(`${MEMBER_KEY_PREFIX}pod-a:1`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    // The fleet count is published for O(1) readers (the api /status path).
    expect(parseFleetCount(await redis.get(FLEET_COUNT_KEY))).toEqual({ total: 1, ready: 0 });

    await reg.markReady();
    expect(await countWorkerMembers(redis)).toEqual({ total: 1, ready: 1 });

    // A second pod joins (written directly — simulates another replica).
    await redis.set(
      `${MEMBER_KEY_PREFIX}pod-b:2`,
      JSON.stringify({ id: 'pod-b:2', sha: 'abc', bootedAt: 'x', ready: false }),
      'EX',
      60,
    );
    expect(await countWorkerMembers(redis)).toEqual({ total: 2, ready: 1 });

    // SIGTERM path: the member key is gone immediately, not after the TTL.
    await reg.stop();
    expect(await countWorkerMembers(redis)).toEqual({ total: 1, ready: 0 });
  });

  it('a crashed pod (no stop) disappears when its TTL expires', async () => {
    // 1s TTL, no stop() — models a hard crash. The member must vanish on expiry,
    // which is the only thing that removes a pod that never drained cleanly.
    const reg = mkRegistry('pod-crash:9', 1);
    await reg.start();
    expect(await countWorkerMembers(redis)).toEqual({ total: 1, ready: 0 });

    await new Promise((r) => setTimeout(r, 1_300));
    expect(await countWorkerMembers(redis)).toEqual({ total: 0, ready: 0 });
  });
});
