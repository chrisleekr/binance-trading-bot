// Provisioning is raced against a deadline rather than left to the caller's hook timeout: a saturated Docker daemon makes every concurrent `.start()` crawl, and a bare hook timeout reports "beforeAll timed out" while the container that eventually comes up is never stopped. No daemon is involved here: the first group drives the race with an injected start, and the second drives the real `withPostgres` / `withRedis` call sites against mocked container classes on fake time.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROVISION_DEADLINE_MS, startWithDeadline, withPostgres, withRedis } from '../src/index.js';

/** Drives the mocked containers: how many leading attempts reject, and how long each attempt takes to settle. Declared through `vi.hoisted` because the `vi.mock` factories below are hoisted above ordinary declarations. */
const fakes = vi.hoisted(() => {
  /**
   * Fresh per-endpoint controls.
   *
   * @returns The attempt counter, the failure/timing knobs, and the `stop` the deadline reaper would call.
   */
  const makeState = (): {
    attempts: number;
    failuresBeforeSuccess: number;
    attemptMs: number;
    stop: ReturnType<typeof vi.fn>;
  } => ({
    attempts: 0,
    failuresBeforeSuccess: 0,
    attemptMs: 0,
    stop: vi.fn(async () => undefined),
  });
  const postgres = makeState();
  const redis = makeState();

  /**
   * Settles one `.start()` attempt on fake time, so a test can make the attempts cost more in total than a single deadline allows.
   *
   * @param state - The endpoint's controls, whose attempt counter this call advances.
   * @param started - Builds the value a successful attempt resolves to.
   * @returns The attempt's promise, rejecting while the attempt number is still inside the configured failure run.
   */
  const attemptOn = <T>(state: ReturnType<typeof makeState>, started: () => T): Promise<T> => {
    const attempt = ++state.attempts;
    return new Promise<T>((resolve, reject) => {
      setTimeout(() => {
        if (attempt <= state.failuresBeforeSuccess) {
          reject(new Error(`port bind timed out on attempt ${attempt}`));
          return;
        }
        resolve(started());
      }, state.attemptMs);
    });
  };

  return { postgres, redis, attemptOn };
});

// The composition under test lives at the `withPostgres` / `withRedis` call sites, so these tests reach it through those functions. A copy of the nesting written inside the test file would keep passing after the real call site was nested the wrong way round.
vi.mock('@testcontainers/redis', () => ({
  RedisContainer: class {
    constructor(readonly image: string) {}

    /**
     * @returns A stand-in for `StartedRedisContainer` exposing only what `withRedis` and the reaper touch.
     */
    start(): Promise<{ getConnectionUrl: () => string; stop: () => Promise<unknown> }> {
      return fakes.attemptOn(fakes.redis, () => ({
        getConnectionUrl: () => 'redis://127.0.0.1:6379',
        stop: fakes.redis.stop,
      }));
    }
  },
}));

vi.mock('@testcontainers/postgresql', () => ({
  PostgreSqlContainer: class {
    constructor(readonly image: string) {}

    /** @returns Itself, mirroring the real builder's chaining. */
    withDatabase(): this {
      return this;
    }

    /** @returns Itself, mirroring the real builder's chaining. */
    withUsername(): this {
      return this;
    }

    /** @returns Itself, mirroring the real builder's chaining. */
    withPassword(): this {
      return this;
    }

    /**
     * @returns A stand-in for `StartedPostgreSqlContainer` exposing only what `withPostgres` and the reaper touch.
     */
    start(): Promise<{ getConnectionUri: () => string; stop: () => Promise<unknown> }> {
      return fakes.attemptOn(fakes.postgres, () => ({
        getConnectionUri: () => 'postgres://postgres:postgres@127.0.0.1:5432/binance_trading_bot',
        stop: fakes.postgres.stop,
      }));
    }
  },
}));

/**
 * A container stand-in exposing only the surface the deadline reaper touches.
 *
 * @returns A fake container whose `stop` records that the reaper ran.
 */
const fakeContainer = (): { stop: ReturnType<typeof vi.fn> } => ({
  stop: vi.fn(async () => undefined),
});

/**
 * Builds a start function whose promise is resolved by the test rather than by Docker, so the deadline branch is reachable without provisioning anything.
 *
 * @returns The start function plus the resolver that lets the container finally come up.
 */
const deferredStart = <T>(): {
  start: () => Promise<T>;
  resolve: (value: T) => void;
} => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { start: () => promise, resolve };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('provisioning deadline', () => {
  it('returns the container when it starts inside the deadline', async () => {
    const container = fakeContainer();
    const started = await startWithDeadline(async () => container, {
      label: 'postgres',
      timeoutMs: 1_000,
    });
    expect(started).toBe(container);
    expect(container.stop).not.toHaveBeenCalled();
  });

  it('fails naming provisioning and daemon saturation rather than a bare timeout', async () => {
    vi.useFakeTimers();
    const { start } = deferredStart<{ stop: () => Promise<void> }>();
    const attempt = startWithDeadline(start, { label: 'postgres', timeoutMs: 90_000 });
    const assertion = expect(attempt).rejects.toThrowError(
      /provisioning[\s\S]*postgres[\s\S]*Docker daemon[\s\S]*saturat/i,
    );
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
  });

  it('stops a container that comes up after the deadline has already fired', async () => {
    vi.useFakeTimers();
    const container = fakeContainer();
    const { start, resolve } = deferredStart<typeof container>();
    const attempt = startWithDeadline(start, { label: 'redis', timeoutMs: 90_000 });
    const assertion = expect(attempt).rejects.toThrowError(/provisioning/);
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;

    expect(container.stop).not.toHaveBeenCalled();
    resolve(container);
    await vi.advanceTimersByTimeAsync(0);
    expect(container.stop).toHaveBeenCalledTimes(1);
  });
});

