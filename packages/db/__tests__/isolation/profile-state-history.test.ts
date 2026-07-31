import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import { profileStateHistory } from '../../src/schema/profile-state-history.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * Account-scoped happy-path matrix for
 * `packages/db/src/repo/profile-state-history.ts`. Both exported fns
 * (`listForProfile`, `archive`) take a `ProfileScope`, so a wrong-owner
 * call cannot be expressed — ownership is proven once by `scopeProfile`.
 * Cross-account rejection lives in `cross-account.test.ts`.
 *
 * Skipped when `DATABASE_TEST_URL` is not set so `bun run test` works on
 * workstations without a Postgres available.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('profile-state-history account-scoped reads and writes', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    // Seed one archived state.
    await ap.profileStateHistory.archive({
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      state: { tag: 'alice-snap-1' },
      archivedAt: new Date('2026-05-11T00:00:00Z'),
    });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('listForProfile returns only the owner-scoped rows on the happy path', async () => {
    const rows = await ap.profileStateHistory.listForProfile(10);
    expect(rows.map((r) => r.profileId)).toEqual([fx.alice.profileId]);
    // Defence-in-depth: the returned snapshot must be Alice's.
    expect(rows[0]?.state).toEqual({ tag: 'alice-snap-1' });
  });

  it('listForProfile honours the limit and DESC ordering on the happy path', async () => {
    // Seed a newer snapshot so the ordering gate is observable.
    await ap.profileStateHistory.archive({
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      state: { tag: 'alice-snap-2' },
      archivedAt: new Date('2026-05-11T00:01:00Z'),
    });
    const oneRow = await ap.profileStateHistory.listForProfile(1);
    expect(oneRow).toHaveLength(1);
    // Newer first.
    expect(oneRow[0]?.state).toEqual({ tag: 'alice-snap-2' });
  });

  it('archive lands the snapshot on the owner profile', async () => {
    await ap.profileStateHistory.archive({
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      state: { tag: 'alice-snap-3' },
      archivedAt: new Date('2026-05-11T00:02:00Z'),
    });
    const rows = await ap.profileStateHistory.listForProfile(100);
    expect(rows.find((r) => (r.state as { tag?: string }).tag === 'alice-snap-3')?.profileId).toBe(
      fx.alice.profileId,
    );
  });

  it('table-level invariant: every profile_state_history row resolves to its owning profile', async () => {
    // Belt-and-braces scan: every row must FK-resolve to a profile that
    // still exists. Catches a hypothetical migration regression that
    // orphans rows.
    // Scoped to this fixture's profiles (#487 flake class, see trade-archive.test.ts):
    // parallel isolation files share one DB, so an unscoped scan can capture a foreign
    // row whose profile is CASCADE-deleted by another file's teardown mid-test.
    const rows = await fx.db
      .select()
      .from(profileStateHistory)
      .where(inArray(profileStateHistory.profileId, [fx.alice.profileId, fx.bob.profileId]));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const owners = await fx.db.query.profiles.findMany({
        where: (p, { eq }) => eq(p.id, row.profileId),
      });
      expect(owners).toHaveLength(1);
    }
  });
});
