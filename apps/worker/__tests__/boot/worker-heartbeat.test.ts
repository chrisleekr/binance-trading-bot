// The `worker:status` heartbeat is the api's signal for api/worker code skew;
// `worker:study-status` is the study worker's liveness. In prod (and `bun run
// dev`) the live and study workers are separate processes writing separate
// keys, so neither clobbers the other. `advisor:ready` tracks the live DB
// provider config: the study worker sets it while a provider is usable and dels
// it otherwise, re-evaluated each refresh.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import {
  startWorkerHeartbeat,
  WORKER_ADVISOR_READY_KEY,
  WORKER_STATUS_KEY,
  WORKER_STUDY_STATUS_KEY,
} from '../../src/boot/worker-heartbeat.js';

const stubLogger = (): Logger => ({ warn: vi.fn() }) as unknown as Logger;

const stubRedis = (): {
  redis: Redis;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} => {
  const set = vi.fn(() => Promise.resolve('OK'));
  const del = vi.fn(() => Promise.resolve(1));
  return { redis: { set, del } as unknown as Redis, set, del };
};

const ready = (v: boolean) => async () => v;

describe('startWorkerHeartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes the live key and returns one timer when the process runs live', async () => {
    const { redis, set } = stubRedis();
    const heartbeat = JSON.stringify({ sha: 'abc', bootedAt: '2026-06-12T00:00:00.000Z' });

    const timers = await startWorkerHeartbeat({
      redis,
      logger: stubLogger(),
      heartbeat,
      runsLive: true,
      runsStudy: false,
      advisorReady: ready(false),
    });

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(WORKER_STATUS_KEY, heartbeat, 'EX', expect.any(Number));
    expect(timers).toHaveLength(1);
    timers.forEach((t) => clearInterval(t));
  });

  it('writes the study key plus the advisor loop when the process runs study', async () => {
    const { redis, set, del } = stubRedis();

    const timers = await startWorkerHeartbeat({
      redis,
      logger: stubLogger(),
      heartbeat: '{}',
      runsLive: false,
      runsStudy: true,
      advisorReady: ready(false),
    });

    // Study liveness written; advisor key deleted since no provider is usable.
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(WORKER_STUDY_STATUS_KEY, '{}', 'EX', expect.any(Number));
    expect(del).toHaveBeenCalledWith(WORKER_ADVISOR_READY_KEY);
    // Study beat timer + advisor refresh timer.
    expect(timers).toHaveLength(2);
    timers.forEach((t) => clearInterval(t));
  });

  it('writes both liveness keys plus the advisor loop when the process runs all', async () => {
    const { redis, set } = stubRedis();

    const timers = await startWorkerHeartbeat({
      redis,
      logger: stubLogger(),
      heartbeat: '{}',
      runsLive: true,
      runsStudy: true,
      advisorReady: ready(false),
    });

    expect(set).toHaveBeenCalledWith(WORKER_STATUS_KEY, '{}', 'EX', expect.any(Number));
    expect(set).toHaveBeenCalledWith(WORKER_STUDY_STATUS_KEY, '{}', 'EX', expect.any(Number));
    // live beat + study beat + advisor refresh loop.
    expect(timers).toHaveLength(3);
    timers.forEach((t) => clearInterval(t));
  });

  it('sets the advisor-ready key when a study worker can generate', async () => {
    const { redis, set, del } = stubRedis();

    const timers = await startWorkerHeartbeat({
      redis,
      logger: stubLogger(),
      heartbeat: '{}',
      runsLive: false,
      runsStudy: true,
      advisorReady: ready(true),
    });

    expect(set).toHaveBeenCalledWith(WORKER_ADVISOR_READY_KEY, '{}', 'EX', expect.any(Number));
    expect(del).not.toHaveBeenCalled();
    timers.forEach((t) => clearInterval(t));
  });

  it('deletes the advisor-ready key when the provider is not usable', async () => {
    const { redis, set, del } = stubRedis();

    const timers = await startWorkerHeartbeat({
      redis,
      logger: stubLogger(),
      heartbeat: '{}',
      runsLive: true,
      runsStudy: true,
      advisorReady: ready(false),
    });

    expect(set).not.toHaveBeenCalledWith(
      WORKER_ADVISOR_READY_KEY,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(del).toHaveBeenCalledWith(WORKER_ADVISOR_READY_KEY);
    timers.forEach((t) => clearInterval(t));
  });

  it('re-evaluates advisor readiness on the interval (flips set to del)', async () => {
    vi.useFakeTimers();
    const { redis, set, del } = stubRedis();
    let usable = true;

    const timers = await startWorkerHeartbeat({
      redis,
      logger: stubLogger(),
      heartbeat: '{}',
      runsLive: false,
      runsStudy: true,
      advisorReady: async () => usable,
    });
    expect(set).toHaveBeenCalledWith(WORKER_ADVISOR_READY_KEY, '{}', 'EX', expect.any(Number));

    usable = false; // operator disables the provider
    await vi.advanceTimersByTimeAsync(60_000);
    expect(del).toHaveBeenCalledWith(WORKER_ADVISOR_READY_KEY);

    timers.forEach((t) => clearInterval(t));
  });

  it('refreshes the liveness heartbeat on the interval', async () => {
    vi.useFakeTimers();
    const { redis, set } = stubRedis();

    const timers = await startWorkerHeartbeat({
      redis,
      logger: stubLogger(),
      heartbeat: '{}',
      runsLive: true,
      runsStudy: false,
      advisorReady: ready(false),
    });
    expect(set).toHaveBeenCalledTimes(1); // initial write

    await vi.advanceTimersByTimeAsync(60_000);
    expect(set).toHaveBeenCalledTimes(2); // one refresh

    timers.forEach((t) => clearInterval(t));
  });

  it('writes nothing and returns no timers when the process runs neither role', async () => {
    const { redis, set, del } = stubRedis();

    const timers = await startWorkerHeartbeat({
      redis,
      logger: stubLogger(),
      heartbeat: '{}',
      runsLive: false,
      runsStudy: false,
      advisorReady: ready(false),
    });

    expect(set).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(timers).toHaveLength(0);
  });
});
