// Round-trip suite for the global `retention_config` singleton, against a real
// database. Skipped when `TEST_DB_URL` is unset so workstations without Postgres
// still see `bun run test` go green; CI runs against a live database.
//
// Two things are worth a real database here rather than a mock. The bounds are
// CHECK constraints, so the database is the last line between a UI or API bug
// and a horizon of zero days that deletes everything on the next sweep — and a
// constraint is only proven by a rejected write. And `update` is a partial
// patch, so the field it must NOT touch is as much a part of the contract as
// the one it sets: arming deep capture cannot be allowed to reset a retention
// horizon back to its default.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { retentionConfig } from '../../src/repo/index.js';
import { retentionConfig as retentionConfigTable } from '../../src/schema/retention-config.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

/**
 * Name of the CHECK a write violated, or a marker for anything else. Drizzle
 * wraps the driver error in a generic `Failed query: …`, so the constraint name
 * only survives on the cause — matching the message would silently accept a
 * dropped connection as proof that a bound exists.
 */
const violatedConstraint = async (write: Promise<unknown>): Promise<string> => {
  try {
    await write;
    return '<no error>';
  } catch (err) {
    const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
    // 23514 = check_violation, 23505 = unique_violation (PostgreSQL Appendix A).
    return cause?.constraint ?? `<${cause?.code ?? 'unknown'}>`;
  }
};

describeIfDb('retention-config repo', () => {
  let fx: IsolationFixture;

  beforeAll(async () => {
    fx = await setupFixture();
    // Reset the shared singleton to the migration's seeded defaults, so this
    // suite is independent of any prior mutation on the shared test DB.
    await retentionConfig.update(fx.db, {
      actionLogDays: 1,
      actionLogMaxRows: 200_000,
      auditLogDays: 90,
      auditStreamMaxlen: 100_000,
      debugCaptureProfileId: null,
      debugCaptureUntil: null,
    });
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('get returns the seeded singleton', async () => {
    const row = await retentionConfig.get(fx.db);
    expect(row.id).toBe(1);
    expect(row.actionLogDays).toBe(1);
    expect(row.actionLogMaxRows).toBe(200_000);
    expect(row.auditLogDays).toBe(90);
    expect(row.auditStreamMaxlen).toBe(100_000);
    expect(row.debugCaptureProfileId).toBeNull();
  });

  it('update patches only the fields it is given', async () => {
    const updated = await retentionConfig.update(fx.db, { actionLogDays: 30 });
    expect(updated.actionLogDays).toBe(30);
    // The knobs the caller did not mention must survive verbatim. A `set` that
    // spread undefined values would blank these instead.
    expect(updated.auditLogDays).toBe(90);
    expect(updated.actionLogMaxRows).toBe(200_000);
    expect(updated.auditStreamMaxlen).toBe(100_000);

    expect((await retentionConfig.get(fx.db)).actionLogDays).toBe(30);
  });

  it('arming deep capture leaves the retention horizons untouched', async () => {
    const until = new Date(Date.now() + 3_600_000);
    const armed = await retentionConfig.update(fx.db, {
      debugCaptureProfileId: fx.alice.profileId,
      debugCaptureUntil: until,
    });
    expect(armed.debugCaptureProfileId).toBe(fx.alice.profileId);
    expect(armed.debugCaptureUntil?.getTime()).toBe(until.getTime());
    expect(armed.actionLogDays).toBe(30);
  });

  it('disarming clears both capture columns without clearing anything else', async () => {
    const off = await retentionConfig.update(fx.db, {
      debugCaptureProfileId: null,
      debugCaptureUntil: null,
    });
    expect(off.debugCaptureProfileId).toBeNull();
    expect(off.debugCaptureUntil).toBeNull();
    expect(off.actionLogDays).toBe(30);
  });

  it('stamps updated_at on every patch', async () => {
    const before = await retentionConfig.get(fx.db);
    await retentionConfig.update(fx.db, { auditLogDays: 45 });
    const after = await retentionConfig.get(fx.db);
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
  });

  it.each([
    ['a zero-day action horizon', { actionLogDays: 0 }, 'retention_config_action_log_days_check'],
    [
      'an action horizon past a year',
      { actionLogDays: 366 },
      'retention_config_action_log_days_check',
    ],
    ['a zero-day audit horizon', { auditLogDays: 0 }, 'retention_config_audit_log_days_check'],
    [
      'a row cap below the floor',
      { actionLogMaxRows: 999 },
      'retention_config_action_log_max_rows_check',
    ],
    [
      'a row cap above the ceiling',
      { actionLogMaxRows: 10_000_001 },
      'retention_config_action_log_max_rows_check',
    ],
    [
      'a stream trim below the floor',
      { auditStreamMaxlen: 999 },
      'retention_config_audit_stream_maxlen_check',
    ],
    [
      'a stream trim above the ceiling',
      { auditStreamMaxlen: 5_000_001 },
      'retention_config_audit_stream_maxlen_check',
    ],
  ])('the database rejects %s', async (_name, patch, constraint) => {
    // Naming the constraint is what makes this proof rather than ceremony: a
    // bare `rejects.toThrow()` passes just as happily on a dropped connection,
    // i.e. against a database with no bound on this column at all.
    expect(await violatedConstraint(retentionConfig.update(fx.db, patch))).toBe(constraint);
  });

  it('an out-of-range write leaves the stored value intact', async () => {
    // The CHECK aborts the statement, so the row must be unchanged rather than
    // half-applied — otherwise a rejected UI save could still shorten retention.
    const before = await retentionConfig.get(fx.db);
    expect(await violatedConstraint(retentionConfig.update(fx.db, { actionLogDays: 0 }))).toBe(
      'retention_config_action_log_days_check',
    );
    expect((await retentionConfig.get(fx.db)).actionLogDays).toBe(before.actionLogDays);
  });

  it('refuses a second row, so `get` can never pick the wrong one', async () => {
    // `get` reads id=1 by construction, but the singleton CHECK is what makes
    // "the one row" true; without it a stray insert would give the worker and
    // the UI two different horizons to read.
    expect(
      await violatedConstraint(
        fx.db.insert(retentionConfigTable).values({ id: 2, actionLogDays: 1 }),
      ),
    ).toBe('retention_config_id_check');
    const rows = await fx.db.select().from(retentionConfigTable);
    expect(rows).toHaveLength(1);
  });

  it('a duplicate insert at id=1 is rejected by the primary key', async () => {
    await expect(fx.db.insert(retentionConfigTable).values({ id: 1 })).rejects.toThrow();
    expect(
      await fx.db.select().from(retentionConfigTable).where(eq(retentionConfigTable.id, 1)),
    ).toHaveLength(1);
  });
});
