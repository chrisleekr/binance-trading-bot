// Two runtime pressures the worker cannot currently see. Queue backlog and pool
// exhaustion both present as "ticks are late", and without a series for either
// the operator is left guessing which one it is — the alert rules for both were
// removed precisely because nothing emitted them.
//
// Sampling reads BullMQ's and pg's own counters. Nothing here may take a
// lock-like Redis primitive: a sampler that needs one is a sampler that can
// block the thing it is measuring.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';

import { startRuntimeGauges } from '../../src/boot/runtime-gauges.js';

const stubLogger = (): Logger => ({ warn: vi.fn(), error: vi.fn() }) as unknown as Logger;

const setUp = (): {
  record: ReturnType<typeof vi.fn>;
  getWaitingCount: ReturnType<typeof vi.fn>;
  deps: Parameters<typeof startRuntimeGauges>[0];
} => {
  const record = vi.fn();
  const getWaitingCount = vi.fn(async () => 7);
  const deps = {
    queues: { tick: { getWaitingCount }, pipeline: { getWaitingCount } },
    pool: { idleCount: 3, totalCount: 10, waitingCount: 2 },
    metrics: { record, forget: vi.fn() },
    logger: stubLogger(),
  } as unknown as Parameters<typeof startRuntimeGauges>[0];
  return { record, getWaitingCount, deps };
};

/**
 * Matches on labels as well as name so a per-queue gauge cannot be read from
 * its sibling: `bullmq_queue_wait_jobs` is recorded once per queue, and a
 * name-only match would satisfy an assertion that one queue is absent with the
 * other queue's sample.
 */
const valueOf = (
  record: ReturnType<typeof vi.fn>,
  name: string,
  labels?: Record<string, string>,
): unknown =>
  record.mock.calls.find(
    (call) =>
      call[0] === name &&
      (labels === undefined ||
        Object.entries(labels).every(
          ([key, value]) => (call[2] as Record<string, string> | undefined)?.[key] === value,
        )),
  )?.[1];

describe('startRuntimeGauges', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('exports the waiting depth of each queue, labelled by queue', async () => {
    // Unlabelled, a single backlog number cannot say which queue is stuck, and a
    // stuck pipeline queue and a stuck tick queue need opposite responses.
    const { record, getWaitingCount, deps } = setUp();
    const timers = await startRuntimeGauges(deps);
    try {
      expect(valueOf(record, 'bullmq_queue_wait_jobs', { queue: 'tick' })).toBe(7);
      expect(valueOf(record, 'bullmq_queue_wait_jobs', { queue: 'pipeline' })).toBe(7);
      // BullMQ's own counter, so the sample cannot take a lock on the queue it
      // is measuring.
      expect(getWaitingCount).toHaveBeenCalled();
    } finally {
      timers.forEach((t) => clearInterval(t));
    }
  });

  it('survives a queue read that rejects, and still samples everything else', async () => {
    // The boot sample is awaited, so an unguarded rejection here fails worker
    // startup outright; on the interval it would surface as an unhandled
    // rejection instead. Either way a Redis blip during a measurement takes down
    // the process being measured, which inverts what a monitoring sampler is for.
    // The surviving queue and the pool gauges assert the failure stays local to
    // the queue that raised it rather than ending the pass.
    const { record, deps } = setUp();
    const boom = new Error('redis unreachable');
    const failing = { getWaitingCount: vi.fn(async () => Promise.reject(boom)) };
    const healthy = { getWaitingCount: vi.fn(async () => 4) };
    const withFailure = {
      ...deps,
      queues: { tick: failing, pipeline: healthy },
    } as unknown as Parameters<typeof startRuntimeGauges>[0];

    const timers = await startRuntimeGauges(withFailure);
    try {
      expect(valueOf(record, 'bullmq_queue_wait_jobs', { queue: 'tick' })).toBeUndefined();
      expect(valueOf(record, 'bullmq_queue_wait_jobs', { queue: 'pipeline' })).toBe(4);
      expect(valueOf(record, 'pg_pool_waiting')).toBe(2);
      // The per-queue message, not just "some warning": the pass-level catch
      // logs its own, so an assertion that only counts calls cannot tell a
      // failure contained to one queue from one that ended the whole pass.
      expect(withFailure.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ queue: 'tick' }),
        'runtime gauge: queue depth sample failed',
      );
    } finally {
      timers.forEach((t) => clearInterval(t));
    }
  });

  it('exports the Postgres pool as idle, total and waiting', async () => {
    // `waiting` is the one that means trouble: clients blocked with no connection
    // to give them. The idle/total pair is the context that says whether the pool
    // is small or simply busy.
    const { record, deps } = setUp();
    const timers = await startRuntimeGauges(deps);
    try {
      expect(valueOf(record, 'pg_pool_idle')).toBe(3);
      expect(valueOf(record, 'pg_pool_total')).toBe(10);
      expect(valueOf(record, 'pg_pool_waiting')).toBe(2);
    } finally {
      timers.forEach((t) => clearInterval(t));
    }
  });

  it('keeps sampling on the interval, reading the pool live rather than the boot snapshot', async () => {
    // Every assertion above is satisfied by the single boot sample, so deleting
    // the interval outright would leave them green — and four gauges frozen at
    // their start-up values for the life of the process. A gauge that stops being
    // written keeps exporting its last reading, so QueueBacklog and DBPoolStarved
    // would then watch a number that can no longer move.
    vi.useFakeTimers();
    const { record, deps } = setUp();
    const timers = await startRuntimeGauges(deps);
    try {
      const atBoot = record.mock.calls.length;
      (deps.pool as { waitingCount: number }).waitingCount = 9;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(record.mock.calls.length).toBeGreaterThan(atBoot);
      // The LAST reading, not the first: the boot pass already recorded 2, so
      // only the newest sample can show the getter was re-read.
      const waiting = record.mock.calls.filter((call) => call[0] === 'pg_pool_waiting');
      expect(waiting.at(-1)?.[1]).toBe(9);
    } finally {
      timers.forEach((t) => clearInterval(t));
    }
  });

  it('logs and keeps running when a pool write throws on the interval', async () => {
    // The interval discards the promise, so a throw past the boot sample becomes
    // an unhandled rejection and Node ends the process by default. That is the
    // one failure a monitoring sampler must never cause: the worker would die of
    // being watched, losing in-flight tick work for a reason unrelated to trading.
    vi.useFakeTimers();
    const { record, deps } = setUp();
    let booted = false;
    record.mockImplementation((name: string) => {
      if (booted && name === 'pg_pool_idle') throw new Error('registry closed');
    });
    const timers = await startRuntimeGauges(deps);
    try {
      booted = true;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'runtime gauge: sample pass failed',
      );
    } finally {
      timers.forEach((t) => clearInterval(t));
    }
  });

  it('logs and still starts when a pool write throws on the boot pass', async () => {
    // The boot pass is awaited by the worker's startup path, so an unguarded
    // throw here does not merely lose a sample: `startRuntimeGauges` rejects,
    // boot fails, and the worker will not trade because a gauge about itself
    // could not be written. Only the queue reads were guarded at boot, so this
    // is the half the interval test above cannot reach — it arms after boot.
    const { record, deps } = setUp();
    record.mockImplementation((name: string) => {
      if (name === 'pg_pool_idle') throw new Error('registry closed');
    });

    const timers = await startRuntimeGauges(deps);
    try {
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'runtime gauge: boot sample failed',
      );
    } finally {
      timers.forEach((t) => clearInterval(t));
    }
  });
});
