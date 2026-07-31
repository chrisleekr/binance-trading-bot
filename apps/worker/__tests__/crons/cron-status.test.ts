// Contract for the cron-status recorder: record the terminal outcome to the
// cron-status hash without ever changing the cron's own result.

import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';

import { withCronStatus, sanitizeCronError } from '../../src/crons/cron-status.js';

const silent = pino({ level: 'silent' });
const job = { id: 'j1', data: {} } as Job;

describe('sanitizeCronError', () => {
  it('redacts postgres credentials', () => {
    expect(sanitizeCronError('connect postgres://app:s3cr3t@db:5432/x failed')).toBe(
      'connect postgres://***@db:5432/x failed',
    );
  });

  it('redacts absolute filesystem paths', () => {
    expect(sanitizeCronError("ENOENT, open '/srv/backups/backup-1.dump'")).toContain('<path>');
    expect(sanitizeCronError("ENOENT, open '/srv/backups/backup-1.dump'")).not.toContain('/srv/');
  });

  it('bounds the length to 300 chars with an ellipsis', () => {
    const out = sanitizeCronError('x'.repeat(500));
    expect(out.length).toBe(301); // 300 + the ellipsis char
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves an ordinary message untouched', () => {
    expect(sanitizeCronError('cron blew up')).toBe('cron blew up');
  });
});

describe('withCronStatus', () => {
  it('records an ok run with a duration on success', async () => {
    const hset = vi.fn(async () => 1);
    const redis = { hset } as unknown as Redis;
    await withCronStatus(redis, silent, 'discovery-run', async () => undefined)(job);
    expect(hset).toHaveBeenCalledTimes(1);
    const [key, field, value] = hset.mock.calls[0] as unknown as [string, string, string];
    expect(key).toBe('worker:cron-status');
    expect(field).toBe('discovery-run');
    expect(JSON.parse(value)).toMatchObject({ status: 'ok' });
    expect(JSON.parse(value).durationMs).toBeGreaterThanOrEqual(0);
  });

  it('redacts postgres credentials and absolute paths from the recorded error', async () => {
    const hset = vi.fn(async () => 1);
    const redis = { hset } as unknown as Redis;
    await expect(
      withCronStatus(redis, silent, 'db-backup', async () => {
        throw new Error('pg_dump failed for postgres://app:s3cr3t@db.internal:5432/trading');
      })(job),
    ).rejects.toThrow();
    const recorded = JSON.parse((hset.mock.calls[0] as unknown as string[])[2] as string).error;
    expect(recorded).not.toContain('s3cr3t');
    expect(recorded).toContain('postgres://***@');
  });

  it('records an error AND rethrows the original error on failure', async () => {
    const hset = vi.fn(async () => 1);
    const redis = { hset } as unknown as Redis;
    const boom = new Error('cron blew up');
    await expect(
      withCronStatus(redis, silent, 'market-trend', async () => {
        throw boom;
      })(job),
    ).rejects.toBe(boom);
    expect(JSON.parse((hset.mock.calls[0] as unknown as string[])[2] as string)).toMatchObject({
      status: 'error',
      error: 'cron blew up',
    });
  });

  it('swallows a status-write failure on a successful run (never fails a healthy cron)', async () => {
    const redis = {
      hset: vi.fn(async () => {
        throw new Error('redis down');
      }),
    } as unknown as Redis;
    await expect(
      withCronStatus(redis, silent, 'db-backup', async () => undefined)(job),
    ).resolves.toBeUndefined();
  });

  it('still rethrows the handler error even if the status write also fails', async () => {
    const redis = {
      hset: vi.fn(async () => {
        throw new Error('redis down');
      }),
    } as unknown as Redis;
    const boom = new Error('handler failed');
    await expect(
      withCronStatus(redis, silent, 'edge-decay-monitor', async () => {
        throw boom;
      })(job),
    ).rejects.toBe(boom);
  });
});
