// archive-recovery-sweep cron: the periodic half of the Trade History repair.
// `listRecoverableSymbols` existed but only the archive SCREEN called it, so a
// cycle that closed without the forward archive firing stayed missing from
// history until the operator happened to open the page. These tests pin the
// fan-out, the per-profile isolation, the burst cap, and — through the real
// builder — the wire shape of the job it enqueues.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { pino, type Logger } from 'pino';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { profileRepo } from '@app/db';

import {
  archiveRecoverySweepHandler,
  buildArchiveRecoverySweepCron,
} from '../../src/crons/archive-recovery-sweep.cron.js';
import { buildCrons } from '../../src/crons/index.js';
import type { BootContext } from '../../src/boot/boot-context.js';
import type { MetricName, MetricsSink } from '../../src/metrics/catalog.js';
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
const P3 = profile('00000000-0000-0000-0000-0000000000a3');

/** A clock the test drives, so the pass budget is exercised by arithmetic rather than by waiting ten minutes. */
const stepClock = (): { clock: { nowMs(): number }; advance: (ms: number) => void } => {
  let nowMs = 0;
  return { clock: { nowMs: () => nowMs }, advance: (ms: number) => void (nowMs += ms) };
};

const logger = pino({ level: 'silent' });

const metricsStub = (): MetricsSink =>
  ({ record: vi.fn(), forget: vi.fn() }) as unknown as MetricsSink;

/** A logger whose emitted fields can be read back, since the tail line is the operator's diagnosis surface for a run and the docs describe it as such. */
const recordingLogger = (): { logger: Logger; lines: Record<string, unknown>[] } => {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'info' },
    { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  return { logger, lines };
};

// The catalogue's own type, so a name the prom-client sink would silently drop is a compile error here instead of a series that never appears.
const SWEEP_PROFILES: MetricName = 'archive_recovery_sweep_profiles_total';

// The builder runs each profile query inside a statement-timeout transaction, so the fixture handle has to model `transaction` and carry the `$client` marker the helper checks for a pool-backed handle. A bare object would send every profile down the failure path and the enqueue assertions would then be reading a green zero.
const fixtureDb = (): unknown => ({
  $client: {},
  transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ execute: async () => undefined }),
});

const ctx = (pipeline?: unknown): BootContext =>
  ({
    db: fixtureDb(),
    logger,
    listActive: () => [P1],
    redis: { raw: () => ({}) },
    queueSet: { queues: { pipeline } },
    // `buildCrons` constructs every cron and several read a retention/env knob
    // at build time; the registration assertion only cares about the NAMES.
    workerEnv: new Proxy({}, { get: () => 1 }),
  }) as unknown as BootContext;

/** Same boot context with caller-supplied fields, for asserting what the builder reads off it. */
const ctxWith = (overrides: Record<string, unknown>): BootContext =>
  ({ ...(ctx() as unknown as Record<string, unknown>), ...overrides }) as unknown as BootContext;

