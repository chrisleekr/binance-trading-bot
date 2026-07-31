import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';

// Mock the GLOBAL (db-first, cross-profile) advisor sweep so the boot sweep is
// tested without a real DB.
const failStaleRunning = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return {
    ...orig,
    repo: {
      ...orig.repo,
      backtestAdvisorResults: { ...orig.repo.backtestAdvisorResults, failStaleRunning },
    },
  };
});

const { runStaleAdvisorSweep, startPeriodicAdvisorSweep } =
  await import('../../src/boot/sweep-stale-advisors.js');

const silentLogger = pino({ level: 'silent' });
const db = {} as never;

describe('runStaleAdvisorSweep', () => {
  it('sweeps advisor rows older than the horizon and returns the recovered count', async () => {
    failStaleRunning.mockResolvedValueOnce(2);
    const nowMs = 1_000 * 60 * 60 * 24; // arbitrary fixed clock
    const recovered = await runStaleAdvisorSweep({
      db,
      logger: silentLogger,
      clock: { nowMs: () => nowMs },
      staleMinutes: 15,
    });
    expect(recovered).toBe(2);
    // cutoff = now - 15m
    expect(failStaleRunning).toHaveBeenCalledWith(db, new Date(nowMs - 15 * 60 * 1000));
  });

  it('uses the default 15-minute horizon when none is given', async () => {
    failStaleRunning.mockResolvedValueOnce(0);
    const nowMs = 5_000_000;
    await runStaleAdvisorSweep({ db, logger: silentLogger, clock: { nowMs: () => nowMs } });
    expect(failStaleRunning).toHaveBeenCalledWith(db, new Date(nowMs - 15 * 60 * 1000));
  });

  it('returns 0 and does not throw when nothing is stale', async () => {
    failStaleRunning.mockResolvedValueOnce(0);
    await expect(
      runStaleAdvisorSweep({ db, logger: silentLogger, clock: { nowMs: () => 0 } }),
    ).resolves.toBe(0);
  });
});

describe('startPeriodicAdvisorSweep', () => {
  it('sweeps again on the 5-minute interval after boot', async () => {
    vi.useFakeTimers();
    try {
      failStaleRunning.mockClear();
      failStaleRunning.mockResolvedValue(0);
      const timer = startPeriodicAdvisorSweep({ db, logger: silentLogger });
      // Nothing fires until the first interval elapses.
      expect(failStaleRunning).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(failStaleRunning).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(failStaleRunning).toHaveBeenCalledTimes(2);
      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });
});
