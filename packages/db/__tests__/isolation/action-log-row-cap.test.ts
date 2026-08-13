// Per-profile row cap on `action_logs`, against a real database.
//
// Three things need a real database rather than a stub. The cap is enforced by
// a row comparison on `(time, id)` against a hypertable index, and the drainer
// bulk-inserts whole batches sharing one microsecond timestamp, so a cap that
// compares `time` alone either deletes the whole tie group or none of it. The
// cap is per profile, so cross-profile isolation is a property of the WHERE
// clause, not of the caller. And the one-owner rule from migration 0076 is a
// fact about the live database: it only holds if no TimescaleDB retention policy
// has crept back onto the table.
//
// Not covered here: the age sweep is global and would delete rows other suites
// seeded on this shared database. That the two rules fire and report
// independently is pinned where the two are sequenced, in
// `apps/worker/__tests__/crons/prune-handlers.test.ts`.

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actionLogs, profiles } from '../../src/repo/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('action-logs per-profile row cap', () => {
  let fx: IsolationFixture;

  const BASE = new Date('2026-03-01T00:00:00.000Z');

  /** `count` rows for one profile, one second apart, newest last. */
  const seedSpread = async (profileId: string, count: number, tag: string): Promise<void> => {
    await actionLogs.insertMany(
      fx.db,
      Array.from({ length: count }, (_, i) => ({
        time: new Date(BASE.getTime() + i * 1_000),
        profileId,
        symbol: 'BTCUSDT',
        level: 'info',
        msg: `${tag} ${i}`,
        ctx: { source: 'tick', i },
      })),
    );
  };

  const messages = async (profileId: string): Promise<string[]> => {
    const rows = await fx.db.execute<{ msg: string }>(
      sql`select msg from action_logs where profile_id = ${profileId}
          order by time desc, id desc`,
    );
    return rows.rows.map((r) => r.msg);
  };

  beforeAll(async () => {
    fx = await setupFixture();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('keeps the newest rows and deletes the rest', async () => {
    await seedSpread(fx.alice.profileId, 20, 'alice');

    expect(await actionLogs.pruneBeyondRowCap(fx.db, fx.alice.profileId, 5)).toBe(15);
    expect(await messages(fx.alice.profileId)).toEqual([
      'alice 19',
      'alice 18',
      'alice 17',
      'alice 16',
      'alice 15',
    ]);
  });

  it('does not touch a quiet profile when a noisy one is trimmed', async () => {
    // A table-wide cap would let the busy profile evict this one entirely, which
    // is the failure the per-profile bound exists to prevent.
    await seedSpread(fx.bob.profileId, 4, 'bob');
    await seedSpread(fx.alice.profileId, 40, 'alice-again');

    await actionLogs.pruneBeyondRowCap(fx.db, fx.alice.profileId, 2);
    expect(await messages(fx.bob.profileId)).toHaveLength(4);
  });

  it('deletes nothing when a profile is under its cap', async () => {
    expect(await actionLogs.pruneBeyondRowCap(fx.db, fx.bob.profileId, 1_000)).toBe(0);
    expect(await messages(fx.bob.profileId)).toHaveLength(4);
  });

  it('cuts inside a batch that shares one timestamp, keeping exactly the cap', async () => {
    // The drainer stamps a whole batch within one microsecond. Comparing `time`
    // alone leaves the boundary ambiguous, so the sweep either spares the entire
    // tie group (the cap never binds) or deletes it (a profile loses everything
    // it logged that instant). The `(time, id)` comparison is what makes the cut
    // land at exactly the cap.
    const at = new Date(BASE.getTime() + 500_000);
    await fx.db.execute(sql`delete from action_logs where profile_id = ${fx.bob.profileId}`);
    await actionLogs.insertMany(
      fx.db,
      Array.from({ length: 10 }, (_, i) => ({
        time: at,
        profileId: fx.bob.profileId,
        symbol: 'BTCUSDT',
        level: 'info',
        msg: `tie ${i}`,
        ctx: { source: 'tick', i },
      })),
    );

    expect(await actionLogs.pruneBeyondRowCap(fx.db, fx.bob.profileId, 4)).toBe(6);
    expect(await messages(fx.bob.profileId)).toHaveLength(4);
  });

  it('lists disabled profiles too, since their old rows still count against growth', async () => {
    // `listAllEnabled` is the wrong source for the cap: switching a profile off
    // stops new rows, it does not remove the ones already written.
    await fx.db.execute(sql`update profiles set enabled = false where id = ${fx.bob.profileId}`);
    expect(await profiles.listAllIds(fx.db)).toContain(fx.bob.profileId);
  });

  it('leaves `action_logs` with exactly one retention owner', async () => {
    // Migration 0076 dropped the TimescaleDB policy because two deleters on one
    // horizon swept the table days earlier than the dashboard reported. Adding a
    // second rule to the cron is safe; adding a second owner is not.
    const jobs = await fx.db.execute<{ count: string }>(
      sql`select count(*)::text as count from timescaledb_information.jobs
          where proc_name = 'policy_retention' and hypertable_name = 'action_logs'`,
    );
    expect(jobs.rows[0]?.count).toBe('0');
  });
});
