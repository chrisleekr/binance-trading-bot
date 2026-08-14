// Shared CI runners expose service URLs but no Docker socket. Keep that reuse
// path covered without retiring the opt-in local provisioning smoke.
import { describe, expect, it } from 'vitest';

import { withPostgres, withRedis } from '../src/index.js';

const RUN_WITH_SERVICES =
  process.env['TESTCONTAINERS_CONTENTION_CHECK'] === '1' &&
  process.env['TESTCONTAINERS'] !== '1' &&
  Boolean(process.env['DATABASE_TEST_URL']) &&
  Boolean(process.env['REDIS_TEST_URL']);
const describeIfServices = RUN_WITH_SERVICES ? describe : describe.skip;
const RUN_WITH_DOCKER =
  process.env['TESTCONTAINERS'] === '1' && process.env['TESTCONTAINERS_CONTENTION_CHECK'] === '1';
const describeIfDocker = RUN_WITH_DOCKER ? describe : describe.skip;

describeIfServices('testcontainers service reuse', () => {
  it('reuses the integration Postgres service', async () => {
    const fx = await withPostgres();
    try {
      expect(fx.databaseUrl).toBe(process.env['DATABASE_TEST_URL']);
      expect(fx.container).toBeUndefined();
    } finally {
      await fx.stop();
    }
  }, 60_000);

  it('reuses the integration Redis service', async () => {
    const fx = await withRedis();
    try {
      expect(fx.redisUrl).toBe(process.env['REDIS_TEST_URL']);
      expect(fx.container).toBeUndefined();
    } finally {
      await fx.stop();
    }
  }, 60_000);
});

describeIfDocker('testcontainers provisioning', () => {
  it('boots Postgres and returns its connection details', async () => {
    const fx = await withPostgres();
    try {
      expect(fx.databaseUrl).toMatch(/^postgres:\/\//);
      expect(fx.container?.getHost()).toBeTruthy();
      expect(fx.container?.getPort()).toBeGreaterThan(0);
    } finally {
      await fx.stop();
    }
  }, 60_000);

  it('boots Redis and returns its connection details', async () => {
    const fx = await withRedis();
    try {
      expect(fx.redisUrl).toMatch(/^redis:\/\//);
      expect(fx.container?.getHost()).toBeTruthy();
      expect(fx.container?.getPort()).toBeGreaterThan(0);
    } finally {
      await fx.stop();
    }
  }, 60_000);
});
