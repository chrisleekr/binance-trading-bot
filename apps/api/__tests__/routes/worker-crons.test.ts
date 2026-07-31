// Worker-crons route test. The route only reads `di.redis.raw().hgetall`, so a
// minimal standalone app with a stub redis exercises it without infra.

import { describe, expect, it } from 'vitest';
import { asUserId, type WorkerCronsResponse } from '@app/contracts';
import { workerCronsRouter } from '../../src/routes/worker-crons.js';
import { errorHandler } from '../../src/middleware/error.js';
import { createApiHono } from '../../src/types.js';
import type { DI } from '../../src/di.js';

const USER = asUserId('00000000-0000-4000-8000-00000000a001');

const appWith = (hash: Record<string, string>) => {
  const di = {
    redis: { raw: () => ({ hgetall: async () => hash }) },
  } as unknown as DI;
  const a = createApiHono();
  a.use('*', async (c, next) => {
    c.set('userId', USER);
    await next();
  });
  a.onError(errorHandler({ error: () => undefined } as never));
  a.route('/api', workerCronsRouter(di));
  return a;
};

const get = (hash: Record<string, string>) =>
  appWith(hash).request('/api/worker/crons', { headers: { 'content-type': 'application/json' } });

describe('worker-crons route', () => {
  it('returns recorded crons newest-run first, mapping the hash field to name', async () => {
    const res = await get({
      'discovery-run': JSON.stringify({ lastRunAtMs: 1000, status: 'ok', durationMs: 5 }),
      'market-trend': JSON.stringify({ lastRunAtMs: 3000, status: 'ok', durationMs: 8 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkerCronsResponse;
    expect(body.crons.map((c) => c.name)).toEqual(['market-trend', 'discovery-run']);
  });

  it('surfaces an errored cron with its message', async () => {
    const res = await get({
      'db-backup': JSON.stringify({
        lastRunAtMs: 2000,
        status: 'error',
        durationMs: 12,
        error: 'pg_dump exited 1',
      }),
    });
    const body = (await res.json()) as WorkerCronsResponse;
    expect(body.crons[0]).toMatchObject({
      name: 'db-backup',
      status: 'error',
      error: 'pg_dump exited 1',
    });
  });

  it('skips a malformed field rather than failing the whole panel', async () => {
    const res = await get({
      'good-cron': JSON.stringify({ lastRunAtMs: 1000, status: 'ok', durationMs: 1 }),
      'bad-cron': 'not json',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkerCronsResponse;
    expect(body.crons.map((c) => c.name)).toEqual(['good-cron']);
  });

  it('returns an empty list when no cron has reported', async () => {
    const res = await get({});
    expect(res.status).toBe(200);
    expect(((await res.json()) as WorkerCronsResponse).crons).toEqual([]);
  });
});
