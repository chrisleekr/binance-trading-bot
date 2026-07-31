import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import type { ActiveProfile } from '../../src/profile-manager/profile-manager.js';
import { createRedisWindowThrottle } from '../../src/executor/notifier-gap-throttle.js';
import {
  assessDiscoveryHealth,
  discoveryHealthHandler,
  DEFAULT_DISCOVERY_HEALTH_WINDOW_MS,
  DISCOVERY_HEALTH_KEY_PREFIX,
  DISCOVERY_HEALTH_WINDOW,
  type DiscoveryHealthDeps,
  type SnapshotHealth,
} from '../../src/crons/discovery-health.cron.js';

const NOW = 1_700_000_000_000;
const REFRESH = 900_000; // 15 min

const profile = (id: string): ActiveProfile => ({
  profileId: asProfileId(`00000000-0000-4000-8000-${id.padStart(12, '0')}`),
  userId: asUserId('00000000-0000-4000-8000-000000000099'),
  operatorId: asUserId('00000000-0000-4000-8000-000000000099'),
  accountId: asAccountId('00000000-0000-4000-8000-0000000000aa'),
  candleInterval: '1h',
  symbols: [],
  technicalsIntervals: [],
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

const snap = (capturedAtMs: number, breadthOk: boolean | undefined): SnapshotHealth => ({
  capturedAtMs,
  breadthOk,
});

const fullWindow = (breadthOk: boolean): SnapshotHealth[] =>
  Array.from({ length: DISCOVERY_HEALTH_WINDOW }, (_, i) => snap(NOW - i * 60_000, breadthOk));

const buildDeps = (over: Partial<DiscoveryHealthDeps>): DiscoveryHealthDeps => ({
  logger,
  listActive: () => [profile('1')],
  loadConfig: vi.fn(async () => ({ refreshPeriodMs: REFRESH })),
  recentSnapshots: vi.fn(async () => fullWindow(true)),
  notify: vi.fn(async () => undefined),
  allowAlert: vi.fn(async () => true),
  clock: { nowMs: () => NOW },
  ...over,
});

const run = (deps: DiscoveryHealthDeps): Promise<void> => discoveryHealthHandler(deps)({} as Job);

describe('assessDiscoveryHealth', () => {
  it('reads an empty history as stale and not breadth-blocked', () => {
    expect(assessDiscoveryHealth([], REFRESH, NOW, DISCOVERY_HEALTH_WINDOW)).toEqual({
      stale: true,
      breadthBlocked: false,
    });
  });

  it('is stale when the newest snapshot is older than twice the refresh period', () => {
    const r = assessDiscoveryHealth(
      [snap(NOW - 3 * REFRESH, true)],
      REFRESH,
      NOW,
      DISCOVERY_HEALTH_WINDOW,
    );
    expect(r.stale).toBe(true);
  });

  it('is not stale at exactly twice the refresh period (strict >)', () => {
    const r = assessDiscoveryHealth(
      [snap(NOW - 2 * REFRESH, true)],
      REFRESH,
      NOW,
      DISCOVERY_HEALTH_WINDOW,
    );
    expect(r.stale).toBe(false);
  });

  it('breadth-blocks only on a FULL window that is all breadthOk=false', () => {
    expect(
      assessDiscoveryHealth(fullWindow(false), REFRESH, NOW, DISCOVERY_HEALTH_WINDOW)
        .breadthBlocked,
    ).toBe(true);
    // One fewer than a full window is not yet evidence of persistence.
    expect(
      assessDiscoveryHealth(
        fullWindow(false).slice(0, DISCOVERY_HEALTH_WINDOW - 1),
        REFRESH,
        NOW,
        DISCOVERY_HEALTH_WINDOW,
      ).breadthBlocked,
    ).toBe(false);
  });

  it('does not breadth-block when any snapshot is not strictly false (undefined breaks the run)', () => {
    const withGap = fullWindow(false);
    withGap[3] = snap(NOW - 3 * 60_000, undefined); // an old row predating the funnel field
    expect(
      assessDiscoveryHealth(withGap, REFRESH, NOW, DISCOVERY_HEALTH_WINDOW).breadthBlocked,
    ).toBe(false);
  });
});

describe('discoveryHealthHandler', () => {
  it('alerts exactly once on a stale profile (T1)', async () => {
    const notify = vi.fn(async () => undefined);
    await run(
      buildDeps({ recentSnapshots: vi.fn(async () => [snap(NOW - 3 * REFRESH, true)]), notify }),
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ category: 'discovery-health' });
    expect(notify.mock.calls[0][0].body).toMatch(/not produced a scan/i);
  });

  it('alerts exactly once on a persistent breadth block (T2)', async () => {
    const notify = vi.fn(async () => undefined);
    await run(buildDeps({ recentSnapshots: vi.fn(async () => fullWindow(false)), notify }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].body).toMatch(/market-breadth/i);
  });

  it('stays silent on a fresh, breadth-healthy profile', async () => {
    const notify = vi.fn(async () => undefined);
    await run(buildDeps({ recentSnapshots: vi.fn(async () => fullWindow(true)), notify }));
    expect(notify).not.toHaveBeenCalled();
  });

  it('skips a profile whose discovery is disabled (no snapshot read, no alert)', async () => {
    const recentSnapshots = vi.fn(async () => fullWindow(false));
    const notify = vi.fn(async () => undefined);
    await run(buildDeps({ loadConfig: vi.fn(async () => null), recentSnapshots, notify }));
    expect(recentSnapshots).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('suppresses the alert when the throttle denies the window', async () => {
    const notify = vi.fn(async () => undefined);
    await run(
      buildDeps({
        recentSnapshots: vi.fn(async () => [snap(NOW - 3 * REFRESH, true)]),
        notify,
        allowAlert: vi.fn(async () => false),
      }),
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it('isolates a throwing profile so the others are still scanned', async () => {
    const notify = vi.fn(async () => undefined);
    const good = profile('2');
    const deps = buildDeps({
      listActive: () => [profile('1'), good],
      recentSnapshots: vi.fn(async (p: ActiveProfile) => {
        if (p.profileId === profile('1').profileId) throw new Error('boom');
        return [snap(NOW - 3 * REFRESH, true)];
      }),
      notify,
    });
    await run(deps);
    // The healthy-path profile still alerted despite the first throwing.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].profileId).toBe(good.profileId);
  });
});

// The cron wires its per-(profile, trigger) throttle from the same
// `createRedisWindowThrottle` primitive as the notifier-gap throttle (its own
// fail-open + timeout behaviour is proven in executor/notifier-gap-throttle.test).
// These assert THIS throttle's namespace, window, and keying: a second identical
// scan is suppressed, the two triggers never share a key, and a Redis fault fails
// open so a real health alert is never silently dropped.
describe('discovery-health throttle wiring', () => {
  const fakeLogger = () => ({ warn: vi.fn() }) as unknown as Logger;
  const key = (trigger: string, pid: string) => `${trigger}:${pid}`;

  it('opens a namespaced 1h window with NX and suppresses the second identical scan', async () => {
    const set = vi.fn<Redis['set']>().mockResolvedValueOnce('OK').mockResolvedValue(null);
    const redis = { set } as unknown as Redis;
    const t = createRedisWindowThrottle({
      redis,
      logger: fakeLogger(),
      prefix: DISCOVERY_HEALTH_KEY_PREFIX,
      windowMs: DEFAULT_DISCOVERY_HEALTH_WINDOW_MS,
    });

    expect(await t.allow(key('stale', 'p1'))).toBe(true);
    expect(await t.allow(key('stale', 'p1'))).toBe(false);
    expect(set).toHaveBeenNthCalledWith(
      1,
      `${DISCOVERY_HEALTH_KEY_PREFIX}stale:p1`,
      '1',
      'PX',
      DEFAULT_DISCOVERY_HEALTH_WINDOW_MS,
      'NX',
    );
    expect(DEFAULT_DISCOVERY_HEALTH_WINDOW_MS).toBe(3_600_000);
  });

  it('keys the two triggers separately so a staleness window cannot suppress a breadth alert', async () => {
    const set = vi.fn<Redis['set']>().mockResolvedValue('OK');
    const redis = { set } as unknown as Redis;
    const t = createRedisWindowThrottle({
      redis,
      logger: fakeLogger(),
      prefix: DISCOVERY_HEALTH_KEY_PREFIX,
      windowMs: DEFAULT_DISCOVERY_HEALTH_WINDOW_MS,
    });

    expect(await t.allow(key('stale', 'p1'))).toBe(true);
    expect(await t.allow(key('breadth-block', 'p1'))).toBe(true);
    expect(set.mock.calls.map((c) => c[0])).toEqual([
      `${DISCOVERY_HEALTH_KEY_PREFIX}stale:p1`,
      `${DISCOVERY_HEALTH_KEY_PREFIX}breadth-block:p1`,
    ]);
    // The same trigger on two different profiles keys separately, so one profile's
    // open window never suppresses another profile's alert.
    expect(key('stale', 'p1')).not.toBe(key('stale', 'p2'));
  });

  it('fails open when Redis is unavailable so a real health alert is not dropped', async () => {
    const set = vi.fn<Redis['set']>().mockRejectedValue(new Error('ECONNREFUSED'));
    const redis = { set } as unknown as Redis;
    const logger = fakeLogger();
    const t = createRedisWindowThrottle({
      redis,
      logger,
      prefix: DISCOVERY_HEALTH_KEY_PREFIX,
      windowMs: DEFAULT_DISCOVERY_HEALTH_WINDOW_MS,
    });

    expect(await t.allow(key('stale', 'p1'))).toBe(true);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
