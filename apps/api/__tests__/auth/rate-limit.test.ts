import { connect, createServer, type Server, type Socket } from 'node:net';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createMemoryRateLimiter,
  createRedisRateLimiter,
  type RateLimiter,
} from '../../src/auth/rate-limit.js';
import { createSecurityRedis } from '../../src/auth/security.js';

import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const logger = pino({ level: 'silent' });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('memory rate limiter (the fallback while Redis is unreachable)', () => {
  it('halves the allowance, because each replica holds its own copy', async () => {
    let t = 0;
    const limiter = createMemoryRateLimiter(() => t);
    const rate = { limit: 4, periodMs: 1000 };
    expect((await limiter.consume('k', rate)).allowed).toBe(true);
    expect((await limiter.consume('k', rate)).allowed).toBe(true);
    const refused = await limiter.consume('k', rate);
    expect(refused).toEqual({ allowed: false, retryAfterMs: 500 });
    t = 500;
    expect((await limiter.consume('k', rate)).allowed).toBe(true);
  });

  it('never grows past its key cap, dropping the oldest entries', async () => {
    const limiter = createMemoryRateLimiter(() => 0);
    const rate = { limit: 2, periodMs: 60_000 };
    expect((await limiter.consume('first', rate)).allowed).toBe(true);
    expect((await limiter.consume('first', rate)).allowed).toBe(false);
    for (let i = 0; i < 50_000; i += 1) await limiter.consume(`flood-${i}`, rate);
    // `first` was the oldest entry, so the cap evicted it and it starts fresh.
    expect((await limiter.consume('first', rate)).allowed).toBe(true);
  });

  it('flags are set once and expire; counters reset after their window', async () => {
    let t = 0;
    const limiter = createMemoryRateLimiter(() => t);
    expect(await limiter.setFlag('f', 100)).toBe(true);
    expect(await limiter.setFlag('f', 100)).toBe(false);
    expect(await limiter.flagRemainingMs('f')).toBe(100);
    expect(await limiter.countWithin('c', 100)).toBe(1);
    expect(await limiter.countWithin('c', 100)).toBe(2);
    t = 100;
    expect(await limiter.flagRemainingMs('f')).toBe(0);
    expect(await limiter.countWithin('c', 100)).toBe(1);
  });

  it('clearPrefix removes every entry under the prefix and nothing else', async () => {
    const limiter = createMemoryRateLimiter(() => 0);
    await limiter.setFlag('auth:block:ip:v4:1.2.3.4', 1000);
    await limiter.consume('auth:gcra:sign-in:ip:v4:1.2.3.4', { limit: 2, periodMs: 1000 });
    await limiter.countWithin('auth:block:trips:v4:1.2.3.4', 1000);
    await limiter.setFlag('auth:lock:email:x', 1000);
    await limiter.clearPrefix('auth:block:');
    await limiter.clearPrefix('auth:gcra:sign-in:ip:');
    expect(await limiter.flagRemainingMs('auth:block:ip:v4:1.2.3.4')).toBe(0);
    expect(await limiter.countWithin('auth:block:trips:v4:1.2.3.4', 1000)).toBe(1);
    expect(await limiter.flagRemainingMs('auth:lock:email:x')).toBeGreaterThan(0);
  });

  it('extendFlag resets a live flag and never recreates an expired one', async () => {
    let t = 0;
    const limiter = createMemoryRateLimiter(() => t);
    await limiter.setFlag('f', 100);
    await limiter.extendFlag('f', 500);
    expect(await limiter.flagRemainingMs('f')).toBe(500);
    t = 600;
    await limiter.extendFlag('f', 500);
    expect(await limiter.flagRemainingMs('f')).toBe(0);
  });
});

