import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backtestAdvisorResults as advisorRepo,
  profileRepo,
  type ProfileRepo,
} from '../../src/repo/index.js';
import { backtestAdvisorResult } from '../../src/schema/backtest-advisor-result.js';
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

const SUGGESTIONS = [{ path: 'buy.gridLevels', value: 5 }];
const DROPPED = [{ path: 'nope', reason: 'unknown field' }];

describeIfDb('backtest_advisor_result account-scoped lifecycle', () => {
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

  const newRun = async (repo: ProfileRepo) =>
    repo.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });

  it('transitionToRunning claims a new slot and the row survives re-read (persistence)', async () => {
    const run = await newRun(alice);
    expect(
      await alice.backtestAdvisorResults.transitionToRunning({ runId: run.id, variant: 'safe' }),
    ).toBe(true);

    const listed = await alice.backtestAdvisorResults.listForRun(run.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.variant).toBe('safe');
    expect(listed[0]?.status).toBe('running');
    expect(listed[0]?.profileId).toBe(fx.alice.profileId);

    const one = await alice.backtestAdvisorResults.getVariant(run.id, 'safe');
    expect(one?.status).toBe('running');
  });

  it('single-flight: a second transition while running returns false; done → running regenerate returns true', async () => {
    const run = await newRun(alice);
    expect(
      await alice.backtestAdvisorResults.transitionToRunning({ runId: run.id, variant: 'safe' }),
    ).toBe(true);
    // Already running: the conditional upsert transitions nothing, so no job enqueues.
    expect(
      await alice.backtestAdvisorResults.transitionToRunning({ runId: run.id, variant: 'safe' }),
    ).toBe(false);

    await alice.backtestAdvisorResults.completeVariant({
      runId: run.id,
      variant: 'safe',
      status: 'done',
      summary: 'ok',
      suggestions: SUGGESTIONS,
      dropped: [],
      errorReason: null,
    });
    // From a terminal state, regenerate is allowed: the slot transitions back.
    expect(
      await alice.backtestAdvisorResults.transitionToRunning({ runId: run.id, variant: 'safe' }),
    ).toBe(true);
    const row = await alice.backtestAdvisorResults.getVariant(run.id, 'safe');
    expect(row?.status).toBe('running');
    // The transition clears a prior errorReason (none here) but leaves the slot claimed.
    expect(row?.errorReason).toBeNull();
  });

  it('completeVariant writes done and error terminal state with fields and a bumped updated_at', async () => {
    const run = await newRun(alice);
    await alice.backtestAdvisorResults.transitionToRunning({
      runId: run.id,
      variant: 'ride-trend',
    });
    const running = await alice.backtestAdvisorResults.getVariant(run.id, 'ride-trend');

    await alice.backtestAdvisorResults.completeVariant({
      runId: run.id,
      variant: 'ride-trend',
      status: 'done',
      summary: 'lean into the trend',
      suggestions: SUGGESTIONS,
      dropped: DROPPED,
      errorReason: null,
    });
    const done = await alice.backtestAdvisorResults.getVariant(run.id, 'ride-trend');
    expect(done?.status).toBe('done');
    expect(done?.summary).toBe('lean into the trend');
    expect(done?.suggestions).toEqual(SUGGESTIONS);
    expect(done?.dropped).toEqual(DROPPED);
    expect(done?.errorReason).toBeNull();
    expect(done?.updatedAt.getTime() ?? 0).toBeGreaterThanOrEqual(
      running?.updatedAt.getTime() ?? 0,
    );

    // Error terminal state records the reason.
    const run2 = await newRun(alice);
    await alice.backtestAdvisorResults.transitionToRunning({ runId: run2.id, variant: 'safe' });
    await alice.backtestAdvisorResults.completeVariant({
      runId: run2.id,
      variant: 'safe',
      status: 'error',
      summary: null,
      suggestions: [],
      dropped: [],
      errorReason: 'not-configured',
    });
    const errored = await alice.backtestAdvisorResults.getVariant(run2.id, 'safe');
    expect(errored?.status).toBe('error');
    expect(errored?.errorReason).toBe('not-configured');
    expect(errored?.summary).toBeNull();
  });

  it('upsertManual writes the manual slot done without touching a preexisting safe row', async () => {
    const run = await newRun(alice);
    await alice.backtestAdvisorResults.transitionToRunning({ runId: run.id, variant: 'safe' });
    await alice.backtestAdvisorResults.completeVariant({
      runId: run.id,
      variant: 'safe',
      status: 'done',
      summary: 'server safe',
      suggestions: SUGGESTIONS,
      dropped: [],
      errorReason: null,
    });

    await alice.backtestAdvisorResults.upsertManual({
      runId: run.id,
      summary: 'pasted from claude.ai',
      suggestions: DROPPED,
      dropped: [],
    });

    const manual = await alice.backtestAdvisorResults.getVariant(run.id, 'manual');
    expect(manual?.status).toBe('done');
    expect(manual?.summary).toBe('pasted from claude.ai');

    // The server-generated safe row is untouched by the manual upsert.
    const safe = await alice.backtestAdvisorResults.getVariant(run.id, 'safe');
    expect(safe?.summary).toBe('server safe');
    expect(await alice.backtestAdvisorResults.listForRun(run.id)).toHaveLength(2);
  });

  it('the unique (profile, run, variant) index keeps one row per variant', async () => {
    const run = await newRun(alice);
    // Two claims of the same variant never create a second row: the second is a
    // conditional upsert onto the same key, not an insert.
    await alice.backtestAdvisorResults.transitionToRunning({ runId: run.id, variant: 'safe' });
    await alice.backtestAdvisorResults.transitionToRunning({ runId: run.id, variant: 'safe' });
    await alice.backtestAdvisorResults.upsertManual({
      runId: run.id,
      summary: 'm',
      suggestions: [],
      dropped: [],
    });
    await alice.backtestAdvisorResults.upsertManual({
      runId: run.id,
      summary: 'm2',
      suggestions: [],
      dropped: [],
    });
    const rows = await alice.backtestAdvisorResults.listForRun(run.id);
    const variants = rows.map((r) => r.variant).sort();
    expect(variants).toEqual(['manual', 'safe']);
  });

  it('advisor rows cascade-delete with their backtest run', async () => {
    const localFx = await setupFixture();
    try {
      const a = await profileRepo(
        localFx.db,
        localFx.alice.userId,
        localFx.alice.accountId,
        localFx.alice.profileId,
      );
      // The run must be terminal to be deletable.
      const run = await a.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
      await a.backtestRuns.markRunning(run.id);
      await a.backtestRuns.complete(run.id, { metrics: {} });
      await a.backtestAdvisorResults.transitionToRunning({ runId: run.id, variant: 'safe' });
      expect(await a.backtestAdvisorResults.listForRun(run.id)).toHaveLength(1);

      expect(await a.backtestRuns.deleteById(run.id)).toBe(true);
      // The FK is ON DELETE CASCADE, so the advisor row is gone with its run.
      expect(await a.backtestAdvisorResults.listForRun(run.id)).toHaveLength(0);
    } finally {
      await localFx.cleanup();
    }
  });

  it('failStaleRunning marks only stale running rows error, leaving fresh/terminal ones untouched', async () => {
    const localFx = await setupFixture();
    try {
      const a = await profileRepo(
        localFx.db,
        localFx.alice.userId,
        localFx.alice.accountId,
        localFx.alice.profileId,
      );
      const staleRun = await a.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
      const freshRun = await a.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });
      const doneRun = await a.backtestRuns.create({ symbols: ['BTCUSDT'], params: PARAMS });

      await a.backtestAdvisorResults.transitionToRunning({ runId: staleRun.id, variant: 'safe' });
      await a.backtestAdvisorResults.transitionToRunning({ runId: freshRun.id, variant: 'safe' });
      await a.backtestAdvisorResults.transitionToRunning({ runId: doneRun.id, variant: 'safe' });
      await a.backtestAdvisorResults.completeVariant({
        runId: doneRun.id,
        variant: 'safe',
        status: 'done',
        summary: 'ok',
        suggestions: [],
        dropped: [],
        errorReason: null,
      });

      // Age only the stale row's updated_at past the cutoff.
      const cutoff = new Date('2020-01-01T00:00:00Z');
      await localFx.db
        .update(backtestAdvisorResult)
        .set({ updatedAt: new Date('2019-01-01T00:00:00Z') })
        .where(eqCol(staleRun.id));

      const recovered = await advisorRepo.failStaleRunning(localFx.db, cutoff);
      expect(recovered).toBe(1);

      expect((await a.backtestAdvisorResults.getVariant(staleRun.id, 'safe'))?.status).toBe(
        'error',
      );
      expect((await a.backtestAdvisorResults.getVariant(staleRun.id, 'safe'))?.errorReason).toBe(
        'failed',
      );
      // A running row updated after the cutoff is left running.
      expect((await a.backtestAdvisorResults.getVariant(freshRun.id, 'safe'))?.status).toBe(
        'running',
      );
      // A terminal (done) row is never touched.
      expect((await a.backtestAdvisorResults.getVariant(doneRun.id, 'safe'))?.status).toBe('done');
    } finally {
      await localFx.cleanup();
    }

    function eqCol(runId: string) {
      return and(eq(backtestAdvisorResult.runId, runId), eq(backtestAdvisorResult.variant, 'safe'));
    }
  });

  it("bob cannot see or mutate alice's advisor rows (account isolation)", async () => {
    const run = await newRun(alice);
    await alice.backtestAdvisorResults.transitionToRunning({ runId: run.id, variant: 'safe' });

    // bob's scope filters by his profile_id, so alice's rows are invisible.
    expect(await bob.backtestAdvisorResults.listForRun(run.id)).toHaveLength(0);
    expect(await bob.backtestAdvisorResults.getVariant(run.id, 'safe')).toBeNull();

    // bob completing under his scope matches nothing (scoped WHERE), so alice's
    // running row is unchanged.
    await bob.backtestAdvisorResults.completeVariant({
      runId: run.id,
      variant: 'safe',
      status: 'done',
      summary: 'hijack',
      suggestions: [],
      dropped: [],
      errorReason: null,
    });
    expect((await alice.backtestAdvisorResults.getVariant(run.id, 'safe'))?.status).toBe('running');
  });
});
