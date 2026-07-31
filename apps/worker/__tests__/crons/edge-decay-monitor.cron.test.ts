import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Job } from 'bullmq';
import type { AccountId, EdgeDecayVerdict, ProfileId, UserId } from '@app/contracts';

import {
  edgeDecayMonitorHandler,
  shouldAlertOnDecay,
  type EdgeAssessment,
  type EdgeDecayMonitorDeps,
} from '../../src/crons/edge-decay-monitor.cron.js';

const silent = pino({ level: 'silent' });
const U = 'u1' as unknown as UserId;
const A = 'a1' as unknown as AccountId;
const P = 'p1' as unknown as ProfileId;
const job = {} as Job;

const assessment = (over: Partial<EdgeAssessment> = {}): EdgeAssessment => ({
  verdict: 'healthy',
  reason: 'ok',
  liveProfitFactor: 2,
  baselineProfitFactor: 2,
  liveTradeCount: 50,
  ...over,
});

describe('shouldAlertOnDecay', () => {
  it('alerts only on a breach', () => {
    expect(shouldAlertOnDecay('breached')).toBe(true);
  });

  it('never alerts on any non-breach verdict', () => {
    const nonBreach: EdgeDecayVerdict[] = [
      'warning',
      'healthy',
      'insufficient-data',
      'no-baseline',
      'monitor-off',
    ];
    for (const v of nonBreach) expect(shouldAlertOnDecay(v)).toBe(false);
  });
});

const deps = (over: Partial<EdgeDecayMonitorDeps> = {}): EdgeDecayMonitorDeps => ({
  logger: silent,
  listActive: () => [{ operatorId: U, accountId: A, profileId: P } as never],
  assess: vi.fn(async () => null),
  wasNotified: vi.fn(async () => false),
  markNotified: vi.fn(async () => undefined),
  clearNotified: vi.fn(async () => undefined),
  notify: vi.fn(async () => undefined),
  clock: { nowMs: () => 1_000 },
  ...over,
});

describe('edgeDecayMonitorHandler', () => {
  it('does nothing when assess returns null (not live / gone)', async () => {
    const markNotified = vi.fn(async () => undefined);
    const clearNotified = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    await edgeDecayMonitorHandler(
      deps({ assess: async () => null, markNotified, clearNotified, notify }),
    )(job);
    expect(markNotified).not.toHaveBeenCalled();
    expect(clearNotified).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('marks the latch and notifies once on a fresh breach', async () => {
    const markNotified = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    await edgeDecayMonitorHandler(
      deps({
        assess: async () => assessment({ verdict: 'breached', liveProfitFactor: 0.8 }),
        wasNotified: async () => false,
        markNotified,
        notify,
      }),
    )(job);
    expect(markNotified).toHaveBeenCalledTimes(1);
    const call = markNotified.mock.calls[0] as unknown as [AccountId, ProfileId, string];
    expect(JSON.parse(call[2])).toMatchObject({ verdict: 'breached', notifiedAtMs: 1_000 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({
      category: 'edge-decay-warning',
      operatorId: U,
      accountId: A,
      profileId: P,
    });
  });

  it('does not alert on a warning verdict', async () => {
    const markNotified = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    await edgeDecayMonitorHandler(
      deps({
        assess: async () => assessment({ verdict: 'warning' }),
        wasNotified: async () => false,
        markNotified,
        notify,
      }),
    )(job);
    expect(markNotified).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not re-alert when already notified', async () => {
    const markNotified = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    await edgeDecayMonitorHandler(
      deps({
        assess: async () => assessment({ verdict: 'breached' }),
        wasNotified: async () => true,
        markNotified,
        notify,
      }),
    )(job);
    expect(markNotified).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('clears the latch when the edge recovers to healthy', async () => {
    const clearNotified = vi.fn(async () => undefined);
    await edgeDecayMonitorHandler(
      deps({
        assess: async () => assessment({ verdict: 'healthy' }),
        wasNotified: async () => true,
        clearNotified,
      }),
    )(job);
    expect(clearNotified).toHaveBeenCalledTimes(1);
  });

  it('collects per-profile assess failures without throwing', async () => {
    const assess = vi.fn(async () => {
      throw new Error('db down');
    });
    await expect(edgeDecayMonitorHandler(deps({ assess }))(job)).resolves.toBeUndefined();
  });
});
