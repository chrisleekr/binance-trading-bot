import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backtestRuns as backtestRunsRepo,
  profileRepo,
  type ProfileRepo,
} from '../../src/repo/index.js';
import { backtestRuns } from '../../src/schema/backtest-runs.js';
import { profiles } from '../../src/schema/profiles.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

const PARAMS = {
  symbols: ['BTCUSDT'],
  fromMs: 0,
  toMs: 1_000,
  strategyInterval: '1h',
  detailInterval: '5m',
  initialQuoteBalance: '1000',
  fees: { makerBps: 10, takerBps: 10 },
  slippageBps: 5,
};

describeIfDb('backtest_runs account-scoped lifecycle', () => {
  let fx: IsolationFixture;
  let alice: ProfileRepo;
  let bob: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    alice = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    bob = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('create inserts a queued run and get reads it back', async () => {
    const run = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    expect(run.status).toBe('queued');
    expect(run.progress).toBe(0);
    expect(run.symbols).toEqual(['BTCUSDT']);
    const got = await alice.backtestRuns.get(run.id);
    expect(got?.id).toBe(run.id);
  });

  it('drives the status lifecycle queued → running → done', async () => {
    const run = await alice.backtestRuns.create({ symbols: ['ETHUSDT'], params: PARAMS });
    expect(await alice.backtestRuns.markRunning(run.id)).toBe(true);
    await alice.backtestRuns.updateProgress(run.id, 42, {
      phase: 'replay',
      processed: 300,
      total: 1000,
    });
    let got = await alice.backtestRuns.get(run.id);
    expect(got?.status).toBe('running');
    expect(got?.progress).toBe(42);
    expect(got?.progressDetail).toEqual({ phase: 'replay', processed: 300, total: 1000 });
    expect(got?.startedAt).not.toBeNull();

    await alice.backtestRuns.complete(run.id, { metrics: { totalReturnPct: 12 } });
    got = await alice.backtestRuns.get(run.id);
    expect(got?.status).toBe('done');
    expect(got?.progress).toBe(100);
    expect(got?.finishedAt).not.toBeNull();
    expect(
      (got?.result as { metrics?: { totalReturnPct?: number } })?.metrics?.totalReturnPct,
    ).toBe(12);
  });

  it('complete stamps the effective config fingerprint', async () => {
    const run = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    await alice.backtestRuns.markRunning(run.id);
    await alice.backtestRuns.complete(run.id, { metrics: {} }, 'abc123def4567890');
    expect((await alice.backtestRuns.get(run.id))?.configFingerprint).toBe('abc123def4567890');
  });

  it('complete stamps the executed signature onto the run row', async () => {
    // The signature used to be stamped at CREATE from the POST-time config. The
    // worker reads config fresh at pickup and runs THAT, so a config edit in the
    // enqueue to pickup window would leave the row's signature describing a
    // different config than what ran, and a later re-run could dedup to it
    // (confident-wrong). complete() now writes the EXECUTED signature back onto
    // the row so the stored signature always names the config that actually ran.
    const EXECUTED_SIG = 'exec_sig_deadbeef';
    // Created without a signature: proves complete() is the writer, not create().
    const run = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    expect(run.backtestSignature).toBeNull();
    await alice.backtestRuns.markRunning(run.id);
    await alice.backtestRuns.complete(run.id, { metrics: {} }, 'fp-exec-sig', EXECUTED_SIG);
    expect((await alice.backtestRuns.get(run.id))?.backtestSignature).toBe(EXECUTED_SIG);
  });

  it('a retry after done cannot clobber the stamped signature', async () => {
    // complete() sets the signature under the status='running' guard, so a
    // duplicate delivery after the row is done matches zero rows and the first
    // executed signature survives.
    const run = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    await alice.backtestRuns.markRunning(run.id);
    await alice.backtestRuns.complete(run.id, { metrics: {} }, 'fp-a', 'sig-first');
    await alice.backtestRuns.complete(run.id, { metrics: {} }, 'fp-b', 'sig-second');
    expect((await alice.backtestRuns.get(run.id))?.backtestSignature).toBe('sig-first');
  });

  it('recentDone returns done standalone runs newest-first, excluding queued', async () => {
    const queued = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    const done = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    await alice.backtestRuns.markRunning(done.id);
    await alice.backtestRuns.complete(done.id, { metrics: {} }, 'fp-recent');

    const rows = await alice.backtestRuns.recentDone(25);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(done.id);
    expect(ids).not.toContain(queued.id);
    expect(rows.every((r) => r.status === 'done')).toBe(true);
    expect(rows[0]?.id).toBe(done.id); // createdAt desc → the just-completed run leads
    expect(rows.find((r) => r.id === done.id)?.configFingerprint).toBe('fp-recent');
  });

  it('create persists a passed parentRunId; get and list return it', async () => {
    const localFx = await setupFixture();
    try {
      const a = await profileRepo(
        localFx.db,
        localFx.alice.userId,
        localFx.alice.accountId,
        localFx.alice.profileId,
      );
      const parent = await a.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
      const child = await a.backtestRuns.create({
        symbols: ['BTCUSDT'],
        params: PARAMS,
        parentRunId: parent.id,
      });
      expect(child.parentRunId).toBe(parent.id);
      expect((await a.backtestRuns.get(child.id))?.parentRunId).toBe(parent.id);
      const listed = await a.backtestRuns.list({ limit: 100 });
      expect(listed.find((r) => r.id === child.id)?.parentRunId).toBe(parent.id);
    } finally {
      await localFx.cleanup();
    }
  });

  it('nulls a child parent_run_id when the parent run is deleted (ON DELETE SET NULL, not cascade)', async () => {
    const localFx = await setupFixture();
    try {
      const a = await profileRepo(
        localFx.db,
        localFx.alice.userId,
        localFx.alice.accountId,
        localFx.alice.profileId,
      );
      // The parent must be terminal to be deletable.
      const parent = await a.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
      await a.backtestRuns.markRunning(parent.id);
      await a.backtestRuns.complete(parent.id, { metrics: {} });
      const child = await a.backtestRuns.create({
        symbols: ['BTCUSDT'],
        params: PARAMS,
        parentRunId: parent.id,
      });

      expect(await a.backtestRuns.deleteById(parent.id)).toBe(true);

      // The child survives (SET NULL), it is not cascade-deleted with its parent,
      // and its dangling lineage pointer is nulled rather than left as a bad FK.
      const gotChild = await a.backtestRuns.get(child.id);
      expect(gotChild).not.toBeNull();
      expect(gotChild?.parentRunId).toBeNull();
    } finally {
      await localFx.cleanup();
    }
  });

  it('create leaves backtestSignature null until completion', async () => {
    // create() no longer stamps a signature. The worker computes the signature of
    // the config it actually ran and writes it at complete(), so the row's
    // signature can never describe a config that never ran.
    const run = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    expect(run.backtestSignature).toBeNull();
    expect((await alice.backtestRuns.get(run.id))?.backtestSignature).toBeNull();
  });

  it('findDoneBySignature returns the newest done standalone run with a result for the signature', async () => {
    // Re-run dedup keys off this: an identical backtest already completed should
    // surface its run instead of enqueuing a new one.
    const localFx = await setupFixture();
    try {
      const a = await profileRepo(
        localFx.db,
        localFx.alice.userId,
        localFx.alice.accountId,
        localFx.alice.profileId,
      );
      const sig = `sig-${randomUUID()}`;

      // A done standalone run whose signature is stamped at completion, the match.
      const done = await a.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
      await a.backtestRuns.markRunning(done.id);
      await a.backtestRuns.complete(done.id, { metrics: { totalReturnPct: 3 } }, null, sig);

      // A queued (non-done) run carrying the SAME signature must be ignored. A
      // queued run never reaches complete(), so seed the signature directly to
      // exercise the status='done' guard rather than a trivially-null row.
      await localFx.db.insert(backtestRuns).values({
        id: randomUUID(),
        profileId: localFx.alice.profileId,
        symbols: ['BTCUSDT'],
        params: PARAMS,
        status: 'queued',
        progress: 0,
        backtestSignature: sig,
      });

      // A SECOND profile under the SAME user, with a done standalone run carrying
      // the SAME signature, must not leak across the per-row profile_id filter.
      const otherProfileId = randomUUID();
      await localFx.db.insert(profiles).values({
        id: otherProfileId,
        accountId: localFx.alice.accountId as unknown as string,
        name: 'second',
        strategyName: 'trailing-trade',
        strategyVersion: '2.0.0',
        config: {},
        state: {},
      });
      const other = await profileRepo(
        localFx.db,
        localFx.alice.userId,
        localFx.alice.accountId,
        otherProfileId,
      );
      const otherDone = await other.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
      await other.backtestRuns.markRunning(otherDone.id);
      await other.backtestRuns.complete(
        otherDone.id,
        { metrics: { totalReturnPct: 9 } },
        null,
        sig,
      );

      const found = await a.backtestRuns.findDoneBySignature(sig);
      expect(found?.id).toBe(done.id);
      // The other profile's identical-signature run is invisible to this scope.
      expect(found?.id).not.toBe(otherDone.id);
      // No completed standalone run carries this signature.
      expect(await a.backtestRuns.findDoneBySignature('no-such-signature')).toBeNull();
    } finally {
      await localFx.cleanup();
    }
  });

  it('markRunning is a no-op on a done run (retry after complete cannot resurrect)', async () => {
    const run = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    await alice.backtestRuns.markRunning(run.id);
    await alice.backtestRuns.complete(run.id, { metrics: { totalReturnPct: 5 } });

    // A BullMQ retry firing after complete() must not flip the row back.
    expect(await alice.backtestRuns.markRunning(run.id)).toBe(false);
    const got = await alice.backtestRuns.get(run.id);
    expect(got?.status).toBe('done');
    expect(got?.progress).toBe(100);
  });

  it('markRunning re-drives an errored run (BullMQ retry budget stays alive)', async () => {
    const run = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    await alice.backtestRuns.markRunning(run.id);
    await alice.backtestRuns.fail(run.id, 'transient backfill error');

    // A transient failure is the path BullMQ retries: error must stay runnable.
    expect(await alice.backtestRuns.markRunning(run.id)).toBe(true);
    expect((await alice.backtestRuns.get(run.id))?.status).toBe('running');
  });

  it('markRunning is a no-op on a cancelled run (an abort cannot resurrect it)', async () => {
    const run = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    await alice.backtestRuns.markRunning(run.id);
    await alice.backtestRuns.markCancelled(run.id);

    // A still-queued job picked up after the operator aborts must not flip
    // cancelled→running.
    expect(await alice.backtestRuns.markRunning(run.id)).toBe(false);
    expect((await alice.backtestRuns.get(run.id))?.status).toBe('cancelled');
  });

  it('updateProgress is a no-op once the run is terminal', async () => {
    // The worker fires updateProgress un-awaited, so a stale write can race
    // past complete(); the status='running' guard must drop it rather than
    // clobber the terminal progress back down.
    const done = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    await alice.backtestRuns.markRunning(done.id);
    await alice.backtestRuns.complete(done.id, { metrics: {} });
    await alice.backtestRuns.updateProgress(done.id, 17);
    expect((await alice.backtestRuns.get(done.id))?.progress).toBe(100);

    const failed = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    await alice.backtestRuns.markRunning(failed.id);
    await alice.backtestRuns.updateProgress(failed.id, 30);
    await alice.backtestRuns.fail(failed.id, 'boom');
    await alice.backtestRuns.updateProgress(failed.id, 55);
    expect((await alice.backtestRuns.get(failed.id))?.progress).toBe(30);

    // A queued run has no in-flight progress either: the guard drops it.
    const queued = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    await alice.backtestRuns.updateProgress(queued.id, 5);
    expect((await alice.backtestRuns.get(queued.id))?.progress).toBe(0);
  });

  it('fail records the error and finish time', async () => {
    const run = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    await alice.backtestRuns.fail(run.id, 'boom');
    const got = await alice.backtestRuns.get(run.id);
    expect(got?.status).toBe('error');
    expect(got?.error).toBe('boom');
    expect(got?.finishedAt).not.toBeNull();
  });

  it('markCancelled transitions running→cancelled, then no-ops once terminal', async () => {
    const run = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    await alice.backtestRuns.markRunning(run.id);
    expect(await alice.backtestRuns.markCancelled(run.id)).toBe(true);
    expect((await alice.backtestRuns.get(run.id))?.status).toBe('cancelled');
    // Already terminal: a second cancel does not transition.
    expect(await alice.backtestRuns.markCancelled(run.id)).toBe(false);
  });

  it('complete does not resurrect a cancelled run', async () => {
    // The worker can finish the engine in the gap before its cancel poll fires;
    // complete must not overwrite cancelled→done or the timeout-cancel is
    // defeated. complete is scoped to status='running' (same guard as
    // updateProgress).
    const run = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    await alice.backtestRuns.markRunning(run.id);
    await alice.backtestRuns.markCancelled(run.id);
    await alice.backtestRuns.complete(run.id, { metrics: {} });
    expect((await alice.backtestRuns.get(run.id))?.status).toBe('cancelled');
  });

  it('deleteById removes a terminal run, then reports nothing on a second call', async () => {
    const done = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    await alice.backtestRuns.markRunning(done.id);
    await alice.backtestRuns.complete(done.id, { metrics: {} });
    expect(await alice.backtestRuns.deleteById(done.id)).toBe(true);
    expect(await alice.backtestRuns.get(done.id)).toBeNull();
    // The row is gone, so a repeat delete transitions nothing.
    expect(await alice.backtestRuns.deleteById(done.id)).toBe(false);
  });

  it('deleteById refuses an in-flight run so its worker job is never orphaned', async () => {
    const queued = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    expect(await alice.backtestRuns.deleteById(queued.id)).toBe(false);
    expect((await alice.backtestRuns.get(queued.id))?.status).toBe('queued');

    const running = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    await alice.backtestRuns.markRunning(running.id);
    expect(await alice.backtestRuns.deleteById(running.id)).toBe(false);
    expect((await alice.backtestRuns.get(running.id))?.status).toBe('running');
  });

  it("deleteById under bob's scope cannot delete alice's terminal run", async () => {
    const run = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    await alice.backtestRuns.markRunning(run.id);
    await alice.backtestRuns.markCancelled(run.id); // terminal, so deletable in-scope
    expect(await bob.backtestRuns.deleteById(run.id)).toBe(false);
    expect(await alice.backtestRuns.get(run.id)).not.toBeNull();
    // Same run deletes under its owning scope.
    expect(await alice.backtestRuns.deleteById(run.id)).toBe(true);
  });

  it('list returns the profile runs newest first', async () => {
    const runs = await alice.backtestRuns.list();
    expect(runs.length).toBeGreaterThanOrEqual(3);
    const times = runs.map((r) => r.createdAt.getTime());
    const sortedDesc = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sortedDesc);
  });

  it('count returns totals under the same filter as list', async () => {
    // Fresh fixture so the counts assert exact totals — a profitable done run, a
    // losing done run, and a queued run.
    const localFx = await setupFixture();
    try {
      const a = await profileRepo(
        localFx.db,
        localFx.alice.userId,
        localFx.alice.accountId,
        localFx.alice.profileId,
      );
      const win = await a.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
      await a.backtestRuns.markRunning(win.id);
      await a.backtestRuns.complete(win.id, { metrics: { totalReturnPct: 5 } });
      const loss = await a.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
      await a.backtestRuns.markRunning(loss.id);
      await a.backtestRuns.complete(loss.id, { metrics: { totalReturnPct: -3 } });
      await a.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS }); // queued

      // No filter: every row for the profile.
      expect(await a.backtestRuns.count()).toBe(3);
      // Outcome filter reads the done run's total-return sign, same as list().
      expect(await a.backtestRuns.count({ filter: 'profit' })).toBe(1);
      expect(await a.backtestRuns.count({ filter: 'loss' })).toBe(1);
      expect(await a.backtestRuns.count({ filter: 'error' })).toBe(0);
    } finally {
      await localFx.cleanup();
    }
  });

  it('list paginates by cursor with no overlap', async () => {
    // Fresh fixture so only the 3 rows created here exist: the cursor carries a
    // ms-precision `createdAt`, so a sub-ms collision with another test's row
    // could otherwise mask a page boundary. Isolating keeps the assertion exact.
    const local = await setupFixture();
    try {
      const localAlice = await profileRepo(
        local.db,
        local.alice.userId,
        local.alice.accountId,
        local.alice.profileId,
      );
      const created = [
        await localAlice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS }),
        await localAlice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS }),
        await localAlice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS }),
      ];
      const createdIds = new Set(created.map((r) => r.id));

      const page1 = await localAlice.backtestRuns.list({ limit: 2 });
      expect(page1.length).toBe(2);

      const cursor = { createdAt: page1[1].cursorToken, id: page1[1].id };
      const page2 = await localAlice.backtestRuns.list({ limit: 2, cursor });
      expect(page2.length).toBe(1);

      const page1Ids = new Set(page1.map((r) => r.id));
      expect(page2.every((r) => !page1Ids.has(r.id))).toBe(true);

      const union = new Set([...page1Ids, ...page2.map((r) => r.id)]);
      expect(union).toEqual(createdIds);
    } finally {
      await local.cleanup();
    }
  });

  it('list paginates across a same-millisecond microsecond boundary with no skip', async () => {
    // backtest_runs.created_at is microsecond precision. The cursor carries the
    // full µs resolution via `cursorToken`, so two rows sharing a millisecond
    // but differing in the sub-ms digits do NOT collapse to one cursor value —
    // the smaller-µs row is still reached on the next page. A millisecond-only
    // cursor would skip it. A fresh fixture isolates these four rows.
    const local = await setupFixture();
    try {
      const localAlice = await profileRepo(
        local.db,
        local.alice.userId,
        local.alice.accountId,
        local.alice.profileId,
      );
      const r1 = randomUUID();
      const r2 = randomUUID();
      const r3 = randomUUID();
      const r4 = randomUUID();
      const allIds = new Set([r1, r2, r3, r4]);

      const row = (id: string, createdAt: ReturnType<typeof sql>) => ({
        id,
        profileId: local.alice.profileId,
        symbols: ['BTCUSDT'],
        params: PARAMS,
        status: 'queued',
        progress: 0,
        createdAt,
      });

      await local.db.insert(backtestRuns).values([
        row(r1, sql`'2026-06-19T00:00:00.100900Z'::timestamptz`), // newest
        row(r2, sql`'2026-06-19T00:00:00.100100Z'::timestamptz`),
        row(r3, sql`'2026-06-19T00:00:00.100050Z'::timestamptz`), // same ms .100, smaller µs
        row(r4, sql`'2026-06-19T00:00:00.099000Z'::timestamptz`), // earlier ms
      ]);

      const page1 = await localAlice.backtestRuns.list({ limit: 2 });
      expect(page1.length).toBe(2);

      // The µs-precision `cursorToken` carries full microsecond resolution, so
      // a same-millisecond boundary no longer collapses to one cursor value.
      const cursor = { createdAt: page1[1].cursorToken, id: page1[1].id };
      const page2 = await localAlice.backtestRuns.list({ limit: 2, cursor });

      const seen = new Set([...page1.map((r) => r.id), ...page2.map((r) => r.id)]);
      // R3 (.100050) shares the millisecond of the boundary row but has a
      // smaller microsecond fraction; the µs cursor still reaches it.
      expect(seen.size).toBe(4);
      expect(seen).toEqual(allIds);
    } finally {
      await local.cleanup();
    }
  });

  it('list still paginates correctly given a legacy millisecond-only cursor', async () => {
    // Cursors emitted before the µs fix carry only millisecond resolution.
    // Such a cursor must still cast to timestamptz and page without error or
    // row loss: `.100Z` reads as `.100000`, so same-ms rows with a larger µs
    // fraction surface in full on the next page (none are dropped).
    const local = await setupFixture();
    try {
      const localAlice = await profileRepo(
        local.db,
        local.alice.userId,
        local.alice.accountId,
        local.alice.profileId,
      );
      const r1 = randomUUID();
      const r2 = randomUUID();
      const allIds = new Set([r1, r2]);
      const row = (id: string, createdAt: ReturnType<typeof sql>) => ({
        id,
        profileId: local.alice.profileId,
        symbols: ['BTCUSDT'],
        params: PARAMS,
        status: 'queued',
        progress: 0,
        createdAt,
      });
      await local.db
        .insert(backtestRuns)
        .values([
          row(r1, sql`'2026-06-19T00:00:00.100900Z'::timestamptz`),
          row(r2, sql`'2026-06-19T00:00:00.050000Z'::timestamptz`),
        ]);

      // A pre-fix ms cursor that predates r1 by one millisecond.
      const legacyCursor = { createdAt: '2026-06-19T00:00:00.101Z', id: r1 };
      const rows = await localAlice.backtestRuns.list({ limit: 10, cursor: legacyCursor });
      const seen = new Set(rows.map((r) => r.id));
      expect(seen).toEqual(allIds);
    } finally {
      await local.cleanup();
    }
  });

  it('listNonTerminalOlderThan returns only queued/running rows older than the cutoff', async () => {
    // GLOBAL recovery read feeding the sweep cron: spans every profile, so it is
    // db-first. Seed rows at a fixed past instant and one in the future, then a
    // mid-point cutoff selects exactly the non-terminal, old-enough ones.
    const mk = (status: string, createdAt: ReturnType<typeof sql>) => {
      const id = randomUUID();
      return {
        id,
        value: {
          id,
          profileId: fx.alice.profileId,
          symbols: ['BTCUSDT'],
          params: PARAMS,
          status,
          progress: 0,
          createdAt,
        },
      };
    };
    const past = sql`'2000-01-01T00:00:00Z'::timestamptz`;
    const future = sql`'2099-01-01T00:00:00Z'::timestamptz`;
    const oldQueued = mk('queued', past);
    const oldRunning = mk('running', past);
    const oldDone = mk('done', past);
    const oldError = mk('error', past);
    const oldCancelled = mk('cancelled', past);
    const freshQueued = mk('queued', future);
    await fx.db
      .insert(backtestRuns)
      .values(
        [oldQueued, oldRunning, oldDone, oldError, oldCancelled, freshQueued].map((r) => r.value),
      );

    const rows = await backtestRunsRepo.listNonTerminalOlderThan(
      fx.db,
      new Date('2010-01-01T00:00:00Z'),
    );
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.has(oldQueued.id)).toBe(true);
    expect(ids.has(oldRunning.id)).toBe(true);
    expect(ids.has(oldDone.id)).toBe(false);
    expect(ids.has(oldError.id)).toBe(false);
    expect(ids.has(oldCancelled.id)).toBe(false);
    // Too fresh (after the cutoff): the age floor keeps a just-created run safe.
    expect(ids.has(freshQueued.id)).toBe(false);
    // Each row carries its owning profile for the cron's reclaim log line.
    expect(rows.find((r) => r.id === oldQueued.id)?.profileId).toBe(fx.alice.profileId);
  });

  it("a run created under alice is invisible to bob's scope", async () => {
    const run = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
    expect(await bob.backtestRuns.get(run.id)).toBeNull();
    expect(bob.backtestRuns.list).toBeDefined();
    const bobRuns = await bob.backtestRuns.list();
    expect(bobRuns.some((r) => r.id === run.id)).toBe(false);
    // bob mutating alice's run is a no-op (scoped WHERE matches nothing)
    await bob.backtestRuns.complete(run.id, { x: 1 });
    expect((await alice.backtestRuns.get(run.id))?.status).toBe('queued');
  });
});
