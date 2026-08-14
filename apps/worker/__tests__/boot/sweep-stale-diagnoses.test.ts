// The recovery path for a diagnosis run whose job died before any terminal
// write. It matters more than the row: the drawer hides "Check again" while a
// run is live, so one stranded row locks the operator out of investigating that
// profile at all, and `attempts: 1` means no retry is coming to clear it.

import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';

// Mock the GLOBAL (db-first, cross-profile) sweep so this runs without a real DB.
const failStaleNonTerminal = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return {
    ...orig,
    repo: {
      ...orig.repo,
      diagnosisRuns: { ...orig.repo.diagnosisRuns, failStaleNonTerminal },
    },
  };
});

const { runStaleDiagnosisSweep, startPeriodicDiagnosisSweep } =
  await import('../../src/boot/sweep-stale-diagnoses.js');

const silentLogger = pino({ level: 'silent' });
const db = {} as never;

describe('runStaleDiagnosisSweep', () => {
  it('sweeps runs older than the horizon and returns the recovered count', async () => {
    failStaleNonTerminal.mockResolvedValueOnce(3);
    const nowMs = 1_000 * 60 * 60 * 24; // arbitrary fixed clock
    const recovered = await runStaleDiagnosisSweep({
      db,
      logger: silentLogger,
      clock: { nowMs: () => nowMs },
      staleMinutes: 10,
    });
    expect(recovered).toBe(3);
    expect(failStaleNonTerminal).toHaveBeenCalledWith(db, new Date(nowMs - 10 * 60 * 1000));
  });

  it('uses the default 10-minute horizon when none is given', async () => {
    // Pins the cutoff itself. A run is bounded by one ticker call plus a bounded
    // kline fan-out, so anything shorter risks reclaiming an investigation the
    // operator is still watching.
    failStaleNonTerminal.mockResolvedValueOnce(0);
    const nowMs = 5_000_000;
    await runStaleDiagnosisSweep({ db, logger: silentLogger, clock: { nowMs: () => nowMs } });
    expect(failStaleNonTerminal).toHaveBeenCalledWith(db, new Date(nowMs - 10 * 60 * 1000));
  });

  it('returns 0 and does not throw when nothing is stale', async () => {
    failStaleNonTerminal.mockResolvedValueOnce(0);
    await expect(
      runStaleDiagnosisSweep({ db, logger: silentLogger, clock: { nowMs: () => 0 } }),
    ).resolves.toBe(0);
  });
});

describe('startPeriodicDiagnosisSweep', () => {
  it('keeps sweeping on the interval, so a mid-run kill is reclaimed between boots', async () => {
    vi.useFakeTimers();
    try {
      failStaleNonTerminal.mockClear();
      failStaleNonTerminal.mockResolvedValue(0);
      const timer = startPeriodicDiagnosisSweep({ db, logger: silentLogger });
      // Nothing fires until the first interval elapses.
      expect(failStaleNonTerminal).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(failStaleNonTerminal).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(failStaleNonTerminal).toHaveBeenCalledTimes(2);
      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a failing sweep rather than killing the loop', async () => {
    vi.useFakeTimers();
    try {
      failStaleNonTerminal.mockClear();
      failStaleNonTerminal.mockRejectedValueOnce(new Error('db gone'));
      failStaleNonTerminal.mockResolvedValue(0);
      const timer = startPeriodicDiagnosisSweep({ db, logger: silentLogger });
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(failStaleNonTerminal).toHaveBeenCalledTimes(2);
      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });
});
