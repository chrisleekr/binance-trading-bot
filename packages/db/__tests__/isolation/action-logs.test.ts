import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import { actionLogs } from '../../src/schema/action-logs.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * Account-scoped happy-path matrix for `packages/db/src/repo/action-logs.ts`.
 * The four exported fns (`listRecent`, `listForSymbolRange`,
 * `listForProfileRange`, `append`) take a `ProfileScope`, so a wrong-owner
 * call is structurally impossible — ownership is proven once by
 * `scopeProfile`. Cross-account rejection lives in `cross-account.test.ts`;
 * this suite locks the owner-scoped read/write semantics on the
 * action_logs hypertable.
 *
 * Skipped when `DATABASE_TEST_URL` is not set so `bun run test` works on
 * workstations without a Postgres available.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

const T0 = new Date('2026-05-11T00:00:00Z');
const T1 = new Date('2026-05-11T00:01:00Z');
const T2 = new Date('2026-05-11T00:02:00Z');
const T3 = new Date('2026-05-11T00:03:00Z'); // After the [T0, T2] range — used to prove the upper bound discriminates.

const entry = (time: Date, tag: string, symbol: string | null = 'BTCUSDT') => ({
  time,
  symbol,
  level: 'info',
  msg: tag,
  ctx: { tag },
});

describeIfDb('action-logs account-scoped reads and writes', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;
  let bp: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    // Seed one row per account so same-owner happy paths have something to find.
    await ap.actionLogs.append(entry(T0, 'alice-log'));
    await bp.actionLogs.append(entry(T0, 'bob-log'));
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('listRecent returns only the owner-scoped rows', async () => {
    const rows = await ap.actionLogs.listRecent(10);
    expect(rows.map((r) => r.profileId)).toEqual([fx.alice.profileId]);
    expect(rows[0]?.msg).toBe('alice-log');
  });

  it('listForSymbolRange filters to the requested symbol + range', async () => {
    // Seed an off-symbol row inside the range, plus an on-symbol row *after*
    // the range, so both the symbol and the upper-bound time filter are
    // exercised — not just one of them.
    await ap.actionLogs.append(entry(T1, 'alice-eth', 'ETHUSDT'));
    await ap.actionLogs.append(entry(T3, 'alice-btc-late', 'BTCUSDT'));
    const rows = await ap.actionLogs.listForSymbolRange('BTCUSDT', T0, T2);
    expect(rows.map((r) => r.msg)).toEqual(['alice-log']);
  });

  it('listForProfileRange returns exactly the in-range owner-scoped rows', async () => {
    // After the symbol-range test ran, alice has three rows: T0 BTCUSDT,
    // T1 ETHUSDT, T3 BTCUSDT. Querying [T0, T2] must return the first
    // two and exclude the late T3 row — exact count locks the bound.
    const rows = await ap.actionLogs.listForProfileRange(T0, T2);
    expect(rows.every((r) => r.profileId === fx.alice.profileId)).toBe(true);
    expect(rows.map((r) => r.msg).sort()).toEqual(['alice-eth', 'alice-log']);
  });

  it('append lands the row on the owner profile', async () => {
    await ap.actionLogs.append(entry(T2, 'alice-appended'));
    const rows = await ap.actionLogs.listRecent(100);
    expect(rows.find((r) => r.msg === 'alice-appended')?.profileId).toBe(fx.alice.profileId);
  });

  it('listErrorsForProfile returns only the owner-scoped warn+error rows, newest first', async () => {
    // Seed one row per level for alice, plus a bob error row. The reader must
    // keep alice's warn+error rows newest-first and drop the info row and bob's
    // row entirely.
    await ap.actionLogs.append({ ...entry(T0, 'alice-info'), level: 'info' });
    await ap.actionLogs.append({ ...entry(T1, 'alice-warn'), level: 'warn' });
    await ap.actionLogs.append({ ...entry(T2, 'alice-error'), level: 'error' });
    await bp.actionLogs.append({ ...entry(T2, 'bob-error'), level: 'error' });

    const rows = await ap.actionLogs.listErrorsForProfile(10);
    expect(rows.every((r) => r.profileId === fx.alice.profileId)).toBe(true);
    expect(rows.every((r) => r.level === 'warn' || r.level === 'error')).toBe(true);
    // T2 error is newer than T1 warn → error first.
    expect(rows.map((r) => r.msg)).toEqual(['alice-error', 'alice-warn']);
  });

  it('table-level invariant: every action_logs row resolves to its owning profile', async () => {
    // action_logs has no FK to profiles (TimescaleDB hypertable + no PK on
    // the parent), so the logical invariant is enforced only by the
    // repo layer. This scan catches a hypothetical regression where some
    // path skips the scope and lands an orphan row.
    // Scoped to this fixture's profiles (#487 flake class, see trade-archive.test.ts):
    // parallel isolation files share one DB, so an unscoped scan can capture a foreign
    // row whose profile is CASCADE-deleted by another file's teardown mid-test.
    const rows = await fx.db
      .select()
      .from(actionLogs)
      .where(inArray(actionLogs.profileId, [fx.alice.profileId, fx.bob.profileId]));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const owners = await fx.db.query.profiles.findMany({
        where: (p, { eq }) => eq(p.id, row.profileId),
      });
      expect(owners).toHaveLength(1);
    }
  });
});