describe("the sign-in system's Redis connection", () => {
  it('fails over at once while Redis is unreachable, instead of waiting for a reconnect', async () => {
    // Nothing listens on port 1, so every connect attempt is refused.
    const unreachable = createSecurityRedis('redis://127.0.0.1:1');
    const errors: unknown[] = [];
    const limiter = createRedisRateLimiter(unreachable, (err) => errors.push(err), logger);
    try {
      // By the third reconnect the retry delay has grown to hundreds of milliseconds, which a queued command would wait out.
      await new Promise<void>((resolve) => {
        let reconnects = 0;
        unreachable.on('reconnecting', () => {
          reconnects += 1;
          if (reconnects === 3) resolve();
        });
      });
      const started = Date.now();
      const decision = await limiter.consume('k', { limit: 2, periodMs: 60_000 });
      expect(Date.now() - started).toBeLessThan(100);
      expect(decision.allowed).toBe(true);
      expect(errors).toHaveLength(1);
    } finally {
      unreachable.disconnect();
    }
  });
});

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('Redis GCRA rate limiter', () => {
  let fx: ApiFixture;
  let redis: Redis;
  let limiter: RateLimiter;
  const backendErrors: unknown[] = [];

  beforeAll(async () => {
    fx = await setupApp();
    redis = new Redis(fx.redisUrl);
    limiter = createRedisRateLimiter(redis, (err) => backendErrors.push(err), logger);
  });
  afterAll(async () => {
    await redis.quit();
    await fx.cleanup();
  });

  it('allows the whole allowance as a burst, then refuses with the exact wait for the next unit', async () => {
    const rate = { limit: 3, periodMs: 300 };
    for (let i = 0; i < 3; i += 1)
      expect((await limiter.consume('gcra:burst', rate)).allowed).toBe(true);
    const refused = await limiter.consume('gcra:burst', rate);
    expect(refused.allowed).toBe(false);
    // One emission interval is period / limit = 100 ms.
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(100);
  });

  it('refills one unit per interval rather than a whole window at once (no boundary burst)', async () => {
    const rate = { limit: 3, periodMs: 300 };
    for (let i = 0; i < 3; i += 1) await limiter.consume('gcra:refill', rate);
    await sleep(120);
    expect((await limiter.consume('gcra:refill', rate)).allowed).toBe(true);
    // A fixed window would hand back all three here; GCRA has earned only one.
    expect((await limiter.consume('gcra:refill', rate)).allowed).toBe(false);
  });

  it('a refused request does not consume, and each key expires on its own', async () => {
    const rate = { limit: 1, periodMs: 200 };
    expect((await limiter.consume('gcra:ttl', rate)).allowed).toBe(true);
    for (let i = 0; i < 5; i += 1)
      expect((await limiter.consume('gcra:ttl', rate)).allowed).toBe(false);
    const ttl = await redis.pttl('gcra:ttl');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(200);
    await sleep(220);
    expect(await redis.exists('gcra:ttl')).toBe(0);
    expect((await limiter.consume('gcra:ttl', rate)).allowed).toBe(true);
  });

  it('extendFlag resets the time left on a set flag and leaves an absent one absent', async () => {
    await limiter.setFlag('gcra:extend', 1000);
    await limiter.extendFlag('gcra:extend', 60_000);
    expect(await redis.pttl('gcra:extend')).toBeGreaterThan(50_000);
    await limiter.extendFlag('gcra:extend-absent', 60_000);
    expect(await redis.exists('gcra:extend-absent')).toBe(0);
    await limiter.clear(['gcra:extend']);
  });

  it('a stalled Redis reply times out on the sign-in connection and falls back within a second', async () => {
    const upstream = new URL(fx.redisUrl);
    let stalled = false;
    const sockets: Socket[] = [];
    // A proxy that can stop forwarding: the connection stays open and ready, but no reply arrives, which only a command timeout can bound.
    const proxy: Server = createServer((client) => {
      const server = connect(Number(upstream.port || 6379), upstream.hostname);
      sockets.push(client, server);
      client.on('error', () => {});
      server.on('error', () => {});
      server.pipe(client);
      client.on('data', (chunk) => {
        if (!stalled) server.write(chunk);
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const { port } = proxy.address() as { port: number };
    const connection = createSecurityRedis(`redis://127.0.0.1:${port}${upstream.pathname}`);
    const errors: unknown[] = [];
    const guarded = createRedisRateLimiter(connection, (err) => errors.push(err), logger);
    try {
      await new Promise<void>((resolve) => connection.once('ready', () => resolve()));
      const rate = { limit: 2, periodMs: 60_000 };
      expect((await guarded.consume('gcra:stall', rate)).allowed).toBe(true);
      expect(errors).toEqual([]);
      stalled = true;
      const started = Date.now();
      expect((await guarded.consume('gcra:stall', rate)).allowed).toBe(true);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(errors).toHaveLength(1);
      expect(String(errors[0])).toMatch(/timed out/i);
    } finally {
      connection.disconnect();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await redis.del('gcra:stall');
    }
  });

  it('setFlag reports only the first setter; countWithin expires after its first increment; clear removes keys', async () => {
    expect(await limiter.setFlag('gcra:flag', 5000)).toBe(true);
    expect(await limiter.setFlag('gcra:flag', 5000)).toBe(false);
    expect(await limiter.flagRemainingMs('gcra:flag')).toBeGreaterThan(4000);
    expect(await limiter.flagRemainingMs('gcra:absent')).toBe(0);
    expect(await limiter.countWithin('gcra:count', 5000)).toBe(1);
    expect(await limiter.countWithin('gcra:count', 5000)).toBe(2);
    expect(await redis.pttl('gcra:count')).toBeGreaterThan(0);
    await limiter.clear(['gcra:flag', 'gcra:count']);
    expect(await limiter.flagRemainingMs('gcra:flag')).toBe(0);
    expect(backendErrors).toEqual([]);
  });

  it('clearPrefix deletes every matching key across several SCAN pages and leaves the rest', async () => {
    // More keys than one SCAN page returns, so a loop that stopped after the first cursor would leave some behind.
    const pipeline = redis.pipeline();
    for (let i = 0; i < 1200; i += 1) pipeline.set(`prefix-test:block:${i}`, '1', 'PX', 60_000);
    pipeline.set('prefix-test:keep', '1', 'PX', 60_000);
    await pipeline.exec();
    await limiter.clearPrefix('prefix-test:block:');
    expect(await redis.keys('prefix-test:block:*')).toEqual([]);
    expect(await redis.exists('prefix-test:keep')).toBe(1);
    await redis.del('prefix-test:keep');
  });

  it('falls back to the in-process limiter when Redis fails, reporting every fallback, and never throws', async () => {
    const dead = new Redis(fx.redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    });
    const errors: unknown[] = [];
    const fallback = createRedisRateLimiter(dead, (err) => errors.push(err), logger);
    const rate = { limit: 2, periodMs: 60_000 };
    // Halved to one in the fallback.
    expect((await fallback.consume('k', rate)).allowed).toBe(true);
    expect((await fallback.consume('k', rate)).allowed).toBe(false);
    expect(await fallback.setFlag('f', 1000)).toBe(true);
    expect(errors.length).toBe(3);
    dead.disconnect();
  });
});
