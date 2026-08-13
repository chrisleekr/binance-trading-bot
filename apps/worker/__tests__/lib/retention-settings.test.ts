// The retention-settings cache sits on two hot paths (the per-tick XADD and the
// per-pass drain policy), so what is pinned here is not "does it read the row"
// but the three properties that keep those paths safe: it does not hit Postgres
// per tick, it never rejects, and an armed capture that has lapsed reads as OFF
// without anything having to run to disarm it.

import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';

import type { RetentionConfigRow } from '@app/db';

const get = vi.hoisted(() => vi.fn());
vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return {
    ...orig,
    repo: { ...orig.repo, retentionConfig: { ...orig.repo.retentionConfig, get } },
  };
});

const { createRetentionSettingsCache, RETENTION_SETTINGS_TTL_MS } =
  await import('../../src/lib/retention-settings.js');

const silentLogger = pino({ level: 'silent' });
const db = {} as never;

const row = (over: Partial<RetentionConfigRow> = {}): RetentionConfigRow =>
  ({
    id: 1,
    actionLogDays: 1,
    actionLogMaxRows: 200_000,
    auditLogDays: 90,
    auditStreamMaxlen: 250_000,
    debugCaptureProfileId: null,
    debugCaptureUntil: null,
    updatedAt: new Date(0),
    ...over,
  }) as RetentionConfigRow;

/** Clock the test advances by hand, so TTL behaviour is asserted rather than waited on. */
const fakeClock = (start = 1_000_000) => {
  let nowMs = start;
  return { nowMs: () => nowMs, advance: (ms: number) => (nowMs += ms) };
};

describe('createRetentionSettingsCache', () => {
  it('serves the seeded defaults before the first read resolves, with capture off', async () => {
    // Cold start must fail closed: a capture that defaulted ON would fill the
    // disk of a box whose config table is simply not reachable yet.
    get.mockRejectedValueOnce(new Error('db down'));
    const cache = createRetentionSettingsCache({ db, logger: silentLogger });
    expect(await cache.get()).toEqual({
      auditStreamMaxlen: 100_000,
      debugCaptureProfileId: null,
    });
  });

  it('reads once per TTL rather than once per call', async () => {
    get.mockResolvedValue(row());
    const clock = fakeClock();
    const cache = createRetentionSettingsCache({ db, logger: silentLogger, clock });
    get.mockClear();

    await cache.get();
    await cache.get();
    await cache.get();
    expect(get).toHaveBeenCalledTimes(1);

    clock.advance(RETENTION_SETTINGS_TTL_MS);
    await cache.get();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('collapses a burst of concurrent misses into one read', async () => {
    // A stampede here would be one Postgres round-trip per tick at the exact
    // moment the cache expired, which is the failure the cache exists to avoid.
    get.mockResolvedValue(row());
    const cache = createRetentionSettingsCache({ db, logger: silentLogger, clock: fakeClock() });
    get.mockClear();
    await Promise.all([cache.get(), cache.get(), cache.get(), cache.get()]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('keeps serving the last good snapshot when a refresh throws', async () => {
    get.mockResolvedValueOnce(row({ auditStreamMaxlen: 250_000 }));
    const clock = fakeClock();
    const cache = createRetentionSettingsCache({ db, logger: silentLogger, clock });
    expect((await cache.get()).auditStreamMaxlen).toBe(250_000);

    get.mockRejectedValueOnce(new Error('connection reset'));
    clock.advance(RETENTION_SETTINGS_TTL_MS);
    await expect(cache.get()).resolves.toEqual({
      auditStreamMaxlen: 250_000,
      debugCaptureProfileId: null,
    });
  });

  it('reports an armed capture while its window is open', async () => {
    const clock = fakeClock();
    get.mockResolvedValue(
      row({
        debugCaptureProfileId: '22222222-2222-2222-2222-222222222222',
        debugCaptureUntil: new Date(clock.nowMs() + 60_000),
      }),
    );
    const cache = createRetentionSettingsCache({ db, logger: silentLogger, clock });
    expect((await cache.get()).debugCaptureProfileId).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('reads a lapsed capture as off without anything having to disarm it', async () => {
    // The row still names a profile; only the deadline has passed. Nothing runs
    // at expiry, so if this were read from the column alone a capture would
    // survive a worker restart forever.
    const clock = fakeClock();
    get.mockResolvedValue(
      row({
        debugCaptureProfileId: '22222222-2222-2222-2222-222222222222',
        debugCaptureUntil: new Date(clock.nowMs() - 1),
      }),
    );
    const cache = createRetentionSettingsCache({ db, logger: silentLogger, clock });
    expect((await cache.get()).debugCaptureProfileId).toBeNull();
  });
});
