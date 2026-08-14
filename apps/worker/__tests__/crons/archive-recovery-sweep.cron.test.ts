// archive-recovery-sweep cron: the periodic half of the Trade History repair.
// `listRecoverableSymbols` existed but only the archive SCREEN called it, so a
// cycle that closed without the forward archive firing stayed missing from
// history until the operator happened to open the page. These tests pin the
// fan-out, the per-profile isolation, the burst cap, and — through the real
// builder — the wire shape of the job it enqueues.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { pino } from 'pino';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';

import {
  archiveRecoverySweepHandler,
  buildArchiveRecoverySweepCron,
} from '../../src/crons/archive-recovery-sweep.cron.js';
import { buildCrons } from '../../src/crons/index.js';
import type { BootContext } from '../../src/boot/boot-context.js';
import type { ActiveProfile } from '../../src/profile-manager/profile-manager.js';

const listRecoverableSymbols = vi.hoisted(() => vi.fn(async (): Promise<string[]> => []));
vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return {
    ...orig,
    profileRepo: vi.fn(async () => ({ tradeArchive: { listRecoverableSymbols } })),
  };
});

const OPERATOR_ID = asUserId('00000000-0000-0000-0000-000000000001');
const ACCOUNT_ID = asAccountId('00000000-0000-0000-0000-000000000003');

const profile = (id: string): ActiveProfile =>
  ({
    profileId: asProfileId(id),
    userId: OPERATOR_ID,
    operatorId: OPERATOR_ID,
    accountId: ACCOUNT_ID,
    candleInterval: '1h',
    symbols: [],
    technicalsIntervals: [],
  }) as ActiveProfile;

const P1 = profile('00000000-0000-0000-0000-0000000000a1');
const P2 = profile('00000000-0000-0000-0000-0000000000a2');

const logger = pino({ level: 'silent' });

const ctx = (pipeline?: unknown): BootContext =>
  ({
    db: {},
    logger,
    listActive: () => [P1],
    redis: { raw: () => ({}) },
    queueSet: { queues: { pipeline } },
    // `buildCrons` constructs every cron and several read a retention/env knob
    // at build time; the registration assertion only cares about the NAMES.
    workerEnv: new Proxy({}, { get: () => 1 }),
  }) as unknown as BootContext;

