import { PIPELINE_JOB_OPTIONS } from '@app/core/queue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDI } from '../src/di.js';
import { loadEnv } from '../src/env.js';

const bullmq = vi.hoisted(() => ({ opts: new Map<string, { defaultJobOptions?: unknown }>() }));

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(name: string, opts: { defaultJobOptions?: unknown }) {
      bullmq.opts.set(name, opts);
    }

    async close(): Promise<void> {}
  },
}));

describe('createDI pipeline queue', () => {
  afterEach(() => bullmq.opts.clear());

  it('retries pipeline jobs by default and leaves the other queues on bullmq defaults', async () => {
    // Needs no live Postgres or Redis: the pg pool connects lazily and ioredis only retries against the closed port in the background, which logs unhandled-error noise but never fails the test. `di.shutdown()` is not used because it hangs on `redis.quit()` with no server.
    const di = createDI(
      loadEnv({
        DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
        REDIS_URL: 'redis://127.0.0.1:1',
        AUTH_SECRET: 'x'.repeat(32),
        WEB_ORIGIN: 'http://localhost:5173',
      }),
    );
    try {
      expect(bullmq.opts.get('pipeline')?.defaultJobOptions).toEqual(PIPELINE_JOB_OPTIONS);
      for (const [name, opts] of bullmq.opts) {
        if (name !== 'pipeline') expect(opts.defaultJobOptions, name).toBeUndefined();
      }
    } finally {
      await di.pool.end();
    }
  });
});
