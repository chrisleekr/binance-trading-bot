// The account's Binance permission tags back the order pre-flight's refusal.
// The write side's only real rule: never let an empty read overwrite a good
// cached list, because readers treat an empty list as "unknown" and fail open,
// which is exactly the storm the cache exists to stop.

import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';

import { asAccountId } from '@app/contracts';

import {
  readAccountPermissions,
  writeAccountPermissions,
} from '../../src/lib/account-permissions.js';
import { buildAccountPermissionsKey } from '../../src/executor/redis-namespace.js';

const ACCOUNT = asAccountId('00000000-0000-0000-0000-0000000000cc');

const fakeRedis = () => ({ set: vi.fn(async () => 'OK') }) as unknown as Redis;

const stubLogger = () => ({ warn: vi.fn() });

describe('writeAccountPermissions', () => {
  it('caches the tags under the account-scoped key with no expiry', async () => {
    // TTL-less deliberately: an expiring key fails open back into the bug.
    const redis = fakeRedis();
    await writeAccountPermissions(redis, ACCOUNT, ['SPOT', 'TRD_GRP_025']);
    expect(redis.set).toHaveBeenCalledWith(
      buildAccountPermissionsKey(ACCOUNT),
      '["SPOT","TRD_GRP_025"]',
    );
  });

  it('writes nothing when Binance returned no permissions', async () => {
    const redis = fakeRedis();
    await writeAccountPermissions(redis, ACCOUNT, undefined);
    await writeAccountPermissions(redis, ACCOUNT, []);
    expect(redis.set).not.toHaveBeenCalled();
  });
});

describe('readAccountPermissions', () => {
  it('reads the cached tags back off the account-scoped key', async () => {
    const redis = { get: vi.fn(async () => '["SPOT","TRD_GRP_025"]') };
    await expect(
      readAccountPermissions(redis, stubLogger(), ACCOUNT, 'cron discovery'),
    ).resolves.toEqual(['SPOT', 'TRD_GRP_025']);
    expect(redis.get).toHaveBeenCalledWith(buildAccountPermissionsKey(ACCOUNT));
  });

  it('degrades a Redis fault to the unknown list instead of throwing', async () => {
    // The discovery handler memoizes this promise per account for a whole wake,
    // so a rejection would be replayed to every remaining profile on the account
    // and skip each one. One optional cut must not cost the wake.
    const logger = stubLogger();
    const redis = {
      get: vi.fn(async () => {
        throw new Error('READONLY You cannot write against a read only replica');
      }),
    };
    await expect(readAccountPermissions(redis, logger, ACCOUNT, 'cron discovery')).resolves.toEqual(
      [],
    );
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
