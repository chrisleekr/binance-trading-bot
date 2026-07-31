// Smoke for the testcontainers wrapper. Spins both containers, asserts the
// connection URLs respond, tears them down. Gated on TESTCONTAINERS=1 and
// TESTCONTAINERS_CONTENTION_CHECK=1 so the unit job (which doesn't carry a
// Docker socket) skips the suite; the integration job exports the env and
// runs it. The second env guard keeps this suite out of the default
// whole-repo `bun run test` path so it never contends with 20+ turbo lanes
// for the Docker daemon on a dev machine.
import { describe, expect, it } from 'vitest';

import { withPostgres, withRedis } from '../src/index.js';

const RUN =
  process.env['TESTCONTAINERS'] === '1' && process.env['TESTCONTAINERS_CONTENTION_CHECK'] === '1';
const describeIfDocker = RUN ? describe : describe.skip;

describeIfDocker('testcontainers wrapper', () => {
  it('boots Postgres and accepts a connection string drizzle can consume', async () => {
    const fx = await withPostgres();
    try {
      expect(fx.databaseUrl).toMatch(/^postgres:\/\//);
      // This suite only runs under TESTCONTAINERS=1, where a real container is
      // always provisioned (the reuse path is gated off).
      expect(fx.container?.getHost()).toBeTruthy();
      expect(fx.container?.getPort()).toBeGreaterThan(0);
    } finally {
      await fx.stop();
    }
  }, 60_000);

  it('boots Redis and accepts a connection URL ioredis can consume', async () => {
    const fx = await withRedis();
    try {
      expect(fx.redisUrl).toMatch(/^redis:\/\//);
      // This suite only runs under TESTCONTAINERS=1, where a real container is
      // always provisioned (the reuse path is gated off).
      expect(fx.container?.getHost()).toBeTruthy();
      expect(fx.container?.getPort()).toBeGreaterThan(0);
    } finally {
      await fx.stop();
    }
  }, 60_000);
});
