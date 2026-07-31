// Redis weight-governor unit tests.
//
// These exercise the JS orchestration — band computation, the retry loop, the
// fail-open / fail-closed split, and abort — against a fake `eval`. The Lua
// token-bucket math itself is covered by the real-Redis integration test in
// apps/worker/__tests__/integration/redis-weight-governor.test.ts.

import { describe, expect, it, vi } from 'vitest';

import {
  createRedisWeightGovernor,
  RedisUnavailableError,
  type RedisEvalClient,
} from '../../src/rate-limit/redis-weight-governor.js';

const fakeClock = (start = 1_000_000_000_000): { nowMs(): number; advance(ms: number): void } => {
  let now = start;
  return {
    nowMs: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

type Reply = [number, number, number];
type Entry = Reply | { rejectWith: unknown };

/** Fake Redis whose `eval` returns queued replies (or rejects a queued value). */
const fakeRedis = (replies: Entry[]): RedisEvalClient & { calls: (string | number)[][] } => {
  const calls: (string | number)[][] = [];
  return {
    calls,
    eval: (_script: string, _numKeys: number, ...args: (string | number)[]) => {
      calls.push(args);
      const next = replies.shift();
      if (!next) throw new Error('fakeRedis: no reply queued');
      if (!Array.isArray(next)) return Promise.reject(next.rejectWith);
      return Promise.resolve(next);
    },
  };
};

const noopLogger = (): { warn: ReturnType<typeof vi.fn> } => ({ warn: vi.fn() });

describe('createRedisWeightGovernor', () => {
  it('reports the configured ceiling', () => {
    const g = createRedisWeightGovernor({
      budget: 1000,
      targetUtilisation: 0.8,
      redis: fakeRedis([]),
      logger: noopLogger(),
    });
    expect(g.ceiling()).toBe(800);
  });

  describe('input validation', () => {
    it.each([-1, Number.NaN])('rejects cost %p as non-negative', async (cost) => {
      const g = createRedisWeightGovernor({ redis: fakeRedis([]), logger: noopLogger() });
      await expect(g.reserve(cost)).rejects.toThrow(/non-negative/);
    });

    it('rejects a cost above the soft ceiling', async () => {
      const g = createRedisWeightGovernor({
        budget: 100,
        redis: fakeRedis([]),
        logger: noopLogger(),
      });
      // budget 100 * 0.8 = ceiling 80.
      await expect(g.reserve(81)).rejects.toThrow(/exceeds soft ceiling/);
    });
  });

  describe('admission', () => {
    it('admits immediately when the bucket has headroom', async () => {
      const redis = fakeRedis([[1, 0, 2]]);
      const g = createRedisWeightGovernor({
        budget: 1000,
        clock: fakeClock(),
        redis,
        logger: noopLogger(),
      });
      await g.reserve(2);
      expect(g.used()).toBe(2);
      expect(redis.calls).toHaveLength(1);
    });

    it('passes the full ceiling as the limit for a priority call', async () => {
      const redis = fakeRedis([[1, 0, 2]]);
      const g = createRedisWeightGovernor({
        budget: 1000,
        orderReserve: 8,
        clock: fakeClock(),
        redis,
        logger: noopLogger(),
      });
      await g.reserve(2, { priority: true });
      // eval args: [key, now, cost, limit, refillPerMs, ttlMs] → limit at [3].
      expect(redis.calls[0]?.[3]).toBe(800);
    });

    it('reserves the order band for a bulk call (limit = ceiling - orderReserve)', async () => {
      const redis = fakeRedis([[1, 0, 2]]);
      const g = createRedisWeightGovernor({
        budget: 1000,
        orderReserve: 8,
        clock: fakeClock(),
        redis,
        logger: noopLogger(),
      });
      await g.reserve(2);
      expect(redis.calls[0]?.[3]).toBe(792);
    });

    it('waits then retries when the bucket is full', async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      const redis = fakeRedis([
        [0, 250, 800],
        [1, 0, 2],
      ]);
      const g = createRedisWeightGovernor({
        budget: 1000,
        clock: fakeClock(),
        sleep,
        redis,
        logger: noopLogger(),
      });
      await g.reserve(2);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(250);
      expect(redis.calls).toHaveLength(2);
    });

    it('uses the injected key and default key', async () => {
      const redis = fakeRedis([[1, 0, 2]]);
      const g = createRedisWeightGovernor({
        redis,
        logger: noopLogger(),
        key: 'binance:weight:acct-1',
      });
      await g.reserve(1);
      expect(redis.calls[0]?.[0]).toBe('binance:weight:acct-1');

      const redis2 = fakeRedis([[1, 0, 1]]);
      const g2 = createRedisWeightGovernor({ redis: redis2, logger: noopLogger() });
      await g2.reserve(1);
      expect(redis2.calls[0]?.[0]).toBe('binance:weight:master');
    });
  });

  describe('fail-mode on Redis-unavailable', () => {
    it('priority calls fail open via the local backstop and log (Error cause)', async () => {
      const logger = noopLogger();
      const g = createRedisWeightGovernor({
        budget: 1000,
        clock: fakeClock(),
        redis: fakeRedis([{ rejectWith: new Error('ECONNREFUSED') }]),
        logger,
      });
      // Resolves despite Redis being down (protective SELL must not hostage).
      await expect(g.reserve(2, { priority: true })).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.warn.mock.calls[0]?.[1]).toMatch(/local backstop/);
    });

    it('bulk calls fail closed with RedisUnavailableError and log (non-Error cause)', async () => {
      const logger = noopLogger();
      const g = createRedisWeightGovernor({
        budget: 1000,
        clock: fakeClock(),
        // A non-Error rejection exercises the String(err) log path.
        redis: fakeRedis([{ rejectWith: 'connection reset' }]),
        logger,
      });
      await expect(g.reserve(2)).rejects.toBeInstanceOf(RedisUnavailableError);
      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.warn.mock.calls[0]?.[1]).toMatch(/fail-closed/);
    });

    it('bounds a hung round-trip: bulk times out and fails closed', async () => {
      // eval never settles — models ioredis queueing the command on an outage.
      const hangingRedis: RedisEvalClient = { eval: () => new Promise<never>(() => undefined) };
      const g = createRedisWeightGovernor({
        budget: 1000,
        clock: fakeClock(),
        evalTimeoutMs: 10,
        redis: hangingRedis,
        logger: noopLogger(),
      });
      await expect(g.reserve(2)).rejects.toBeInstanceOf(RedisUnavailableError);
    });

    it('bounds a hung round-trip: priority times out and fails open', async () => {
      const logger = noopLogger();
      const hangingRedis: RedisEvalClient = { eval: () => new Promise<never>(() => undefined) };
      const g = createRedisWeightGovernor({
        budget: 1000,
        clock: fakeClock(),
        evalTimeoutMs: 10,
        redis: hangingRedis,
        logger,
      });
      // A protective SELL admits via the backstop within the timeout, not after
      // ioredis's tens-of-seconds reconnect storm.
      await expect(g.reserve(2, { priority: true })).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledOnce();
    });
  });

  describe('abort', () => {
    it('rejects immediately when the signal is already aborted', async () => {
      const g = createRedisWeightGovernor({ redis: fakeRedis([]), logger: noopLogger() });
      const ac = new AbortController();
      ac.abort();
      await expect(g.reserve(2, { signal: ac.signal })).rejects.toThrow(/aborted/);
    });

    it('rejects when aborted during the Redis round-trip (before the wait)', async () => {
      // Aborts synchronously, so the signal is already aborted by the time the
      // wait begins — exercises the up-front guard, not the race.
      const sleep = (): Promise<void> => new Promise<void>(() => undefined);
      const ac = new AbortController();
      const g = createRedisWeightGovernor({
        budget: 1000,
        clock: fakeClock(),
        sleep,
        redis: fakeRedis([[0, 10_000, 800]]),
        logger: noopLogger(),
      });
      const waiting = g.reserve(2, { signal: ac.signal });
      ac.abort();
      await expect(waiting).rejects.toThrow(/aborted/);
    });

    it('rejects when aborted during an active wait (race branch)', async () => {
      const ac = new AbortController();
      // Not aborted at entry to the wait; fire the abort once sleep engages so
      // the Promise.race is settled by the abort branch.
      const sleep = (): Promise<void> => {
        queueMicrotask(() => ac.abort());
        return new Promise<void>(() => undefined);
      };
      const g = createRedisWeightGovernor({
        budget: 1000,
        clock: fakeClock(),
        sleep,
        redis: fakeRedis([[0, 10_000, 800]]),
        logger: noopLogger(),
      });
      await expect(g.reserve(2, { signal: ac.signal })).rejects.toThrow(/aborted/);
    });
  });
});
