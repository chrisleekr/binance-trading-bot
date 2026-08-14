// `diagnosis_runs` against a real database. Skipped without `DATABASE_TEST_URL`
// so workstations with no Postgres still see `bun run test` go green.
//
// A real database because the two properties worth proving are both database
// behaviour: a run belonging to another account's profile must not resolve
// through this profile's scope, and the keep-newest-N prune must be per profile
// rather than table-wide.

import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, beforeAll, describe, expect, it } from 'vitest';
import type { DiagnosisStep, ProfileDiagnosis } from '@app/contracts';
import { diagnosisRuns, scopeProfile, type ProfileScope } from '../../src/repo/index.js';
import { diagnosisRuns as diagnosisRunsTable } from '../../src/schema/diagnosis-runs.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

const T0 = new Date('2026-08-01T00:00:00.000Z');

const runId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const pending: readonly DiagnosisStep[] = [
  { id: 'worker-alive', label: 'Is the trading engine running?', status: 'pending', line: '' },
  { id: 'profile-active', label: 'Is this profile switched on?', status: 'pending', line: '' },
];

const report: ProfileDiagnosis = {
  asOfMs: T0.getTime(),
  verdict: 'trading',
  headline: 'Nothing is blocking this profile.',
  steps: [
    { id: 'worker-alive', label: 'Is the trading engine running?', status: 'ok', line: 'Alive.' },
  ],
  items: [],
  funnel: null,
  timeline: [],
};

