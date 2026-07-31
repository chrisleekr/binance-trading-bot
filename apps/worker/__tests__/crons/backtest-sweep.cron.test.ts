import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Job } from 'bullmq';

import {
  backtestSweepHandler,
  buildBacktestSweepCron,
  type BacktestSweepDeps,
} from '../../src/crons/backtest-sweep.cron.js';
import { QUEUE_NAMES } from '../../src/queues/queue-names.js';
import type { BootContext } from '../../src/boot/boot-context.js';

const silent = pino({ level: 'silent' });
const job = {} as Job;

const candidate = (id: string) => ({ id, profileId: 'p1' });

const deps = (over: Partial<BacktestSweepDeps> = {}): BacktestSweepDeps => ({
  logger: silent,
  clock: { nowMs: () => 10_000_000 },
  listCandidates: vi.fn(async () => []),
  jobState: vi.fn(async () => 'active'),
  failRun: vi.fn(async () => true),
  ...over,
});

describe('backtestSweepHandler', () => {
  it('reclaims a run whose job is gone (no job for the run id)', async () => {
    const failRun = vi.fn(async () => true);
    await backtestSweepHandler(
      deps({
        listCandidates: async () => [candidate('r1')],
        jobState: async () => null,
        failRun,
      }),
    )(job);
    expect(failRun).toHaveBeenCalledWith('r1');
  });

  it('reclaims a run whose job is terminal (failed / completed) but the row is not', async () => {
    const failRun = vi.fn(async () => true);
    await backtestSweepHandler(
      deps({
        listCandidates: async () => [candidate('r1'), candidate('r2')],
        jobState: async (id) => (id === 'r1' ? 'failed' : 'completed'),
        failRun,
      }),
    )(job);
    expect(failRun).toHaveBeenCalledWith('r1');
    expect(failRun).toHaveBeenCalledWith('r2');
    expect(failRun).toHaveBeenCalledTimes(2);
  });

  it('leaves a run whose job is still live (active / waiting / delayed)', async () => {
    const failRun = vi.fn(async () => true);
    await backtestSweepHandler(
      deps({
        listCandidates: async () => [candidate('a'), candidate('b'), candidate('c')],
        jobState: async (id) => (id === 'a' ? 'active' : id === 'b' ? 'waiting' : 'delayed'),
        failRun,
      }),
    )(job);
    expect(failRun).not.toHaveBeenCalled();
  });

  it('passes the age-floored cutoff to listCandidates (skips just-created rows)', async () => {
    const listCandidates = vi.fn(async () => []);
    await backtestSweepHandler(deps({ clock: { nowMs: () => 10_000_000 }, listCandidates }))(job);
    const cutoff = (listCandidates.mock.calls[0] as unknown as [Date])[0];
    // 5-minute floor below the injected clock.
    expect(cutoff.getTime()).toBe(10_000_000 - 5 * 60_000);
  });

  it('keeps going when one run fails to reconcile (does not throw)', async () => {
    const failRun = vi.fn(async () => true);
    await expect(
      backtestSweepHandler(
        deps({
          listCandidates: async () => [candidate('boom'), candidate('ok')],
          jobState: async (id) => {
            if (id === 'boom') throw new Error('redis blip');
            return null;
          },
          failRun,
        }),
      )(job),
    ).resolves.toBeUndefined();
    // The healthy run is still reclaimed despite the prior one throwing.
    expect(failRun).toHaveBeenCalledWith('ok');
    expect(failRun).toHaveBeenCalledTimes(1);
  });

  it('does not fail a row that did not transition (failRun returns false)', async () => {
    // failRun returning false (e.g. the row reached `done` between list and fail)
    // must not be counted as a recovery; the handler simply moves on.
    const failRun = vi.fn(async () => false);
    await expect(
      backtestSweepHandler(
        deps({
          listCandidates: async () => [candidate('r1')],
          jobState: async () => null,
          failRun,
        }),
      )(job),
    ).resolves.toBeUndefined();
    expect(failRun).toHaveBeenCalledWith('r1');
  });
});

describe('buildBacktestSweepCron wiring', () => {
  it('produces a 15-minute cron bound to the backtest-sweep queue', () => {
    // Guards the registration metadata (a typo in the pattern or queue would ship
    // a cron that never fires or fires on the wrong queue). Only the def shape is
    // asserted; the handler closures hit the real repo/DB and are covered above.
    const ctx = {
      logger: silent,
      db: {} as never,
      queueSet: { queues: { backtest: { getJob: async () => null } } },
    } as unknown as BootContext;
    const def = buildBacktestSweepCron(ctx);
    expect(def.name).toBe('backtest-sweep');
    expect(def.queue).toBe(QUEUE_NAMES.backtestSweep);
    expect(def.pattern).toBe('0 */15 * * * *');
  });
});
