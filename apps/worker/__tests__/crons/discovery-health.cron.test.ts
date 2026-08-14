import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  asAccountId,
  asProfileId,
  asUserId,
  DISCOVERY_HEALTH_WINDOW,
  type SnapshotHealth,
} from '@app/contracts';
import type { ActiveProfile } from '../../src/profile-manager/profile-manager.js';
import { createRedisWindowThrottle } from '../../src/executor/notifier-gap-throttle.js';
import {
  discoveryHealthHandler,
  DEFAULT_DISCOVERY_HEALTH_WINDOW_MS,
  DISCOVERY_HEALTH_KEY_PREFIX,
  type DiscoveryHealthDeps,
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
  recordCondition: vi.fn(async () => undefined),
  clock: { nowMs: () => NOW },
  ...over,
});

const run = (deps: DiscoveryHealthDeps): Promise<void> => discoveryHealthHandler(deps)({} as Job);

/** The code recorded for one condition on this pass, or undefined if untouched. */
const codeFor = (
  spy: DiscoveryHealthDeps['recordCondition'],
  condition: string,
): string | null | undefined =>
  (
    spy as unknown as {
      mock: { calls: [ActiveProfile, { condition: string; code: string | null }][] };
    }
  ).mock.calls.find((c) => c[1].condition === condition)?.[1].code;

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

// The conditions are what the diagnosis reads; the alerts are what interrupts
// the operator. They are recorded on different rules on purpose, and these pin
// that difference — an hourly alert window must never become the resolution of
// "is discovery stale right now".
describe('discovery-health condition recording', () => {
  it('records both conditions open when both verdicts fire', async () => {
    const recordCondition = vi.fn(async () => undefined);
    await run(
      buildDeps({
        // Every row aged past the staleness bound: the verdict maxes over the
        // whole window, so one old row among fresh ones is not a stall.
        recentSnapshots: vi.fn(async () =>
          fullWindow(false).map((s) => snap(s.capturedAtMs - 3 * REFRESH, false)),
        ),
        recordCondition,
      }),
    );
    expect(codeFor(recordCondition, 'discovery-stale')).toBe('no-recent-scan');
    expect(codeFor(recordCondition, 'discovery-breadth-blocked')).toBe('breadth-floor');
  });

  it('clears both conditions on a healthy pass, which no alert ever does', async () => {
    const recordCondition = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    await run(
      buildDeps({ recentSnapshots: vi.fn(async () => fullWindow(true)), notify, recordCondition }),
    );
    expect(notify).not.toHaveBeenCalled();
    expect(codeFor(recordCondition, 'discovery-stale')).toBeNull();
    expect(codeFor(recordCondition, 'discovery-breadth-blocked')).toBeNull();
  });

  it('records the condition even when the throttle suppresses the alert', async () => {
    const recordCondition = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    await run(
      buildDeps({
        recentSnapshots: vi.fn(async () => [snap(NOW - 3 * REFRESH, true)]),
        notify,
        allowAlert: vi.fn(async () => false),
        recordCondition,
      }),
    );
    // Suppressing the notification must not make the profile look healthy.
    expect(notify).not.toHaveBeenCalled();
    expect(codeFor(recordCondition, 'discovery-stale')).toBe('no-recent-scan');
  });

  it('does not let a failed condition write suppress the alert', async () => {
    const notify = vi.fn(async () => undefined);
    await run(
      buildDeps({
        recentSnapshots: vi.fn(async () => [snap(NOW - 3 * REFRESH, true)]),
        notify,
        recordCondition: vi.fn(async () => {
          throw new Error('condition boom');
        }),
      }),
    );
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('writes no condition for a profile whose discovery is disabled', async () => {
    const recordCondition = vi.fn(async () => undefined);
    await run(buildDeps({ loadConfig: vi.fn(async () => null), recordCondition }));
    expect(recordCondition).not.toHaveBeenCalled();
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
