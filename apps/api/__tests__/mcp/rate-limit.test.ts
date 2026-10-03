// The per-operator request budget in front of the MCP endpoint, shared by every approved agent.
//
// The budget is the only throttle on an internet-reachable surface that places real orders, and its failure mode is the interesting part: it lives in Redis, and so do the idempotency records. A Redis outage is therefore the one moment the limit has to keep holding rather than quietly stop, which is why these cases compare the two paths against each other instead of pinning a number.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DI } from '../../src/di.js';
import { consumeRateLimit } from '../../src/routes/mcp.js';

type Reply = [Error | null, unknown];

/**
 * A Redis whose MULTI resolves to the replies a scripted `exec` returns.
 *
 * @param exec - Produces the transaction result from the queued commands, in queue order.
 * @param onIncr - Reply for an INCR on the given key when the queued command runs.
 * @param onExpire - Reply for an EXPIRE on the given key and TTL seconds when the queued command runs.
 * @returns A client exposing only the `multi().incr().expire().exec()` chain the limiter uses.
 */
const transactionalRedis = (
  exec: (queued: ReadonlyArray<() => Reply>) => Promise<Reply[] | null>,
  onIncr: (key: string) => Reply,
  onExpire: (key: string, seconds: number) => Reply,
) => ({
  multi: () => {
    const queued: Array<() => Reply> = [];
    const chain = {
      incr: (key: string) => {
        queued.push(() => onIncr(key));
        return chain;
      },
      expire: (key: string, seconds: number) => {
        queued.push(() => onExpire(key, seconds));
        return chain;
      },
      exec: () => exec(queued),
    };
    return chain;
  },
});

/** A Redis that counts the way `INCR` does, so the healthy path is exercised against real fixed-window semantics rather than a stub that always answers yes. It also records every EXPIRE so the TTL can be asserted. */
const healthyRedis = () => {
  const counts = new Map<string, number>();
  const expires: Array<[string, number]> = [];
  const client = transactionalRedis(
    async (queued) => queued.map((run) => run()),
    (key) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return [null, next];
    },
    (key, seconds) => {
      expires.push([key, seconds]);
      return [null, 1];
    },
  );
  return { ...client, expires };
};

/** A Redis that cannot be reached: the transaction rejects, which is what an ioredis client does once its connection is gone. */
const downRedis = () =>
  transactionalRedis(
    async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    },
    () => [null, 1],
    () => [null, 1],
  );

const INCR_FAULT = new Error('OOM command not allowed when used memory > maxmemory');

/** A Redis that accepts the transaction but fails the INCR inside it. ioredis resolves such a transaction and puts the error in the reply slot, so nothing rejects. */
const incrFaultRedis = () =>
  transactionalRedis(
    async (queued) => queued.map((run) => run()),
    () => [INCR_FAULT, null],
    () => [null, 1],
  );

/** A Redis whose transaction was discarded, which ioredis reports by resolving `exec` to null. */
const discardedRedis = () =>
  transactionalRedis(
    async () => null,
    () => [null, 1],
    () => [null, 1],
  );

const diWith = (redis: unknown): DI =>
  ({ redis: { raw: () => redis }, logger: { warn: vi.fn() } }) as unknown as DI;

/**
 * Spends one identity's budget until the first refusal.
 *
 * @param di - Container whose Redis decides which path is taken.
 * @param operatorId - Identity to charge, unique per case because the outage fallback is held per process.
 * @returns The 1-based index of the first refused call, or -1 when nothing was refused within the probe.
 */
const firstRefusal = async (di: DI, operatorId: string): Promise<number> => {
  for (let call = 1; call <= 1000; call += 1) {
    if (!(await consumeRateLimit(di, operatorId))) return call;
  }
  return -1;
};

describe('MCP per-operator rate limit', () => {
  beforeEach(() => {
    // Pinned to the middle of a window, so a real minute boundary cannot land inside a case and hand it a fresh budget halfway through.
    vi.useFakeTimers({ now: new Date('2026-09-15T10:00:30.000Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a caller once its budget is spent while Redis is up', async () => {
    // The discriminating half for the outage case below: a limit that never refused anyone would make "the same index on both paths" hold trivially at -1.
    expect(await firstRefusal(diWith(healthyRedis()), 'op-healthy')).toBeGreaterThan(1);
  });

  it('gives the counter key a TTL of one window in the same transaction', async () => {
    // A key without a TTL outlives its window forever, one per operator per minute, so the expiry is the half of the pair that keeps Redis bounded.
    const redis = healthyRedis();
    expect(await consumeRateLimit(diWith(redis), 'op-ttl')).toBe(true);
    expect(redis.expires).toEqual([[expect.stringMatching(/^mcp:rate:op-ttl:\d+$/), 60]]);
  });

  it('keeps the same budget while Redis is down, rather than waving every call through', async () => {
    const healthy = await firstRefusal(diWith(healthyRedis()), 'op-compare-healthy');
    const outage = await firstRefusal(diWith(downRedis()), 'op-compare-outage');
    // Compared against the healthy path rather than against a number, so a change to the budget moves both sides together and only a fallback that stopped counting fails.
    expect(outage).not.toBe(-1);
    expect(outage).toBe(healthy);
  });

  it('logs the outage it is metering through', async () => {
    // The fallback is looser than the shared limit across replicas, so an operator has to be able to see it is in force.
    const di = diWith(downRedis());
    await consumeRateLimit(di, 'op-logged');
    expect(di.logger.warn).toHaveBeenCalledWith(expect.anything(), 'mcp_rate_limit_unavailable');
  });

  it('meters through the fallback when the INCR inside the transaction fails', async () => {
    // ioredis resolves this transaction instead of rejecting it, so a reader that only caught a rejection would take the error slot's empty value as a count.
    const healthy = await firstRefusal(diWith(healthyRedis()), 'op-incr-healthy');
    const di = diWith(incrFaultRedis());
    const faulted = await firstRefusal(di, 'op-incr-fault');
    expect(faulted).not.toBe(-1);
    expect(faulted).toBe(healthy);
    // The Redis error itself is what gets logged, so the warning names the real fault rather than a symptom of reading past it.
    expect(di.logger.warn).toHaveBeenCalledWith({ err: INCR_FAULT }, 'mcp_rate_limit_unavailable');
  });

  it('meters through the fallback when the transaction is discarded', async () => {
    const healthy = await firstRefusal(diWith(healthyRedis()), 'op-discard-healthy');
    const discarded = await firstRefusal(diWith(discardedRedis()), 'op-discard');
    expect(discarded).not.toBe(-1);
    expect(discarded).toBe(healthy);
  });

  it('gives an identity a fresh budget in the next window during an outage', async () => {
    const di = diWith(downRedis());
    const spentAt = await firstRefusal(di, 'op-window');
    expect(spentAt).toBeGreaterThan(1);
    // Still refused inside the same window: the fallback remembers the count rather than restarting it on every call.
    expect(await consumeRateLimit(di, 'op-window')).toBe(false);
    vi.advanceTimersByTime(60_000);
    // A fallback that never let the count go would lock the agent out for the rest of the outage, which is the opposite failure and just as wrong.
    expect(await consumeRateLimit(di, 'op-window')).toBe(true);
  });

  it('charges each identity its own budget during an outage', async () => {
    const di = diWith(downRedis());
    expect(await firstRefusal(di, 'op-spender')).toBeGreaterThan(1);
    // One runaway agent exhausting its budget must not refuse a different token.
    expect(await consumeRateLimit(di, 'op-bystander')).toBe(true);
  });
});
