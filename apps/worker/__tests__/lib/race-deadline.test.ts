// The deadline helper is the single chokepoint every best-effort write on the tick
// path goes through, and its whole contract is "resolves, never rejects". That
// contract only holds if the helper OWNS the call: a promise handed in has already
// been produced by the caller, so a dependency that throws synchronously throws
// outside the helper and unwinds the tick that was mid-way through acting on an
// order. Taking a thunk moves the invocation inside, where the same `.catch` that
// already covers a rejection covers the throw too.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { raceDeadline } from '../../src/lib/race-deadline.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('raceDeadline — both failure modes resolve', () => {
  it('invokes onError and RESOLVES when the thunk throws synchronously', async () => {
    const boom = new Error('redis client exploded before it returned');
    const onTimeout = vi.fn();
    const onError = vi.fn();

    await expect(
      raceDeadline(
        () => {
          throw boom;
        },
        1_000,
        onTimeout,
        onError,
      ),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(boom);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('invokes onError and RESOLVES when the thunk returns a rejecting promise', async () => {
    // The sync throw above and this rejection must reach the SAME handler. With only
    // one pinned, a regression on the other hides behind it.
    const boom = new Error('redis command failed');
    const onTimeout = vi.fn();
    const onError = vi.fn();

    await expect(
      raceDeadline(() => Promise.reject(boom), 1_000, onTimeout, onError),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(boom);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('invokes onTimeout and resolves when the thunk outlives the deadline', async () => {
    const onTimeout = vi.fn();
    const onError = vi.fn();

    await expect(
      raceDeadline(() => new Promise<void>(() => {}), 5, onTimeout, onError),
    ).resolves.toBeUndefined();

    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('raceDeadline — timer hygiene', () => {
  it('unrefs the deadline timer and clears it once the thunk settles', async () => {
    // An abandoned deadline timer is not harmless: it fires on a write that already
    // succeeded (a false "exceeded" warn) and, without unref, a pending one holds the
    // event loop open past a worker shutdown.
    const SENTINEL_MS = 987_654;
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    await raceDeadline(
      () => Promise.resolve(),
      SENTINEL_MS,
      () => {},
      () => {},
    );

    // Filtered by delay so an unrelated timer scheduled by the runner cannot be
    // mistaken for the deadline.
    const timer = setSpy.mock.results.find((_r, i) => setSpy.mock.calls[i]?.[1] === SENTINEL_MS)
      ?.value as ReturnType<typeof setTimeout> | undefined;
    if (!timer) throw new Error('the deadline timer was never scheduled');

    expect(timer.hasRef()).toBe(false);
    expect(clearSpy).toHaveBeenCalledWith(timer);
  });

  it('clears the deadline timer on the FAILURE path too', async () => {
    // The assertion above only covers the resolving path. If `.finally` ever narrowed
    // to `.then`, a thunk that FAILED would take `onError` and then a spurious late
    // `onTimeout`: a false "exceeded the deadline" warn about a write that actually
    // failed fast, which points the operator at the wrong fault. The sync-throw test
    // above cannot catch it, because it checks `onTimeout` while the deadline is still
    // a second out. Fake timers let us jump past the deadline and prove nothing fires.
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const onError = vi.fn();

      await raceDeadline(
        () => {
          throw new Error('failed fast');
        },
        5,
        onTimeout,
        onError,
      );
      await vi.advanceTimersByTimeAsync(1_000);

      expect(onError).toHaveBeenCalledOnce();
      expect(onTimeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('raceDeadline — a failing callback cannot break the contract', () => {
  // Both callbacks are `logger.warn` at every call site, and pino's default SonicBoom
  // destination throws synchronously from `write()` once destroyed. So a throwing
  // callback is a shutdown-shaped reality, and unguarded each one breaks a DIFFERENT
  // half of the contract.

  it('still resolves when onError itself throws', async () => {
    // `onError` runs inside `.catch`, so its throw would reject the helper. At the
    // fire-and-forget tick-meta site that is an unhandled rejection, and nothing in the
    // tree installs an `unhandledRejection` handler, so Node's default would terminate
    // the worker and kill every in-flight tick across every profile.
    const onError = vi.fn(() => {
      throw new Error('logger destination destroyed');
    });

    await expect(
      raceDeadline(
        () => Promise.reject(new Error('write failed')),
        1_000,
        () => {},
        onError,
      ),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledOnce();
  });

  it('still settles when onTimeout itself throws', async () => {
    // `onTimeout` runs BEFORE the `resolve()` behind it, so its throw would leave the
    // promise permanently unsettled and the awaiting tick would hold its
    // per-(profile, symbol) chain lock forever. Nothing would ever tick that symbol
    // again.
    const onTimeout = vi.fn(() => {
      throw new Error('logger destination destroyed');
    });

    await expect(
      raceDeadline(
        () => new Promise<void>(() => {}),
        5,
        onTimeout,
        () => {},
      ),
    ).resolves.toBeUndefined();

    expect(onTimeout).toHaveBeenCalledOnce();
  }, 2_000); // An unsettled promise never returns, so fail fast instead of stalling CI.
});
