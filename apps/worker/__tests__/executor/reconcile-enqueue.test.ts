import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { Redis } from 'ioredis';

import { asProfileId } from '@app/contracts';

import {
  createThrottledReconcileEnqueue,
  RECONCILE_THROTTLE_KEY_PREFIX,
  RECONCILE_THROTTLE_MS,
} from '../../src/executor/reconcile-enqueue.js';

const PROFILE = asProfileId('00000000-0000-0000-0000-0000000000bb');
const INPUT = { profileId: PROFILE, symbol: 'WLDUSDT', cause: 'place-2010-insufficient' } as const;

/**
 * A Redis stub with REAL `SET NX PX` semantics: the second setter of a live key
 * gets `null` back, not an error and not a throw. That null return is the whole
 * hazard — an unchecked `await` reads it as success and the throttle silently
 * stops throttling.
 */
const nxRedis = (): Redis => {
  const keys = new Set<string>();
  return {
    set: vi.fn(async (key: string, _v: string, _px: string, _ttl: number, _nx: string) => {
      if (keys.has(key)) return null;
      keys.add(key);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => (keys.delete(key) ? 1 : 0)),
  } as unknown as Redis;
};

const silent = pino({ level: 'silent' });

describe('createThrottledReconcileEnqueue', () => {
  it('collapses a per-tick -2010 storm for one (profile, symbol) into ONE enqueue per window', async () => {
    // The live failure mode this exists for: a protective stop whose base asset is
    // locked in a resting manual order is refused -2010 once or twice a SECOND, for
    // days. The queue's jobId coalescing does not bound that (the slot reopens as
    // soon as the job reaches a terminal state), so each repeat would mint a fresh
    // converge pass costing a getAccount + getMyTrades against the shared per-IP
    // weight budget.
    const redis = nxRedis();
    const enqueue = vi.fn(async () => true);
    const throttled = createThrottledReconcileEnqueue({ redis, logger: silent, enqueue });

    for (let i = 0; i < 50; i += 1) await throttled(INPUT);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      `${RECONCILE_THROTTLE_KEY_PREFIX}${PROFILE}:WLDUSDT:place-2010-insufficient`,
      '1',
      'PX',
      RECONCILE_THROTTLE_MS,
      'NX',
    );
  });

  it('a SET NX that LOSES the race returns null — which must not read as success', async () => {
    // ioredis returns `null`, not an error, when NX loses. Pin the null branch
    // explicitly: a stub that always says OK cannot catch a missing check.
    const redis = { set: vi.fn(async () => null) } as unknown as Redis;
    const enqueue = vi.fn(async () => true);
    const throttled = createThrottledReconcileEnqueue({ redis, logger: silent, enqueue });

    await throttled(INPUT);

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('windows are per (profile, symbol, cause) — a different symbol or cause is not suppressed', async () => {
    const redis = nxRedis();
    const enqueue = vi.fn(async () => true);
    const throttled = createThrottledReconcileEnqueue({ redis, logger: silent, enqueue });

    await throttled(INPUT);
    await throttled({ ...INPUT, symbol: 'ENAUSDT' });
    await throttled({ ...INPUT, cause: 'cancel-2011-fill' });
    await throttled(INPUT);

    expect(enqueue).toHaveBeenCalledTimes(3);
  });

  it('FAILS OPEN on a Redis fault: an extra reconcile beats a dropped one', async () => {
    // Losing a reconcile leaves a position mis-stated — the exact bug this whole
    // seam exists to fix. Paying for a duplicate converge pass is the cheaper error.
    const redis = {
      set: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    } as unknown as Redis;
    const enqueue = vi.fn(async () => true);
    const throttled = createThrottledReconcileEnqueue({ redis, logger: silent, enqueue });

    await throttled(INPUT);

    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('is deadline-bounded: a stalled Redis cannot hang the tick that called it', async () => {
    // This runs on the place-order error path, inside the tick. The executor's
    // ioredis has no command timeout, so a reachable-but-stalled Redis would
    // otherwise stretch the whole tick.
    const redis = { set: vi.fn(() => new Promise(() => undefined)) } as unknown as Redis;
    const enqueue = vi.fn(async () => true);
    const throttled = createThrottledReconcileEnqueue({ redis, logger: silent, enqueue });

    const started = Date.now();
    await throttled(INPUT);

    expect(Date.now() - started).toBeLessThan(3_000);
    // Timed out ⇒ fail open.
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('a STALLED enqueue is deadline-bounded — it cannot hang the chain lock', async () => {
    // The throttle's SET is bounded, but the `queue.add` it guards is a SECOND
    // Redis round-trip, awaited inside the tick's chainByKey critical section. An
    // unbounded one hangs that (profile, symbol) chain forever, not just this tick.
    const redis = nxRedis();
    const enqueue = vi.fn(() => new Promise<boolean>(() => undefined));
    const throttled = createThrottledReconcileEnqueue({ redis, logger: silent, enqueue });

    const started = Date.now();
    await throttled(INPUT);

    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('a TIMED-OUT enqueue does NOT release the window — the add may still land', async () => {
    // The deadline ABANDONS the write, it does not cancel it, so a timeout is
    // "unknown", not "did not happen". Releasing here would let a Redis that is
    // merely slower than the 500ms deadline re-enqueue on EVERY tick for a symbol
    // failing -2010 once a second — restoring the exact request-weight treadmill
    // this module exists to prevent, under the very fault it was written to
    // survive. The 15-min backstop cron is the fail-open path instead.
    const redis = nxRedis();
    const enqueue = vi.fn(() => new Promise<boolean>(() => undefined));
    const throttled = createThrottledReconcileEnqueue({ redis, logger: silent, enqueue });

    await throttled(INPUT);

    expect(redis.del).not.toHaveBeenCalled();

    // And the window is still shut, so the next tick is suppressed rather than
    // piling a second add on top of an add that may yet land.
    await throttled(INPUT);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('a THROWING enqueue releases the window, so the next tick re-attempts', async () => {
    // The window opens BEFORE the enqueue, because the enqueue is what it exists to
    // suppress. If the enqueue never lands, holding the window for 60s would drop
    // the next tick's discovery for a job that does not exist.
    const redis = nxRedis();
    const enqueue = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('queue.add failed'))
      .mockResolvedValueOnce(true);
    const throttled = createThrottledReconcileEnqueue({ redis, logger: silent, enqueue });

    await throttled(INPUT);
    await throttled(INPUT);

    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('an enqueue that throws SYNCHRONOUSLY also releases the window', async () => {
    // The rejection case above is the one the old bare-promise call already handled. A
    // BullMQ `queue.add` on a closed connection throws before it returns a promise, and
    // that shape used to escape the deadline guard and fail the tick outright — leaving
    // the 60s window CLOSED behind it, so the symbol went unreconciled for a full minute
    // on top of the failed tick. NOT async: async would make it the rejection above.
    const redis = nxRedis();
    let calls = 0;
    const enqueue = vi.fn((): Promise<boolean> => {
      calls += 1;
      if (calls === 1) throw new Error('Connection is closed');
      return Promise.resolve(true);
    });
    const throttled = createThrottledReconcileEnqueue({ redis, logger: silent, enqueue });

    await expect(throttled(INPUT)).resolves.toBeUndefined();
    await throttled(INPUT);

    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('an enqueue that DECLINES (profile went inactive) releases the window', async () => {
    // The production closure returns `false` when the profile is no longer active:
    // it resolves without adding a job. Resolving is not landing — holding the
    // window for a job that does not exist would drop the next tick's discovery.
    const redis = nxRedis();
    const enqueue = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const throttled = createThrottledReconcileEnqueue({ redis, logger: silent, enqueue });

    await throttled(INPUT);
    await throttled(INPUT);

    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('an enqueue that LANDS holds the window — no needless release', async () => {
    const redis = nxRedis();
    const enqueue = vi.fn(async () => true);
    const throttled = createThrottledReconcileEnqueue({ redis, logger: silent, enqueue });

    await throttled(INPUT);
    await throttled(INPUT);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(redis.del).not.toHaveBeenCalled();
  });
});
