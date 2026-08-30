// Thin wrappers around `@testcontainers/postgresql` and
// `@testcontainers/redis` that produce a fresh container per call.
//
// The integration suites under apps/api, apps/worker, and packages/db all
// need a hermetic Postgres + Redis. Sharing a single long-lived instance
// across suites is fragile — one suite's leaked rows show up in the next
// — so each suite calls `withPostgres` / `withRedis` and tears the
// container down on cleanup. The factories live here rather than inline
// in each suite so the image pins, env defaults, and start-up timing are
// owned in one place.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';

/**
 * The runtime pin matches `deploy/compose/docker-compose.prod.yml` so ordinary integration tests exercise the deployed Postgres extension surface. Floating tags would silently change that surface between runs.
 */
const POSTGRES_IMAGE =
  'timescale/timescaledb:2.29.2-pg17@sha256:bc8527e62f70f0766b29515077965025872fabb5349db421565f69ee273baf2d';
const REDIS_IMAGE = 'redis@sha256:d146f83b1e0f02fc27c26a50cee39338c736674c5959db84363e6ae3cd9e02d2';

/**
 * How many times {@link startWithRetry} will try to start one container.
 *
 * Not a parameter: no caller wants a different number, and an `attempts` below 1 would make the loop rethrow an unassigned `lastError`, i.e. reject with `undefined` and no cause at all.
 */
const START_ATTEMPTS = 3;

/**
 * Runs one container-start thunk under a bounded retry so a contended host does not fail an entire suite on a transient provisioning fault.
 *
 * Only reachable under `TESTCONTAINERS=1`, which today means a developer's own machine: no CI lane sets it, so every lane takes the reuse branch against a service container instead. The fault this absorbs was reported on exactly that local path, on a loaded docker host, where a clean re-run against an uncongested docker was fully green. It applies unchanged to any future Docker-capable lane.
 *
 * Retries on ANY rejection rather than on a message predicate. testcontainers waits a fixed 10s for a started container's ports to be bound to the host and none of its call sites widen that window, so a loaded host loses the race and the suite dies on a scheduling artefact. Matching that timeout's message string instead would fail open and silent the moment the dependency reworded it, and it would still miss the sibling faults the same contention produces (ryuk connect-refused, docker-socket ECONNRESET, image-pull EOF). Over-broad is merely slow; over-narrow is silent. Nothing sleeps between attempts because the failed attempt's own port-bind timeout already is the backoff.
 *
 * The bound is what makes the retry safe rather than harmful. A `.start()` that rejects at the port-bind inspect has already created and started its container, and the rejection carries no handle back, so `stop()` is not expressible through the public API; ryuk reaps those containers only when the session exits. Each retry therefore leaks one container for the rest of the run, and an unbounded retry would pile zombies onto the very host it is trying to relieve.
 *
 * This is the inner wrapper, not the outermost one: callers run it inside {@link startWithDeadline}, so all `START_ATTEMPTS` attempts spend one shared budget. A consequence worth knowing when reading a stalled run's output is that the loop outlives a spent deadline — it keeps retrying detached, and only a container it eventually resolves is still reachable enough to be stopped.
 *
 * The last error is rethrown verbatim, neither wrapped nor swallowed, so a permanent fault (a bad digest, no Docker socket) still reaches the caller naming its own cause once the bound is spent.
 *
 * @param start - Thunk that provisions and starts one container, e.g. `() => new RedisContainer(IMAGE).start()`.
 * @returns Whatever the thunk resolves to on its first successful attempt.
 */
export const startWithRetry = async <T>(start: () => Promise<T>): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
    try {
      return await start();
    } catch (error) {
      lastError = error;
      // Every failed attempt is named, so a run that only succeeded on the retry is still visibly contended rather than indistinguishable from a clean one.
      console.warn(`[testcontainers] start attempt ${attempt}/${START_ATTEMPTS} failed`, error);
    }
  }
  throw lastError;
};

/**
 * Deliberately below every caller's hook budget (packages/db 180s, apps/worker 180s) so a stalled provision surfaces as the diagnosis below rather than as a bare "beforeAll timed out", which names the symptom and not the daemon.
 */
export const PROVISION_DEADLINE_MS = 90_000;

/** The container surface the deadline reaper touches. Anything startable and stoppable qualifies, so the race is not tied to one image family. */
interface Stoppable {
  readonly stop: () => Promise<unknown>;
}

/** How one provisioning attempt is raced. */
export interface DeadlineOptions {
  /** Names the endpoint in the failure message, so a stalled run says which of the two containers never arrived. */
  readonly label: string;
  /** Budget for this attempt. Defaults to `PROVISION_DEADLINE_MS`; a caller with a tighter hook timeout passes its own. */
  readonly timeoutMs?: number;
}

/**
 * Races a container start against a deadline. Two things go wrong without it. A saturated Docker daemon makes every concurrent `.start()` crawl, and the hook timeout that eventually fires blames the test rather than the daemon. Worse, the start keeps running: the container comes up minutes later with nobody left holding its handle, which is how a timed-out run leaves a pile of live containers behind. So a late arrival is reaped here, at the only place that still has a reference to it.
 *
 * The reaper covers exactly one path, and claiming more would be wrong. It stops a start that RESOLVES after the deadline already rejected. It cannot touch a start that REJECTS: a `.start()` failing at the port-bind inspect has already created its container and hands back no handle, so `stop()` is not expressible and ryuk reaps that container only at session exit. Provisioning is therefore not leak-free — every failed attempt inside {@link startWithRetry} still leaves one container behind for the rest of the session.
 *
 * @param start - Thunk that begins provisioning. Taking a thunk rather than a promise keeps the caller from starting work this function cannot reap.
 * @param options - The label to name in a failure and the budget to allow.
 * @returns The started container, when it arrives inside the budget.
 */
