import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StatusResponse } from '@app/contracts';
import { FLEET_COUNT_KEY } from '@app/db';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * Integration coverage for the public /status surface. The api answers with its
 * own SHA + boot time, the worker's heartbeat (from a bare Redis key), and the
 * latest migration timestamp. No session required.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const WORKER_STATUS_KEY = 'worker:status';
const WORKER_STUDY_STATUS_KEY = 'worker:study-status';

describeIfInfra('status router', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  beforeEach(async () => {
    await fx.di.redis.raw().del(WORKER_STATUS_KEY, WORKER_STUDY_STATUS_KEY, FLEET_COUNT_KEY);
  });

  it('returns the api SHA, null worker/study when the heartbeats are absent, and a migration timestamp', async () => {
    const res = await fx.app.request('/api/status');
    expect(res.status).toBe(200);
    const body = StatusResponse.parse(await res.json());
    expect(body.api.sha).toBe('testsha');
    expect(body.api.bootedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(body.worker).toBeNull();
    expect(body.study).toBeNull();
    // The test DB is migrated by the harness, so a timestamp is present.
    expect(typeof body.db.latestMigrationAppliedAt).toBe('string');
    // No fleet count published → zeroed.
    expect(body.fleet).toEqual({ total: 0, ready: 0 });
  });

  it('surfaces the published fleet count', async () => {
    await fx.di.redis.raw().set(FLEET_COUNT_KEY, JSON.stringify({ total: 3, ready: 2 }), 'EX', 30);
    const res = await fx.app.request('/api/status');
    expect(res.status).toBe(200);
    const body = StatusResponse.parse(await res.json());
    expect(body.fleet).toEqual({ total: 3, ready: 2 });
  });

  it('populates worker from the heartbeat key when present', async () => {
    await fx.di.redis
      .raw()
      .set(
        WORKER_STATUS_KEY,
        JSON.stringify({ sha: 'wsha999', bootedAt: '2026-02-02T00:00:00.000Z' }),
        'EX',
        120,
      );
    const res = await fx.app.request('/api/status');
    expect(res.status).toBe(200);
    const body = StatusResponse.parse(await res.json());
    expect(body.worker).toEqual({ sha: 'wsha999', bootedAt: '2026-02-02T00:00:00.000Z' });
  });

  it('populates study from the study heartbeat key, independent of the live worker', async () => {
    await fx.di.redis
      .raw()
      .set(
        WORKER_STUDY_STATUS_KEY,
        JSON.stringify({ sha: 'ssha777', bootedAt: '2026-03-03T00:00:00.000Z' }),
        'EX',
        120,
      );
    const res = await fx.app.request('/api/status');
    expect(res.status).toBe(200);
    const body = StatusResponse.parse(await res.json());
    // Live worker key absent → null; study key present → populated.
    expect(body.worker).toBeNull();
    expect(body.study).toEqual({ sha: 'ssha777', bootedAt: '2026-03-03T00:00:00.000Z' });
  });

  it('degrades a malformed worker heartbeat to null', async () => {
    await fx.di.redis.raw().set(WORKER_STATUS_KEY, 'not-json{', 'EX', 120);
    const res = await fx.app.request('/api/status');
    expect(res.status).toBe(200);
    const body = StatusResponse.parse(await res.json());
    expect(body.worker).toBeNull();
  });

  it('requires no session', async () => {
    // No x-test-user-id header — the route must still answer 200.
    const res = await fx.app.request('/api/status');
    expect(res.status).toBe(200);
  });
});