/** Flattens a drizzle SQL template to its literal text so an assertion can read the statement that was issued rather than compare object identity. Literal segments arrive as a `StringChunk` carrying the text on `.value`, while an interpolated value is pushed into the chunk list unchanged and so arrives as a bare primitive; both shapes are needed to see the whole statement. */
const sqlText = (query: unknown): string => {
  const chunks = (query as { queryChunks?: readonly unknown[] }).queryChunks ?? [];
  return chunks
    .map((c) =>
      c !== null && typeof c === 'object' && 'value' in c
        ? String((c as { value: unknown }).value)
        : String(c),
    )
    .join(' ');
};

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

  it('counts a swept and a failed profile separately so a partial pass cannot read as clean', async () => {
    // The tail log reports only what was enqueued, so a run that reached one of two profiles is indistinguishable from a run where the other profile had nothing to repair. Outcome counts are what make the difference visible.
    const metrics = metricsStub();
    const enqueueBackfill = vi.fn(async () => undefined);
    const { logger: recording, lines } = recordingLogger();
    const listRecoverable = vi.fn(async (p: ActiveProfile) => {
      if (p.profileId === P1.profileId) throw new Error('scoped query blew up');
      return ['ENAUSDT'];
    });

    await archiveRecoverySweepHandler({
      logger: recording,
      listActive: () => [P1, P2],
      listRecoverable,
      enqueueBackfill,
      metrics,
    })({} as Job);

    expect(metrics.record).toHaveBeenCalledWith(SWEEP_PROFILES, 1, { outcome: 'failed' });
    expect(metrics.record).toHaveBeenCalledWith(SWEEP_PROFILES, 1, { outcome: 'swept' });
    // One record per profile and no more: counting the same profile both swept and failed would satisfy the two assertions above while restoring the exact reading these counts exist to prevent, a partial pass that looks complete.
    expect(metrics.record).toHaveBeenCalledTimes(2);
    // The tail line has to carry the same story as the counters, or the surface the docs point an operator at disagrees with the alert.
    expect(lines.at(-1)).toMatchObject({ active: 2, swept: 1, failed: 1, timedOut: 0 });
    // The healthy profile is still repaired: the count is added evidence, not a replacement for the per-profile isolation.
    expect(enqueueBackfill).toHaveBeenCalledWith(P2, 'ENAUSDT');
  });

  it('classifies a cancelled query as a timeout and still sweeps the profile behind it', async () => {
    // A profile whose query never returns starves every profile after it in the serial loop. Counting the cancellation apart from a plain fault is what tells the operator the budget is being hit rather than the query erroring.
    const metrics = metricsStub();
    const enqueueBackfill = vi.fn(async () => undefined);
    const cancelled = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    const { logger: recording, lines } = recordingLogger();
    const listRecoverable = vi.fn(async (p: ActiveProfile) => {
      if (p.profileId === P1.profileId) throw cancelled;
      return ['ENAUSDT'];
    });

    await archiveRecoverySweepHandler({
      logger: recording,
      listActive: () => [P1, P2],
      listRecoverable,
      enqueueBackfill,
      metrics,
    })({} as Job);

    expect(metrics.record).toHaveBeenCalledWith(SWEEP_PROFILES, 1, { outcome: 'timeout' });
    expect(metrics.record).not.toHaveBeenCalledWith(SWEEP_PROFILES, 1, { outcome: 'failed' });
    expect(metrics.record).toHaveBeenCalledTimes(2);
    // `timedOut` is only ever observed non-zero here, so without this a hard-coded zero in the tail line would keep every other assertion green.
    expect(lines.at(-1)).toMatchObject({ active: 2, swept: 1, failed: 0, timedOut: 1 });
    expect(enqueueBackfill).toHaveBeenCalledWith(P2, 'ENAUSDT');
  });

  it('counts a profile with nothing to repair as swept and reports the whole run in one line', async () => {
    // A profile is counted for being REACHED, not for having work: counting only profiles that found something would make a clean fleet report zero swept and read exactly like a pass that never got past its first profile. The tail line is where an operator sees that, so its fields are the artifact, not an incidental log.
    const { logger: recording, lines } = recordingLogger();
    const metrics = metricsStub();

    await archiveRecoverySweepHandler({
      logger: recording,
      listActive: () => [P1, P2],
      listRecoverable: async () => [],
      enqueueBackfill: vi.fn(async () => undefined),
      metrics,
    })({} as Job);

    expect(metrics.record).toHaveBeenCalledTimes(2);
    expect(metrics.record).toHaveBeenNthCalledWith(1, SWEEP_PROFILES, 1, { outcome: 'swept' });
    expect(lines.at(-1)).toMatchObject({
      active: 2,
      swept: 2,
      failed: 0,
      timedOut: 0,
      enqueued: 0,
      deferred: 0,
    });
  });

  it('reports an all-zero run rather than returning silently when no profile is active', async () => {
    // A run that emits nothing reads exactly like a cron that has stopped running, which is the confusion the counts exist to remove, and the counter cannot fill the gap because a series that is never recorded does not exist to be read.
    const { logger: recording, lines } = recordingLogger();

    await archiveRecoverySweepHandler({
      logger: recording,
      listActive: () => [],
      listRecoverable: async () => [],
      enqueueBackfill: vi.fn(async () => undefined),
    })({} as Job);

    expect(lines.at(-1)).toMatchObject({
      active: 0,
      swept: 0,
      failed: 0,
      timedOut: 0,
      enqueued: 0,
      deferred: 0,
    });
  });

  it('runs each profile query under a statement timeout, not on the bare pool handle', async () => {
    // An unbounded await is the whole starvation mechanism: `pg` releases a connection only when the query settles, so the bound has to be applied to the same handle the scoped query runs on, not merely raced beside it.
    vi.mocked(profileRepo).mockClear();
    const statements: string[] = [];
    let tx: unknown;
    const db = {
      $client: {},
      transaction: vi.fn(async (fn: (handle: unknown) => Promise<unknown>) => {
        tx = {
          execute: vi.fn(async (query: unknown) => {
            statements.push(sqlText(query));
          }),
        };
        return fn(tx);
      }),
    };

    await buildArchiveRecoverySweepCron(ctxWith({ db })).handler({} as Job);

    // All three values are load-bearing, so the budget and the locality flag are pinned inside the statement rather than searched for anywhere in it: a bare substring check on the number passes for any budget that merely starts with those digits, and Postgres reads 0 as no limit, so a loosened or zeroed budget would keep a statement that still looks right. The trailing `true` is what keeps the setting transaction-local instead of leaking it onto the next borrower of the connection.
    const issued = statements.join(';');
    expect(issued).toContain('statement_timeout');
    expect(issued).toMatch(/set_config\('statement_timeout',\s*30000\s*,\s*true\)/);
    expect(profileRepo).toHaveBeenCalledWith(tx, P1.operatorId, P1.accountId, P1.profileId);
  });

  it('forwards the boot metrics sink, so the outcome counts survive the wiring', async () => {
    // The handler reads `deps.metrics` optionally, so dropping `metrics: ctx.metrics` from the builder leaves every assertion in this file green while the counter reads a flat zero forever, which is the failure this cron's own counts exist to end.
    const metrics = metricsStub();

    await buildArchiveRecoverySweepCron(ctxWith({ metrics })).handler({} as Job);

    expect(metrics.record).toHaveBeenCalledWith(SWEEP_PROFILES, 1, { outcome: 'swept' });
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

  it('stops at the pass budget and counts the profiles it never reached', async () => {
    // `statement_timeout` caps a STATEMENT, so on its own it lets a pass run for
    // `2 x budget x profiles` and nothing bounds the profile count. This is the
    // bound on the PASS, and it is only reachable because the statement cap hands
    // control back between profiles.
    const { clock, advance } = stepClock();
    const metrics = metricsStub();
    const { logger: recording, lines } = recordingLogger();
    const seen: string[] = [];
    const listRecoverable = vi.fn(async (p: ActiveProfile) => {
      seen.push(p.profileId);
      advance(400_000);
      return [] as string[];
    });

    await archiveRecoverySweepHandler({
      logger: recording,
      listActive: () => [P1, P2, P3],
      listRecoverable,
      enqueueBackfill: async () => undefined,
      metrics,
      clock,
    })({} as Job);

    // Two profiles started, the third never touched — not merely counted as failed.
    expect(seen).toEqual([P1.profileId, P2.profileId]);
    expect(metrics.record).toHaveBeenCalledWith(SWEEP_PROFILES, 1, { outcome: 'unswept' });
    const tail = lines.find((l) => String(l['msg']).endsWith('complete'));
    expect(tail).toMatchObject({ active: 3, swept: 2, failed: 0, timedOut: 0, unswept: 1 });
    // The remainder is stated as its own line too, because a `complete` info line
    // reading `unswept: 1` is not a thing anyone is watching for.
    expect(lines.find((l) => String(l['msg']).includes('pass budget exhausted'))).toMatchObject({
      reached: 2,
      unswept: 1,
    });
  });

  it('resumes at the first profile the previous pass did not reach', async () => {
    // Without this the bound above would create a worse fault than it fixes:
    // `listActive` order is stable, so a pass that stops at its budget stops in the
    // same place every run and the tail would never be swept at all.
    const { clock, advance } = stepClock();
    const seen: string[] = [];
    const handler = archiveRecoverySweepHandler({
      logger,
      listActive: () => [P1, P2, P3],
      listRecoverable: vi.fn(async (p: ActiveProfile) => {
        seen.push(p.profileId);
        advance(400_000);
        return [] as string[];
      }),
      enqueueBackfill: async () => undefined,
      clock,
    });

    await handler({} as Job);
    expect(seen).toEqual([P1.profileId, P2.profileId]);

    // Second pass: the cursor sits on P3, so P3 goes first and the rotation wraps.
    seen.length = 0;
    await handler({} as Job);
    expect(seen[0]).toBe(P3.profileId);
  });

  it('a pass inside its budget reaches every profile and reports nothing unswept', async () => {
    // The negative half. A bound that trips on a healthy run is worse than none,
    // and together with the 400_000-step case above this brackets the budget
    // between 500_000 and 800_000 without exporting the constant.
    const { clock, advance } = stepClock();
    const metrics = metricsStub();
    const { logger: recording, lines } = recordingLogger();
    const seen: string[] = [];

    await archiveRecoverySweepHandler({
      logger: recording,
      listActive: () => [P1, P2, P3],
      listRecoverable: vi.fn(async (p: ActiveProfile) => {
        seen.push(p.profileId);
        advance(250_000);
        return [] as string[];
      }),
      enqueueBackfill: async () => undefined,
      metrics,
      clock,
    })({} as Job);

    expect(seen).toEqual([P1.profileId, P2.profileId, P3.profileId]);
    expect(metrics.record).not.toHaveBeenCalledWith(SWEEP_PROFILES, expect.anything(), {
      outcome: 'unswept',
    });
    expect(lines.find((l) => String(l['msg']).includes('pass budget exhausted'))).toBeUndefined();
    expect(lines.find((l) => String(l['msg']).endsWith('complete'))).toMatchObject({
      active: 3,
      swept: 3,
      unswept: 0,
    });
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
