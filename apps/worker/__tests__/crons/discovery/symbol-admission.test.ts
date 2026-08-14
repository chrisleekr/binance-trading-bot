// The admission map is the only place the cached symbol-info entry is turned
// into a tradability fact. A cache entry written before permission capture, or
// one carrying a malformed value, must land as "no constraint published" rather
// than as an empty constraint, which would read as forbidden.

import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { Redis } from 'ioredis';

import { fetchSymbolAdmission } from '../../../src/crons/discovery/symbol-admission.js';

const silent = pino({ level: 'silent' });

const scanRedis = (entries: Record<string, string>): Pick<Redis, 'scan' | 'mget'> =>
  ({
    scan: vi.fn(async () => ['0', Object.keys(entries)] as [string, string[]]),
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => entries[k] ?? null)),
  }) as unknown as Pick<Redis, 'scan' | 'mget'>;

describe('fetchSymbolAdmission', () => {
  it('carries both the status and a well-formed permission-set list', async () => {
    const redis = scanRedis({
      'symbol-info:live:BTCUSDT': JSON.stringify({
        symbol: 'BTCUSDT',
        status: 'TRADING',
        permissionSets: [['SPOT', 'TRD_GRP_025']],
      }),
    });
    const out = await fetchSymbolAdmission(redis, silent, 'live', 'cron discovery');
    expect(out.get('BTCUSDT')).toEqual({
      status: 'TRADING',
      permissionSets: [['SPOT', 'TRD_GRP_025']],
    });
  });

  it('omits permissionSets entirely for a stale or malformed entry', async () => {
    // Cache entries survive a deploy; one written by the previous build has no
    // permissionSets at all. Omitting the key keeps absent and unreadable
    // identical, and both fail open.
    const redis = scanRedis({
      'symbol-info:live:OLDUSDT': JSON.stringify({ symbol: 'OLDUSDT', status: 'TRADING' }),
      'symbol-info:live:BADUSDT': JSON.stringify({
        symbol: 'BADUSDT',
        status: 'TRADING',
        permissionSets: 'SPOT',
      }),
    });
    const out = await fetchSymbolAdmission(redis, silent, 'live', 'cron discovery');
    expect(out.get('OLDUSDT')).toEqual({ status: 'TRADING' });
    expect(out.get('BADUSDT')).toEqual({ status: 'TRADING' });
  });

  it('skips one unparseable value without blinding the whole read', async () => {
    const redis = scanRedis({
      'symbol-info:live:BTCUSDT': '{not json',
      'symbol-info:live:ETHUSDT': JSON.stringify({ symbol: 'ETHUSDT', status: 'TRADING' }),
    });
    const out = await fetchSymbolAdmission(redis, silent, 'live', 'cron discovery');
    expect([...out.keys()]).toEqual(['ETHUSDT']);
  });

  it('returns an empty map on a Redis fault rather than throwing', async () => {
    const redis = {
      scan: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      mget: vi.fn(),
    } as unknown as Pick<Redis, 'scan' | 'mget'>;
    expect((await fetchSymbolAdmission(redis, silent, 'live', 'cron discovery')).size).toBe(0);
  });
});
