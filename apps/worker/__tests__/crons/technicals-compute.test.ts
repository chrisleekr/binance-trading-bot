// Worker-side contract for the technicals-compute cron handler. The
// indicator-package unit tests own the pure rating math; here we lock
// the producer handler's contract — it enumerates the active profiles,
// unions their (interval, symbols) pairs, and fans one fetchAndCache
// call out per distinct interval.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';

import {
  buildTechnicalsComputeCron,
  technicalsComputeHandler,
} from '../../src/crons/technicals-compute.cron.js';
import type { BootContext } from '../../src/boot/boot-context.js';
import type { ActiveProfile } from '../../src/profile-manager/profile-manager.js';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const profile = (
  profileId: string,
  candleInterval: string,
  symbols: readonly string[],
  technicalsIntervals: readonly string[] = [candleInterval],
): ActiveProfile =>
  ({
    profileId,
    userId: 'u1',
    candleInterval,
    symbols,
    technicalsIntervals,
  }) as unknown as ActiveProfile;

const job = { id: 'job-1', data: {} } as unknown as Job;
const clock = { nowMs: () => 1_700_000_000_000 };

describe('buildTechnicalsComputeCron', () => {
  it('self-reschedules on a 30s start-to-start period, not a fixed scheduler', () => {
    // A fixed 30s scheduler mints overlapping iterations when a run outruns the
    // cadence, which backlogged and wedged the queue (#361). Self-rescheduling
    // enqueues the next run only after the current finishes.
    const ctx = {
      redis: {} as BootContext['redis'],
      logger: stubLogger,
      listActive: () => [],
      weightGovernor: {} as BootContext['weightGovernor'],
      workerEnv: { KLINE_CONCURRENCY: 8 },
    } as unknown as BootContext;
    const cron = buildTechnicalsComputeCron(ctx);
    expect(cron.selfReschedulePeriodMs).toBe(30_000);
    expect(cron.pattern).toBeUndefined();
    expect(cron.name).toBe('technicals-compute');
  });
});

describe('technicalsComputeHandler', () => {
  it('fans one fetchAndCache call out per distinct interval', async () => {
    const fetchAndCache = vi.fn(async () => undefined);
    const handler = technicalsComputeHandler({
      logger: stubLogger,
      listActive: () => [profile('p1', '5m', ['BTCUSDT']), profile('p2', '1h', ['ETHUSDT'])],
      fetchAndCache,
      clock,
    });

    await handler(job);

    expect(fetchAndCache).toHaveBeenCalledTimes(2);
    expect(fetchAndCache).toHaveBeenCalledWith('5m', ['BTCUSDT']);
    expect(fetchAndCache).toHaveBeenCalledWith('1h', ['ETHUSDT']);
  });

  it('unions symbols across profiles that share an interval into one call', async () => {
    const fetchAndCache = vi.fn(async () => undefined);
    const handler = technicalsComputeHandler({
      logger: stubLogger,
      listActive: () => [profile('p1', '5m', ['ETHUSDT']), profile('p2', '5m', ['BTCUSDT'])],
      fetchAndCache,
      clock,
    });

    await handler(job);

    expect(fetchAndCache).toHaveBeenCalledTimes(1);
    // buildTradingviewJobs sorts the unioned symbol set.
    expect(fetchAndCache).toHaveBeenCalledWith('5m', ['BTCUSDT', 'ETHUSDT']);
  });

  it('does not call fetchAndCache when no profiles are active', async () => {
    const fetchAndCache = vi.fn(async () => undefined);
    const handler = technicalsComputeHandler({
      logger: stubLogger,
      listActive: () => [],
      fetchAndCache,
      clock,
    });

    await handler(job);

    expect(fetchAndCache).not.toHaveBeenCalled();
  });

  it('isolates a per-interval failure: it is caught, logged, and the batch continues', async () => {
    // One interval's upstream failure must not abort the others — the
    // cron re-fires on its next 30s tick, so a thrown error that aborted
    // the loop would starve every later interval.
    const fetchAndCache = vi.fn(async (interval: string) => {
      if (interval === '5m') throw new Error('upstream 503');
    });
    const handler = technicalsComputeHandler({
      logger: stubLogger,
      listActive: () => [profile('p1', '5m', ['BTCUSDT']), profile('p2', '1h', ['ETHUSDT'])],
      fetchAndCache,
      clock,
    });

    await expect(handler(job)).resolves.toBeUndefined();
    expect(fetchAndCache).toHaveBeenCalledTimes(2);
  });

  it('logs an error when every interval batch fails (no silent failure)', async () => {
    // A total commit failure means the buy-gate has no fresh signals; it must
    // surface loudly, not just leave the dashboard pill as the only hint.
    const error = vi.fn();
    const logger = { ...stubLogger, error } as unknown as Logger;
    const fetchAndCache = vi.fn(async () => {
      throw new Error('upstream 503');
    });
    const handler = technicalsComputeHandler({
      logger,
      listActive: () => [profile('p1', '5m', ['BTCUSDT']), profile('p2', '1h', ['ETHUSDT'])],
      fetchAndCache,
      clock,
    });

    await handler(job);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatch(/no signals committed/);
  });

  it('does not log an error when at least one interval batch succeeds', async () => {
    const error = vi.fn();
    const logger = { ...stubLogger, error } as unknown as Logger;
    const fetchAndCache = vi.fn(async (interval: string) => {
      if (interval === '5m') throw new Error('upstream 503');
    });
    const handler = technicalsComputeHandler({
      logger,
      listActive: () => [profile('p1', '5m', ['BTCUSDT']), profile('p2', '1h', ['ETHUSDT'])],
      fetchAndCache,
      clock,
    });

    await handler(job);

    expect(error).not.toHaveBeenCalled();
  });
});
