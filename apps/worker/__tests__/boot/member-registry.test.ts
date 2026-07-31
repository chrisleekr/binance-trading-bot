import { hostname } from 'node:os';

import { FLEET_COUNT_KEY, listReadyMembers } from '@app/db';
import { createMetricsRegistry } from '@app/observability';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createMemberRegistry,
  MEMBER_REFRESH_MS,
  MEMBER_TTL_S,
  workerMemberId,
} from '../../src/boot/member-registry.js';
import type { MemberRegistry } from '../../src/boot/member-registry.js';

/** In-memory Redis covering set/del/scan/mget, reflecting writes immediately. */
const memRedis = (): Redis & { store: Map<string, string> } => {
  const store = new Map<string, string>();
  const fake = {
    store,
    set: (k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve('OK');
    },
    del: (k: string) => Promise.resolve(store.delete(k) ? 1 : 0),
    scan: (_cursor: string) =>
      Promise.resolve(['0', [...store.keys()].filter((k) => k.startsWith('worker:members:'))]),
    mget: (...keys: string[]) => Promise.resolve(keys.map((k) => store.get(k) ?? null)),
  };
  return fake as unknown as Redis & { store: Map<string, string> };
};

const logger = pino({ level: 'silent' });

const build = (redis: Redis): { reg: MemberRegistry; key: string } => {
  const id = 'pod-1:42';
  return {
    key: `worker:members:${id}`,
    reg: createMemberRegistry({
      redis,
      logger,
      id,
      sha: 'deadbeef',
      bootedAt: '2026-07-08T00:00:00.000Z',
      metrics: createMetricsRegistry({ service: 'test' }),
      // Never fires during the test; stop() clears it.
      refreshMs: 1_000_000,
    }),
  };
};

describe('member registry', () => {
  afterEach(() => vi.useRealTimers());

  it('mints a hostname:pid id', () => {
    expect(workerMemberId()).toBe(`${hostname()}:${process.pid}`);
  });

  it('keeps the refresh interval under half the TTL (survives a missed beat)', () => {
    expect(MEMBER_REFRESH_MS * 2).toBeLessThan(MEMBER_TTL_S * 1000);
  });

  it('publishes the fleet count for O(1) readers', async () => {
    const redis = memRedis();
    const { reg } = build(redis);
    await reg.start();
    expect(JSON.parse(redis.store.get(FLEET_COUNT_KEY) ?? '{}')).toEqual({ total: 1, ready: 0 });
    await reg.markReady();
    expect(JSON.parse(redis.store.get(FLEET_COUNT_KEY) ?? '{}')).toEqual({ total: 1, ready: 1 });
    await reg.stop();
  });

  it('registers not-ready on start', async () => {
    const redis = memRedis();
    const { reg, key } = build(redis);
    await reg.start();
    expect(JSON.parse(redis.store.get(key) ?? '{}')).toEqual({
      id: 'pod-1:42',
      sha: 'deadbeef',
      bootedAt: '2026-07-08T00:00:00.000Z',
      ready: false,
    });
    await reg.stop();
  });

  it('flips to ready on markReady', async () => {
    const redis = memRedis();
    const { reg, key } = build(redis);
    await reg.start();
    await reg.markReady();
    expect(JSON.parse(redis.store.get(key) ?? '{}').ready).toBe(true);
    await reg.stop();
  });

  it('a member that never marks ready is excluded from listReadyMembers — a study pod cannot win stream ownership (#640)', async () => {
    // The study role registers + heartbeats (fleet-count observability) but must
    // NOT be an HRW stream-ownership candidate: it runs no userStreamPool, so an
    // account elected to it would have its user-data stream orphaned (fills never
    // adopted). The #640 fix leaves study un-ready; owner election reads only the
    // ready set, so a never-markReady pod is excluded by construction.
    const redis = memRedis();
    const { reg } = build(redis);
    await reg.start(); // registers not-ready, like a study pod
    expect(await listReadyMembers(redis)).toEqual([]); // not an ownership candidate
    await reg.markReady(); // a live pod, by contrast, becomes eligible
    expect(await listReadyMembers(redis)).toEqual(['pod-1:42']);
    await reg.stop();
  });

  it('deletes its member key on stop (immediate deregister)', async () => {
    const redis = memRedis();
    const { reg, key } = build(redis);
    await reg.start();
    expect(redis.store.has(key)).toBe(true);
    await reg.stop();
    expect(redis.store.has(key)).toBe(false);
  });

  it('reflects the fleet count in the gauges', async () => {
    const redis = memRedis();
    const metrics = createMetricsRegistry({ service: 'test' });
    const reg = createMemberRegistry({
      redis,
      logger,
      id: 'pod-1:42',
      sha: 'deadbeef',
      bootedAt: '2026-07-08T00:00:00.000Z',
      metrics,
      refreshMs: 1_000_000,
    });
    await reg.start();
    await reg.markReady();
    const exposition = await metrics.metrics();
    expect(exposition).toMatch(/worker_members_total\{[^}]*\}\s+1/);
    expect(exposition).toMatch(/worker_members_ready\{[^}]*\}\s+1/);
    await reg.stop();
  });

  it('swallows a Redis error on beat (best-effort)', async () => {
    const redis = {
      set: () => Promise.reject(new Error('down')),
      del: () => Promise.resolve(1),
    } as unknown as Redis;
    const { reg } = build(redis);
    // Must not throw — boot never aborts on a heartbeat write failure.
    await expect(reg.start()).resolves.toBeUndefined();
    await reg.stop();
  });
});