export const startWithDeadline = async <T extends Stoppable>(
  start: () => Promise<T>,
  { label, timeoutMs = PROVISION_DEADLINE_MS }: DeadlineOptions,
): Promise<T> => {
  const startPromise = start();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Attached only once the race is lost: on the success path the caller owns the container and must keep it.
      //
      // One trailing catch rather than an onRejected argument. `.then(onFulfilled, onRejected)` returns a NEW promise, and a stop() that itself rejects settles THAT one, which nothing handles: under Node default --unhandled-rejections=throw it surfaces as an uncaught exception and replaces the deadline message below. That happens on exactly the saturated-daemon path this wrapper exists to make legible, where stop() is likeliest to fail.
      void startPromise.then((container) => container.stop()).catch(() => undefined);
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms provisioning the ${label} test container. The Docker daemon is likely saturated by concurrent provisioning, or the pinned image is still being pulled.`,
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([startPromise, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

/** Per-call provisioning overrides. */
export interface ProvisionOptions {
  /** Deadline for the container start, for a caller whose hook budget is tighter than `PROVISION_DEADLINE_MS`. */
  readonly startTimeoutMs?: number;
}

/**
 * One Postgres endpoint plus a connection string and a tear-down hook.
 * `databaseUrl` is the form drizzle / pg consumes directly. `container` is
 * present only when this call provisioned a throwaway container; it is absent
 * when a pre-existing endpoint (a CI service container / local stack) was
 * reused, in which case `stop` is a no-op.
 */
export interface PostgresFixture {
  readonly container?: StartedPostgreSqlContainer;
  readonly databaseUrl: string;
  readonly stop: () => Promise<void>;
}

/**
 * Returns a Postgres endpoint for an integration suite. `TESTCONTAINERS=1` boots the requested pinned image, while `DATABASE_TEST_URL` reuses the service container supplied by CI. `TESTCONTAINERS=1` wins when both are set so the wrapper's smoke test exercises real provisioning.
 *
 * @param options - Per-call overrides; `startTimeoutMs` tightens the provisioning deadline for a caller with a smaller hook budget.
 * @returns The connection string, optional provisioned container, and cleanup hook owned by the caller.
 */
export const withPostgres = async (options: ProvisionOptions = {}): Promise<PostgresFixture> => {
  const reuseUrl = process.env['DATABASE_TEST_URL'];
  if (process.env['TESTCONTAINERS'] !== '1' && reuseUrl) {
    return { databaseUrl: reuseUrl, stop: async () => undefined };
  }
  // Deadline OUTSIDE, retry INSIDE, so all three attempts spend one budget. Nested the other way each attempt would get its own, up to 3x the deadline, which outruns the hook timeouts the deadline was sized under (packages/db 180s, apps/worker 180s) and hands the operator back the bare "beforeAll timed out" this whole path exists to replace.
  const container = await startWithDeadline(
    () =>
      startWithRetry(() =>
        new PostgreSqlContainer(POSTGRES_IMAGE)
          .withDatabase('binance_trading_bot')
          .withUsername('postgres')
          .withPassword('postgres')
          .start(),
      ),
    {
      label: 'postgres',
      ...(options.startTimeoutMs !== undefined && { timeoutMs: options.startTimeoutMs }),
    },
  );
  const databaseUrl = container.getConnectionUri();
  return {
    container,
    databaseUrl,
    stop: async () => {
      await container.stop();
    },
  };
};

/**
 * One Redis endpoint plus a connection URL and a tear-down hook. `redisUrl` is
 * the `redis://host:port` form ioredis consumes directly. `container` is
 * present only when this call provisioned a throwaway container; it is absent
 * when a pre-existing endpoint (`REDIS_TEST_URL`) was reused, in which case
 * `stop` is a no-op.
 */
export interface RedisFixture {
  readonly container?: StartedRedisContainer;
  readonly redisUrl: string;
  readonly stop: () => Promise<void>;
}

/**
 * A Redis endpoint for an integration suite. When `TESTCONTAINERS=1` is set
 * this boots a fresh throwaway container on a random host port (so parallel
 * suites never compete for 6379). Otherwise, when `REDIS_TEST_URL` names a
 * pre-existing endpoint, that endpoint is reused with no container — the path
 * CI takes with a Redis service container. The suite owns key hygiene there
 * (it clears its own namespace), so co-tenant suites do not collide.
 *
 * `TESTCONTAINERS=1` wins over `REDIS_TEST_URL` when both are set so the
 * wrapper's own smoke test always exercises real provisioning.
 *
 * @param options - Per-call overrides; `startTimeoutMs` tightens the provisioning deadline for a caller with a smaller hook budget.
 * @returns The connection URL, optional provisioned container, and cleanup hook owned by the caller.
 */
export const withRedis = async (options: ProvisionOptions = {}): Promise<RedisFixture> => {
  const reuseUrl = process.env['REDIS_TEST_URL'];
  if (process.env['TESTCONTAINERS'] !== '1' && reuseUrl) {
    return { redisUrl: reuseUrl, stop: async () => undefined };
  }
  // Same nesting as `withPostgres`, for the same reason: one budget covers the retry loop, never one budget per attempt.
  const container = await startWithDeadline(
    () => startWithRetry(() => new RedisContainer(REDIS_IMAGE).start()),
    {
      label: 'redis',
      ...(options.startTimeoutMs !== undefined && { timeoutMs: options.startTimeoutMs }),
    },
  );
  return {
    container,
    redisUrl: container.getConnectionUrl(),
    stop: async () => {
      await container.stop();
    },
  };
};
