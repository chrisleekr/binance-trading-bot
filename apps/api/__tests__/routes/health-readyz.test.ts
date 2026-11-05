import { describe, expect, it, vi } from 'vitest';

import type { DI } from '../../src/di.js';
import { healthRouter } from '../../src/routes/health.js';

const buildDi = (info: () => Promise<string>) => {
  const warn = vi.fn();
  const di = {
    pool: { query: vi.fn(async () => ({ rows: [] })) },
    redis: { raw: () => ({ ping: async () => 'PONG' }) },
    queue: { getBackend: () => ({ client: Promise.resolve({ info }) }) },
    logger: { warn },
  } as unknown as DI;
  return { di, warn };
};

describe('GET /readyz', () => {
  it('is ready when the database, redis and the queue connection all answer', async () => {
    const info = vi.fn(async () => '# Server');
    const { di } = buildDi(info);
    const res = await healthRouter(di).router.request('/readyz');
    expect(res.status).toBe(200);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('is not ready, and logs why, when the queue connection round trip fails', async () => {
    const { di, warn } = buildDi(async () => {
      throw new Error('queue connection lost');
    });
    const res = await healthRouter(di).router.request('/readyz');
    expect(res.status).toBe(503);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'readyz_failed',
    );
  });
});
