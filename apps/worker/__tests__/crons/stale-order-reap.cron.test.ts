import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { pino } from 'pino';

import { buildStaleOrderReapCron } from '../../src/crons/stale-order-reap.cron.js';
import { buildCrons } from '../../src/crons/index.js';
import type { BootContext } from '../../src/boot/boot-context.js';

type RunReaper = typeof import('../../src/boot/reap-stale-orders.js').runStaleOrderReaper;
const runReaper = vi.hoisted(() =>
  vi.fn<RunReaper>(async () => ({ checked: 0, reaped: 0, reclaimed: 0, failed: 0 })),
);
vi.mock('../../src/boot/reap-stale-orders.js', () => ({ runStaleOrderReaper: runReaper }));

const listActive = vi.fn(() => []);
const resolveBinanceClient = vi.fn();

const ctx = (): BootContext =>
  ({
    db: {},
    logger: pino({ level: 'silent' }),
    listActive,
    resolveBinanceClient,
    redis: { raw: () => ({}) },
    queueSet: { queues: {} },
    // `buildCrons` constructs every cron, several of which read a retention/env
    // knob at build time. The registration assertion only cares about the NAMES.
    workerEnv: new Proxy({}, { get: () => 1 }),
  }) as unknown as BootContext;

describe('stale-order-reap cron', () => {
  it('runs the reaper over the active profiles with the shared account clients', async () => {
    runReaper.mockClear();
    const def = buildStaleOrderReapCron(ctx());

    await def.handler({} as Job);

    expect(runReaper).toHaveBeenCalledOnce();
    expect(runReaper.mock.calls[0]?.[0]).toMatchObject({
      listActive,
      resolveBinance: resolveBinanceClient,
    });
  });

  it('self-reschedules rather than running on a fixed pattern', async () => {
    // The reaper fans out a getOrder per live row across every profile. A fixed
    // scheduler would mint the next iteration regardless of whether the last
    // finished, so two runs could re-derive the same answer on the account's
    // Binance weight budget.
    const def = buildStaleOrderReapCron(ctx());

    expect(def.selfReschedulePeriodMs).toBe(900_000);
    expect(def.pattern).toBeUndefined();
    expect(def.queue).toBe('stale-order-reap');
  });

  it('is REGISTERED — a cron nobody schedules is the bug it fixes', async () => {
    // The reaper existed all along and ran only at boot, which on a worker that
    // does not restart means never: an order the operator cancelled ON BINANCE
    // stayed `NEW` / `closed_at NULL` in our table indefinitely, showing as open in
    // the UI and counting toward the account's exposure.
    const names = buildCrons(ctx()).map((c) => c.name);

    expect(names).toContain('stale-order-reap');
  });
});
