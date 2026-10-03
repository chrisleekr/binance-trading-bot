// The security event recorder against real Postgres and Redis: how repeats fold into one audit row, which failures stay individual, how the notification throttle holds, and that a failing sink is counted under the store that actually broke. The aggregation lives in Redis keys and a jsonb count, so only the real stores show whether the row a later event raises is the row that was written.

import { createMetricsRegistry } from '@app/observability';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGGREGATE_WINDOW_MS,
  NOTIFY_ENQUEUE_TIMEOUT_MS,
  createSecurityEventRecorder,
  type SecurityEventRecorder,
  type SecurityEventRecorderDeps,
} from '../../src/auth/security-events.js';
import { createAuthMetrics, type AuthMetrics } from '../../src/metrics/auth.js';

import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('security event recorder', () => {
  let fx: ApiFixture;
  // A fixed clock keeps every occurrence in one aggregation window, whatever the wall clock does mid-test.
  const NOW = 1_900_000_000_000;
  const windowKey = (event: string, reason: string): string =>
    `auth:agg:${event}:${reason}:${Math.floor(NOW / AGGREGATE_WINDOW_MS)}`;

  const build = (
    overrides: Partial<SecurityEventRecorderDeps> = {},
  ): {
    recorder: SecurityEventRecorder;
    metrics: AuthMetrics;
    add: ReturnType<typeof vi.fn>;
  } => {
    const add = vi.fn(async () => undefined);
    const metrics = createAuthMetrics(createMetricsRegistry({ service: 'recorder-test' }).registry);
    const recorder = createSecurityEventRecorder({
      db: fx.di.db,
      redis: fx.di.redis.raw(),
      queue: { add } as unknown as SecurityEventRecorderDeps['queue'],
      logger: pino({ level: 'silent' }),
      metrics,
      now: () => NOW,
      ...overrides,
    });
    return { recorder, metrics, add };
  };

  const sinkFailures = async (metrics: AuthMetrics, sink: string): Promise<number> =>
    (await metrics.sinkFailures.get()).values.find((v) => v.labels['sink'] === sink)?.value ?? 0;

  const rows = async (event: string): Promise<Record<string, unknown>[]> =>
    (
      await fx.di.pool.query<{ payload: Record<string, unknown> }>(
        `select payload from audit_logs where category = 'security' and event = $1`,
        [event],
      )
    ).rows.map((r) => r.payload);

  beforeAll(async () => {
    fx = await setupApp();
  });
  beforeEach(async () => {
    await fx.di.pool.query(`delete from audit_logs where category = 'security'`);
    const redis = fx.di.redis.raw();
    const keys = [...(await redis.keys('auth:agg:*')), ...(await redis.keys('auth:notify:*'))];
    if (keys.length > 0) await redis.del(...keys);
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('folds eight repeats into one row counting all eight, and notifies once inside the throttle window', async () => {
    const { recorder, add } = build();
    for (let i = 0; i < 8; i++) {
      await recorder.record({
        event: 'rate-limited',
        reason: 'ip_address',
        ipAddress: '198.51.100.7',
      });
    }
    // The row is rewritten only at power-of-two totals (2, 4, 8), so eight lands exactly on the last rewrite.
    expect(await rows('rate-limited')).toEqual([expect.objectContaining({ count: 8 })]);
    expect(add).toHaveBeenCalledOnce();
  });

  it('writes the exact total once the window closes, not the last power of two', async () => {
    const scheduled: { run: () => void; delayMs: number }[] = [];
    const { recorder } = build({ schedule: (run, delayMs) => scheduled.push({ run, delayMs }) });
    for (let i = 0; i < 20; i++)
      await recorder.record({
        event: 'rate-limited',
        reason: 'ip_address',
        ipAddress: '198.51.100.7',
      });
    // Mid-window the row holds the last power of two, which is why the closing write exists.
    expect(await rows('rate-limited')).toEqual([expect.objectContaining({ count: 16 })]);
    // Only the occurrence that opened the window schedules, so a flood costs one extra write, not one per repeat.
    expect(scheduled).toHaveLength(1);
    const windowEnd = (Math.floor(NOW / AGGREGATE_WINDOW_MS) + 1) * AGGREGATE_WINDOW_MS;
    expect(scheduled[0]?.delayMs).toBe(windowEnd - NOW + 1000);
    // The counter must outlive the window, or the closing write would find nothing to read.
    expect(
      await fx.di.redis.raw().pttl(`${windowKey('rate-limited', 'ip_address')}:n`),
    ).toBeGreaterThan(AGGREGATE_WINDOW_MS);
    scheduled[0]?.run();
    await vi.waitFor(async () =>
      expect(await rows('rate-limited')).toEqual([expect.objectContaining({ count: 20 })]),
    );
  });

  it('counts a failed closing write under the aggregate sink and does not throw from the timer', async () => {
    const scheduled: (() => void)[] = [];
    const redis = fx.di.redis.raw();
    const { recorder, metrics } = build({ schedule: (run) => scheduled.push(run) });
    for (let i = 0; i < 3; i++)
      await recorder.record({
        event: 'rate-limited',
        reason: 'ip_address',
        ipAddress: '198.51.100.7',
      });
    const get = vi.spyOn(redis, 'get').mockRejectedValueOnce(new Error('redis gone'));
    scheduled[0]?.();
    await vi.waitFor(async () => expect(await sinkFailures(metrics, 'aggregate')).toBe(1));
    get.mockRestore();
    expect(await rows('rate-limited')).toEqual([expect.objectContaining({ count: 2 })]);
  });

  it('shows a valid address exactly in the notification, so it can be pasted into a firewall rule, and defangs anything else in that field', async () => {
    const { recorder, add } = build();
    const addressOf = (call: number): string | undefined =>
      (
        add.mock.calls[call]?.[1] as { fields: { label: string; value: string }[] } | undefined
      )?.fields.find((f) => f.label === 'IP address')?.value;
    await recorder.record({ event: 'account-locked', reason: 'locked', ipAddress: '198.51.100.7' });
    await recorder.record({
      event: 'ip-address-blocked',
      reason: 'ip_address',
      ipAddress: '2001:db8::1',
    });
    // Without a proxy the address header is whatever the client sent.
    await recorder.record({
      event: 'signed-out-everywhere',
      actor: 'user',
      ipAddress: 'evil.example/login',
    });
    expect(addressOf(0)).toBe('198.51.100.7');
    expect(addressOf(1)).toBe('2001:db8::1');
    expect(addressOf(2)).not.toContain('.');
  });

  it('records each failed sign-in against the operator’s own email as its own row', async () => {
    const { recorder } = build();
    for (let i = 0; i < 2; i++) {
      await recorder.record({
        event: 'sign-in-failed',
        method: 'password',
        reason: 'invalid_credentials',
        emailMatched: true,
      });
    }
    expect(await rows('sign-in-failed')).toEqual([
      expect.objectContaining({ count: 1, emailMatched: true }),
      expect.objectContaining({ count: 1, emailMatched: true }),
    ]);
  });

  it('counts a notification the queue refused under the notify sink, and still writes the row', async () => {
    const { recorder, metrics, add } = build();
    add.mockRejectedValueOnce(new Error('queue unavailable'));
    await recorder.record({ event: 'rate-limited', reason: 'email' });
    expect(await sinkFailures(metrics, 'notify')).toBe(1);
    expect(await sinkFailures(metrics, 'audit')).toBe(0);
    expect(await rows('rate-limited')).toHaveLength(1);
  });

  it('gives up on a notification the queue never accepts, so a Redis outage cannot hang the request that recorded it', async () => {
    const { recorder, metrics, add } = build();
    // BullMQ's connection retries forever while Redis is down, so its add() never settles.
    add.mockReturnValueOnce(new Promise(() => undefined));
    const started = Date.now();
    await recorder.record({ event: 'rate-limited', reason: 'email' });
    expect(Date.now() - started).toBeLessThan(NOTIFY_ENQUEUE_TIMEOUT_MS + 1000);
    expect(await sinkFailures(metrics, 'notify')).toBe(1);
    expect(await rows('rate-limited')).toHaveLength(1);
  });

  it('releases the window when the claiming row could not be written, so the next repeat writes a row instead of raising one that does not exist', async () => {
    const db = fx.di.db;
    const refusingInserts = new Proxy(db, {
      get: (target, property) => {
        if (property === 'insert')
          return () => {
            throw new Error('audit insert refused');
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const failing = build({ db: refusingInserts });
    await failing.recorder.record({ event: 'rate-limited', reason: 'site_wide' });
    expect(await sinkFailures(failing.metrics, 'audit')).toBe(1);
    expect(await fx.di.redis.raw().exists(windowKey('rate-limited', 'site_wide'))).toBe(0);

    await build().recorder.record({ event: 'rate-limited', reason: 'site_wide' });
    expect(await rows('rate-limited')).toEqual([expect.objectContaining({ count: 1 })]);
  });

  it('counts a Redis failure in the aggregation under the aggregate sink, not as a failed audit write', async () => {
    const redis = fx.di.redis.raw();
    const brokenRedis = new Proxy(redis, {
      get: (target, property) => {
        if (property === 'set') return async () => Promise.reject(new Error('redis unavailable'));
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const { recorder, metrics } = build({ redis: brokenRedis });
    await recorder.record({
      event: 'sign-in-failed',
      method: 'password',
      reason: 'invalid_credentials',
      emailMatched: false,
    });
    expect(await sinkFailures(metrics, 'aggregate')).toBe(1);
    expect(await sinkFailures(metrics, 'audit')).toBe(0);
  });
});