describeIfDb('diagnosis-runs repo', () => {
  let fx: IsolationFixture;
  let scope: ProfileScope;
  let bobScope: ProfileScope;

  beforeAll(async () => {
    fx = await setupFixture();
    scope = await scopeProfile(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    bobScope = await scopeProfile(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  beforeEach(async () => {
    // The whole table, not just this fixture's profiles: `failStaleNonTerminal`
    // sweeps globally, so a row left by anything else would inflate the count it
    // returns and make the assertion below depend on suite order.
    await fx.db.delete(diagnosisRunsTable);
  });

  const rowsFor = async (profileId: string) =>
    fx.db.select().from(diagnosisRunsTable).where(eq(diagnosisRunsTable.profileId, profileId));

  it('seeds a queued run with its ladder already visible', async () => {
    // Queued rather than running, and seeded with the full step list, so the
    // first poll shows the whole ladder instead of an empty surface that fills
    // in later. The UI must never have to guess how many steps there are.
    const row = await diagnosisRuns.create(scope, { id: runId(1), steps: pending, now: T0 });

    expect(row.status).toBe('queued');
    expect(row.steps).toHaveLength(2);
    expect(row.report).toBeNull();
    expect(row.finishedAt).toBeNull();
  });

  it('patchSteps publishes progress and flips the run to running', async () => {
    await diagnosisRuns.create(scope, { id: runId(1), steps: pending, now: T0 });
    await diagnosisRuns.patchSteps(scope, runId(1), [
      { id: 'worker-alive', label: 'Is the trading engine running?', status: 'ok', line: 'Alive.' },
      { id: 'profile-active', label: 'Is this profile switched on?', status: 'running', line: '' },
    ]);

    const found = await diagnosisRuns.findById(scope, runId(1));
    expect(found?.status).toBe('running');
    expect(found?.steps[0]?.status).toBe('ok');
    expect(found?.steps[1]?.status).toBe('running');
  });

  it('finish stores the report and its steps together', async () => {
    await diagnosisRuns.create(scope, { id: runId(1), steps: pending, now: T0 });
    await diagnosisRuns.finish(scope, runId(1), report, T0);

    const found = await diagnosisRuns.findById(scope, runId(1));
    expect(found?.status).toBe('done');
    expect(found?.report?.verdict).toBe('trading');
    // The terminal steps come from the report, so a finished run can never show
    // progress that disagrees with the answer it produced.
    expect(found?.steps).toEqual(report.steps);
    expect(found?.finishedAt).not.toBeNull();
  });

  it('fail records an operator-facing reason and terminates the run', async () => {
    await diagnosisRuns.create(scope, { id: runId(1), steps: pending, now: T0 });
    await diagnosisRuns.fail(scope, runId(1), 'Binance did not answer.', T0);

    const found = await diagnosisRuns.findById(scope, runId(1));
    expect(found?.status).toBe('error');
    expect(found?.error).toBe('Binance did not answer.');
    expect(found?.report).toBeNull();
  });

  it('another profile run does not resolve through this scope', async () => {
    await diagnosisRuns.create(bobScope, { id: runId(9), steps: pending, now: T0 });

    // The route proves ownership with the scope alone. If this ever returns the
    // row, a report belonging to another account leaks through a guessed id.
    expect(await diagnosisRuns.findById(scope, runId(9))).toBeUndefined();
    expect(await diagnosisRuns.listForProfile(scope, 10)).toHaveLength(0);
  });

  it('a write aimed at another profile run changes nothing', async () => {
    await diagnosisRuns.create(bobScope, { id: runId(9), steps: pending, now: T0 });
    await diagnosisRuns.fail(scope, runId(9), 'not mine', T0);

    const theirs = await diagnosisRuns.findById(bobScope, runId(9));
    expect(theirs?.status).toBe('queued');
    expect(theirs?.error).toBeNull();
  });

  it('listForProfile returns newest first', async () => {
    for (const [n, offset] of [
      [1, 0],
      [2, 60_000],
      [3, 120_000],
    ] as const) {
      await diagnosisRuns.create(scope, {
        id: runId(n),
        steps: pending,
        now: new Date(T0.getTime() + offset),
      });
    }

    const list = await diagnosisRuns.listForProfile(scope, 2);
    expect(list.map((r) => r.id)).toEqual([runId(3), runId(2)]);
  });

  it('failStaleNonTerminal reclaims abandoned runs across profiles and spares live ones', async () => {
    // The queue runs with `attempts: 1`, so a row left non-terminal by a dead
    // job is left there forever, and the drawer hides "Check again" while a run
    // is live. Both `queued` and `running` strand: the first when the job never
    // starts, the second when it dies mid-ladder.
    const stale = new Date(T0.getTime() - 60 * 60_000);
    await diagnosisRuns.create(scope, { id: runId(1), steps: pending, now: stale });
    await diagnosisRuns.create(scope, { id: runId(2), steps: pending, now: stale });
    await diagnosisRuns.patchSteps(scope, runId(2), pending); // -> running
    await diagnosisRuns.create(bobScope, { id: runId(9), steps: pending, now: stale });
    // Newer than the cutoff: an investigation still in flight.
    await diagnosisRuns.create(scope, { id: runId(3), steps: pending, now: T0 });
    // Already terminal: a finished run must never be rewritten as an error.
    await diagnosisRuns.create(scope, { id: runId(4), steps: pending, now: stale });
    await diagnosisRuns.finish(scope, runId(4), report, stale);

    // Cross-profile by design, so one sweep reclaims the whole deployment.
    expect(await diagnosisRuns.failStaleNonTerminal(fx.db, T0)).toBe(3);

    const byId = new Map((await rowsFor(fx.alice.profileId)).map((r) => [r.id, r]));
    expect(byId.get(runId(1))?.status).toBe('error');
    expect(byId.get(runId(1))?.finishedAt).not.toBeNull();
    expect(byId.get(runId(2))?.status).toBe('error');
    expect(byId.get(runId(3))?.status).toBe('queued');
    expect(byId.get(runId(4))?.status).toBe('done');
    expect((await rowsFor(fx.bob.profileId))[0]?.status).toBe('error');
  });

  it('pruneKeepNewest keeps N per profile and spares other profiles entirely', async () => {
    for (const n of [1, 2, 3, 4]) {
      await diagnosisRuns.create(scope, {
        id: runId(n),
        steps: pending,
        now: new Date(T0.getTime() + n * 60_000),
      });
    }
    await diagnosisRuns.create(bobScope, { id: runId(9), steps: pending, now: T0 });

    expect(await diagnosisRuns.pruneKeepNewest(scope, 2)).toBe(2);

    const mine = await rowsFor(fx.alice.profileId);
    expect(mine.map((r) => r.id).sort()).toEqual([runId(3), runId(4)]);
    // A table-wide cap would let a heavily-investigated profile evict a quiet
    // one's history. The prune is keyed on the scope for exactly that reason.
    expect(await rowsFor(fx.bob.profileId)).toHaveLength(1);
  });
});
