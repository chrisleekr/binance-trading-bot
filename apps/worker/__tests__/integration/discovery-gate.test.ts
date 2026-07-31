// Real-Redis integration test for the discovery per-profile refresh gate (#626).
//
// Reproduces the live wedge: a `discovery:lastrun:<pid>` key that exists with no
// TTL (PTTL == -1) fails the `SET ... PX NX` every cycle, so the profile is
// skipped forever (observed live: 5.5 days dead); the reclaim branch heals it.
// Runs under TESTCONTAINERS=1 (local Docker) or REDIS_TEST_URL (the CI
// worker-integration service container); a leg with neither skips.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { GLOBAL_KEYS } from '@app/db';
import { withRedis } from '@app/testcontainers';

import { shouldRunProfile } from '../../src/crons/discovery/gate.js';

const HAS_INFRA = process.env['TESTCONTAINERS'] === '1' || Boolean(process.env['REDIS_TEST_URL']);
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const REFRESH_PERIOD_MS = 900_000;

const stubLogger = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() });
const asLogger = (l: ReturnType<typeof stubLogger>): Logger => l as unknown as Logger;

describeIfInfra('discovery per-profile refresh gate', () => {
  let redis: Redis;
  let stop: () => Promise<void>;
  let pidSeq = 0;
  // Unique profileId per case so cases never share a `discovery:lastrun:<pid>` key.
  const nextProfileId = (): string =>
    `00000000-0000-4000-8000-${String((pidSeq += 1)).padStart(12, '0')}`;

  beforeAll(async () => {
    const fx = await withRedis();
    redis = new Redis(fx.redisUrl, { maxRetriesPerRequest: null });
    // Clear this suite's namespace. The per-case profileId counter restarts at 0
    // each run, so a reused Redis (the CI path) would otherwise carry a prior
    // run's gate key into the "absent key" case and fail it.
    const stale = await redis.keys('discovery:lastrun:*');
    if (stale.length > 0) await redis.del(...stale);
    stop = async () => {
      redis.disconnect();
      await fx.stop();
    };
  }, 180_000);

  afterAll(async () => {
    if (stop) await stop();
  });

  it('absent key: passes the gate and stamps a TTL', async () => {
    const profileId = nextProfileId();
    const key = GLOBAL_KEYS.discoveryLastRun(profileId);

    const ran = await shouldRunProfile(
      redis,
      profileId,
      REFRESH_PERIOD_MS,
      Date.now(),
      asLogger(stubLogger()),
    );

    expect(ran).toBe(true);
    expect(await redis.pttl(key)).toBeGreaterThan(0);
  });

  it('pre-existing key with NO ttl: must reclaim the gate and stamp a TTL', async () => {
    const profileId = nextProfileId();
    const key = GLOBAL_KEYS.discoveryLastRun(profileId);
    // The wedge: a value present with no expiry (PTTL == -1).
    await redis.set(key, '123');
    expect(await redis.pttl(key)).toBe(-1);

    const logger = stubLogger();
    const ran = await shouldRunProfile(
      redis,
      profileId,
      REFRESH_PERIOD_MS,
      Date.now(),
      asLogger(logger),
    );

    // The reclaim path: gate passes and a TTL is stamped — the wedge auto-heals.
    expect(ran).toBe(true);
    expect(await redis.pttl(key)).toBeGreaterThan(0);
    // Exactly one warn so the offending writer stays visible without spamming.
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('within the window: a second caller is skipped and the TTL survives', async () => {
    const profileId = nextProfileId();
    const key = GLOBAL_KEYS.discoveryLastRun(profileId);
    await redis.set(key, String(Date.now()), 'PX', REFRESH_PERIOD_MS);
    const ttlBefore = await redis.pttl(key);
    expect(ttlBefore).toBeGreaterThan(0);

    const ran = await shouldRunProfile(
      redis,
      profileId,
      REFRESH_PERIOD_MS,
      Date.now(),
      asLogger(stubLogger()),
    );

    expect(ran).toBe(false);
    // The gate did not touch the key: its TTL is still live and roughly unchanged.
    const ttlAfter = await redis.pttl(key);
    expect(ttlAfter).toBeGreaterThan(0);
    expect(ttlAfter).toBeLessThanOrEqual(ttlBefore);
  });

  it('acquire then skip: a real acquire stamps the TTL that gates the next in-window caller', async () => {
    const profileId = nextProfileId();
    const key = GLOBAL_KEYS.discoveryLastRun(profileId);

    // No seeded key: the first call must acquire through the real gate, and the
    // TTL it stamps must gate the second caller in the same window — C6 proven
    // end-to-end through the public function, not via a hand-seeded key.
    const first = await shouldRunProfile(
      redis,
      profileId,
      REFRESH_PERIOD_MS,
      Date.now(),
      asLogger(stubLogger()),
    );
    const second = await shouldRunProfile(
      redis,
      profileId,
      REFRESH_PERIOD_MS,
      Date.now(),
      asLogger(stubLogger()),
    );

    expect([first, second]).toEqual([true, false]);
    expect(await redis.pttl(key)).toBeGreaterThan(0);
  });
});
