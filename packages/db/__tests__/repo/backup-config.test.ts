import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupConfig } from '../../src/repo/index.js';
import { backupConfig as backupConfigTable } from '../../src/schema/backup-config.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

/**
 * Round-trip suite for the global `backup_config` singleton. Skipped when
 * `TEST_DB_URL` is unset so workstations without Postgres still see
 * `bun run test` go green; CI runs against a live database.
 *
 * The singleton is global, not per-account, so these assertions run in one
 * ordered test: the migration seeds id=1 with defaults, then upsert mutates the
 * three editable fields, then touchLastBackup stamps last_backup_at.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('backup-config repo', () => {
  let fx: IsolationFixture;

  beforeAll(async () => {
    fx = await setupFixture();
    // Reset the shared singleton to its seeded defaults so this suite is
    // independent of any prior mutation on the shared test DB.
    await backupConfig.upsert(fx.db, {
      enabled: false,
      intervalHours: 24,
      retentionCount: 14,
    });
    // upsert covers only the three editable fields; null last_backup_at too so
    // the touchLastBackup case starts from a clean singleton even when a prior
    // run stamped it on a persistent test DB.
    await fx.db
      .update(backupConfigTable)
      .set({ lastBackupAt: null })
      .where(eq(backupConfigTable.id, 1));
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('get returns the seeded defaults', async () => {
    const row = await backupConfig.get(fx.db);
    expect(row.id).toBe(1);
    expect(row.enabled).toBe(false);
    expect(row.intervalHours).toBe(24);
    expect(row.retentionCount).toBe(14);
  });

  it('upsert changes the three editable fields and persists', async () => {
    const updated = await backupConfig.upsert(fx.db, {
      enabled: true,
      intervalHours: 6,
      retentionCount: 30,
    });
    expect(updated.enabled).toBe(true);
    expect(updated.intervalHours).toBe(6);
    expect(updated.retentionCount).toBe(30);

    const reread = await backupConfig.get(fx.db);
    expect(reread.enabled).toBe(true);
    expect(reread.intervalHours).toBe(6);
    expect(reread.retentionCount).toBe(30);
  });

  it('touchLastBackup stamps last_backup_at on the singleton', async () => {
    const before = await backupConfig.get(fx.db);
    expect(before.lastBackupAt).toBeNull();

    const at = new Date('2026-06-20T12:00:00Z');
    await backupConfig.touchLastBackup(fx.db, at);

    const after = await backupConfig.get(fx.db);
    expect(after.lastBackupAt?.getTime()).toBe(at.getTime());
  });
});