describe('archive-recovery-sweep cron', () => {
  it('enqueues one backfill for a closed cycle that has no archive row', async () => {
    const listRecoverable = vi.fn(async () => ['TSTUSDT']);
    const enqueueBackfill = vi.fn(async () => undefined);

    await archiveRecoverySweepHandler({
      logger,
      listActive: () => [P1],
      listRecoverable,
      enqueueBackfill,
    })({} as Job);

    expect(enqueueBackfill).toHaveBeenCalledOnce();
    expect(enqueueBackfill).toHaveBeenCalledWith(P1, 'TSTUSDT');
  });

  it('enqueues nothing when every closed cycle is already archived', async () => {
    const enqueueBackfill = vi.fn(async () => undefined);

    await archiveRecoverySweepHandler({
      logger,
      listActive: () => [P1, P2],
      listRecoverable: async () => [],
      enqueueBackfill,
    })({} as Job);

    expect(enqueueBackfill).not.toHaveBeenCalled();
  });

  it("keeps sweeping the other profiles when one profile's query fails", async () => {
    // One profile's DB fault must not leave every other profile's history
    // unrepaired — that is the same silent-gap failure this cron exists to fix.
    const enqueueBackfill = vi.fn(async () => undefined);
    const listRecoverable = vi.fn(async (p: ActiveProfile) => {
      if (p.profileId === P1.profileId) throw new Error('scoped query blew up');
      return ['ENAUSDT'];
    });

    await expect(
      archiveRecoverySweepHandler({
        logger,
        listActive: () => [P1, P2],
        listRecoverable,
        enqueueBackfill,
      })({} as Job),
    ).resolves.toBeUndefined();

    expect(enqueueBackfill).toHaveBeenCalledOnce();
    expect(enqueueBackfill).toHaveBeenCalledWith(P2, 'ENAUSDT');
  });

  it("caps one profile's burst at five symbols so a long backlog drains over runs", async () => {
    // Each enqueued job paginates myTrades against ONE account's weight budget.
    const enqueueBackfill = vi.fn(async () => undefined);
    const symbols = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((s) => `${s}USDT`);

    await archiveRecoverySweepHandler({
      logger,
      listActive: () => [P1],
      listRecoverable: async () => symbols,
      enqueueBackfill,
    })({} as Job);

    expect(enqueueBackfill).toHaveBeenCalledTimes(5);
    expect(enqueueBackfill.mock.calls.map((c) => (c as unknown as [unknown, string])[1])).toEqual([
      'AUSDT',
      'BUSDT',
      'CUSDT',
      'DUSDT',
      'EUSDT',
    ]);
  });

  it('rotates the window so a stuck head cannot starve the tail', async () => {
    // Not every handler exit lands the marker that drops a symbol out of the
    // set (no Binance client, cold symbol-info cache), and the query returns a
    // stable alphabetical order — so a fixed head would re-enqueue the same
    // five forever and symbol six onward would never be repaired.
    const enqueueBackfill = vi.fn(async () => undefined);
    const symbols = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((s) => `${s}USDT`);
    const handler = archiveRecoverySweepHandler({
      logger,
      listActive: () => [P1],
      listRecoverable: async () => symbols,
      enqueueBackfill,
    });

    await handler({} as Job);
    await handler({} as Job);

    const enqueuedIn = (run: number): string[] =>
      enqueueBackfill.mock.calls
        .slice(run * 5, run * 5 + 5)
        .map((c) => (c as unknown as [unknown, string])[1]);
    expect(enqueuedIn(0)).toEqual(['AUSDT', 'BUSDT', 'CUSDT', 'DUSDT', 'EUSDT']);
    expect(enqueuedIn(1)).toEqual(['FUSDT', 'GUSDT', 'AUSDT', 'BUSDT', 'CUSDT']);
  });

  it("enqueues the pipeline job the archive screen's Recover button enqueues", async () => {
    // The wire shape is the contract: a payload the pipeline worker cannot parse
    // would be dropped, and the gap would persist with the cron looking healthy.
    listRecoverableSymbols.mockResolvedValueOnce(['TSTUSDT']);
    const add = vi.fn(async () => undefined);

    await buildArchiveRecoverySweepCron(ctx({ add })).handler({} as Job);

    expect(add).toHaveBeenCalledOnce();
    const [name, payload, opts] = add.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      { jobId: string },
    ];
    expect(name).toBe('backfill-trade-archive');
    expect(payload).toEqual({
      userId: OPERATOR_ID,
      accountId: ACCOUNT_ID,
      profileId: P1.profileId,
      symbol: 'TSTUSDT',
      // Unbounded window: the sweep does not know when the missing cycle closed.
      fromMs: null,
      toMs: null,
    });
    // NOT a static jobId — the pipeline queue retains terminal jobs, so a static
    // id would be occupied forever after the first run and every later repair
    // would be silently dropped.
    expect(opts.jobId).toMatch(/^backfill-archive:sweep:.+:TSTUSDT:\d+$/);
  });

  it('self-reschedules rather than running on a fixed pattern', () => {
    const def = buildArchiveRecoverySweepCron(ctx());

    expect(def.selfReschedulePeriodMs).toBe(900_000);
    expect(def.pattern).toBeUndefined();
    expect(def.queue).toBe('archive-recovery-sweep');
  });

  it('is REGISTERED — an unscheduled sweep repairs nothing', () => {
    expect(buildCrons(ctx()).map((c) => c.name)).toContain('archive-recovery-sweep');
  });
});