/** Both provisioning entry points, so the nesting is proven at every call site rather than at one of the two. */
const endpoints = [
  {
    label: 'redis',
    state: fakes.redis,
    url: 'redis://127.0.0.1:6379',
    provision: async (): Promise<string> => (await withRedis()).redisUrl,
    provisionWith: async (o: { startTimeoutMs: number }): Promise<string> =>
      (await withRedis(o)).redisUrl,
  },
  {
    label: 'postgres',
    state: fakes.postgres,
    url: 'postgres://postgres:postgres@127.0.0.1:5432/binance_trading_bot',
    provision: async (): Promise<string> => (await withPostgres()).databaseUrl,
    provisionWith: async (o: { startTimeoutMs: number }): Promise<string> =>
      (await withPostgres(o)).databaseUrl,
  },
] as const;

describe.each(endpoints)(
  'deadline/retry composition ($label)',
  ({ label, state, url, provision, provisionWith }) => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      state.attempts = 0;
      state.failuresBeforeSuccess = 0;
      state.attemptMs = 0;
      state.stop.mockClear();
    });

    it('retries inside the deadline: two failed starts then a success still yields the endpoint', async () => {
      vi.useFakeTimers();
      vi.stubEnv('TESTCONTAINERS', '1');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      state.failuresBeforeSuccess = 2;
      state.attemptMs = 20_000;

      const fixture = provision();
      await vi.advanceTimersByTimeAsync(60_000);

      await expect(fixture).resolves.toBe(url);
      expect(state.attempts).toBe(3);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(state.stop).not.toHaveBeenCalled();
    });

    it('spends ONE deadline across every attempt, not one deadline per attempt', async () => {
      vi.useFakeTimers();
      vi.stubEnv('TESTCONTAINERS', '1');
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      // Three 40s attempts outrun a single 90s budget but fit inside three of them, which is what makes the two nestings disagree instead of merely differing in wording: composed deadline-outside this rejects at 90s, composed retry-outside it succeeds at 120s, past the hook budget the deadline was sized under.
      state.failuresBeforeSuccess = 2;
      state.attemptMs = 40_000;

      const started = Date.now();
      let elapsed: number | undefined;
      const outcome = provision()
        .then(
          (): unknown => 'resolved',
          (error: unknown) => error,
        )
        .finally(() => {
          elapsed = Date.now() - started;
        });
      await vi.advanceTimersByTimeAsync(200_000);

      const result = await outcome;
      expect(result).toBeInstanceOf(Error);
      // toBeInstanceOf asserts but does not narrow, and this package has no @app/core dependency to reach errorMessage through. Rethrowing narrows without the unchecked cast the error-cast gate refuses, and leaves the assertion above as the one that reports a resolve.
      if (!(result instanceof Error)) throw result;
      expect(result.message).toMatch(
        new RegExp(`provisioning[\\s\\S]*${label}[\\s\\S]*Docker daemon[\\s\\S]*saturat`, 'i'),
      );
      expect(elapsed).toBe(PROVISION_DEADLINE_MS);
    });

    it('honours a caller-supplied startTimeoutMs instead of the package default', async () => {
      vi.useFakeTimers();
      vi.stubEnv('TESTCONTAINERS', '1');
      // Between the override and the default, so a dropped pass-through does not merely shift the number, it changes which deadline fires. apps/api is the only caller and it tightens the budget because its hook is shorter than this package's default assumes; with the spread deleted every such caller silently falls back to 90s and blows the hook it was avoiding.
      state.attemptMs = 60_000;

      const started = Date.now();
      let elapsed: number | undefined;
      const outcome = provisionWith({ startTimeoutMs: 20_000 })
        .then(
          (): unknown => 'resolved',
          (error: unknown) => error,
        )
        .finally(() => {
          elapsed = Date.now() - started;
        });
      await vi.advanceTimersByTimeAsync(120_000);

      const result = await outcome;
      expect(result).toBeInstanceOf(Error);
      expect(elapsed).toBe(20_000);
    });

    // Zero is the only value that tells the two spellings of the pass-through apart. The option is forwarded on PRESENCE, so 0 is a deadline that has already expired; forwarded on TRUTHINESS it would be indistinguishable from omitting the option and would silently restore the 90s default — which is what apps/api's floor above zero exists to stay clear of, and that floor is only load-bearing while this holds.
    it('treats a zero startTimeoutMs as an expired deadline, not as an absent option', async () => {
      vi.useFakeTimers();
      vi.stubEnv('TESTCONTAINERS', '1');
      state.attemptMs = 60_000;

      const started = Date.now();
      let elapsed: number | undefined;
      const outcome = provisionWith({ startTimeoutMs: 0 })
        .then(
          (): unknown => 'resolved',
          (error: unknown) => error,
        )
        .finally(() => {
          elapsed = Date.now() - started;
        });
      await vi.advanceTimersByTimeAsync(120_000);

      const result = await outcome;
      expect(result).toBeInstanceOf(Error);
      expect(elapsed).toBe(0);
    });
  },
);
