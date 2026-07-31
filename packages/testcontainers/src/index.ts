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
 * Pinned image digests, matched to `deploy/compose/docker-compose.prod.yml`
 * so integration tests exercise the *same* Postgres extension surface
 * (TimescaleDB 2.26.x) and Redis minor that production runs. Floating
 * tags like `latest-pg17` or `8-alpine` would silently pull whatever the
 * registry serves on the day CI runs, which breaks hermetic builds and
 * lets an upstream-shaped regression sneak past local dev.
 *
 * When the production compose bumps its digest, this pin moves in
 * lockstep — the `# Pinned: <tag> @ <date>` line in the compose file is
 * the source of truth.
 */
const POSTGRES_IMAGE =
  'timescale/timescaledb@sha256:dfbf3c54f03e01d9a6fe7eeb736b513064a849606ca5acd7edcf51fdcab76a5e';
const REDIS_IMAGE = 'redis@sha256:d146f83b1e0f02fc27c26a50cee39338c736674c5959db84363e6ae3cd9e02d2';

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
 * A Postgres endpoint for an integration suite. When `TESTCONTAINERS=1` is set
 * this boots a fresh throwaway container (the default user/db match what
 * `scripts/setup.ts` writes to the local `.env`, so a test that calls
 * `bun run db:migrate` against the returned URL applies the full migration set
 * without further config). Otherwise, when `DATABASE_TEST_URL` names a
 * pre-existing endpoint, that endpoint is reused with no container — the path
 * CI takes, where a service container already provides Postgres and spinning a
 * nested container would need a Docker socket the job deliberately lacks. The
 * suite owns its own determinism there (migrate + truncate its slice).
 *
 * `TESTCONTAINERS=1` wins over `DATABASE_TEST_URL` when both are set so the
 * wrapper's own smoke test always exercises real provisioning.
 */
export const withPostgres = async (): Promise<PostgresFixture> => {
  const reuseUrl = process.env['DATABASE_TEST_URL'];
  if (process.env['TESTCONTAINERS'] !== '1' && reuseUrl) {
    return { databaseUrl: reuseUrl, stop: async () => undefined };
  }
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('binance_trading_bot')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();
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
 */
export const withRedis = async (): Promise<RedisFixture> => {
  const reuseUrl = process.env['REDIS_TEST_URL'];
  if (process.env['TESTCONTAINERS'] !== '1' && reuseUrl) {
    return { redisUrl: reuseUrl, stop: async () => undefined };
  }
  const container = await new RedisContainer(REDIS_IMAGE).start();
  return {
    container,
    redisUrl: container.getConnectionUrl(),
    stop: async () => {
      await container.stop();
    },
  };
};
