import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * Integration coverage for the backup-config router: GET returns the seeded
 * defaults + empty status, PUT persists and round-trips, an out-of-range body is
 * rejected by the validator, the on-disk dump listing surfaces only matching
 * files newest-first, and both endpoints require a session.
 *
 * BACKUP_DIR is read by the test DI at setupApp() time (see _helpers), so a test
 * that needs a populated dump directory sets process.env.BACKUP_DIR before
 * building its own fixture and restores it afterwards.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const headers = (userId: string): Record<string, string> => ({
  'x-test-user-id': userId,
  'content-type': 'application/json',
});

interface ConfigBody {
  enabled: boolean;
  intervalHours: number;
  retentionCount: number;
  lastBackupAt: string | null;
  nextDueAt: string | null;
  recentBackups: { name: string; sizeBytes: number; modifiedAt: string }[];
}

describeIfInfra('backup-config router', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('GET returns the seeded defaults on a fresh DB (disabled, no backups)', async () => {
    const res = await fx.app.request('/api/backup/config', {
      headers: headers(fx.alice.userId),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigBody;
    expect(body.enabled).toBe(false);
    expect(body.intervalHours).toBe(24);
    expect(body.retentionCount).toBe(14);
    expect(body.lastBackupAt).toBeNull();
    expect(body.nextDueAt).toBeNull();
    expect(body.recentBackups).toEqual([]);
  });

  it('PUT persists the config and a subsequent GET reflects it', async () => {
    const put = await fx.app.request('/api/backup/config', {
      method: 'PUT',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({ enabled: true, intervalHours: 6, retentionCount: 5 }),
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as ConfigBody;
    expect(putBody.enabled).toBe(true);
    expect(putBody.intervalHours).toBe(6);
    expect(putBody.retentionCount).toBe(5);
    // Enabled but no backup has run, so the UI shows "pending first backup".
    expect(putBody.nextDueAt).toBeNull();

    const get = await fx.app.request('/api/backup/config', {
      headers: headers(fx.alice.userId),
    });
    const getBody = (await get.json()) as ConfigBody;
    expect(getBody.enabled).toBe(true);
    expect(getBody.intervalHours).toBe(6);
    expect(getBody.retentionCount).toBe(5);
  });

  it('computes nextDueAt as lastBackupAt + interval once a backup has run', async () => {
    const { repo } = await import('@app/db');
    const at = new Date('2026-06-20T00:00:00.000Z');
    await repo.backupConfig.upsert(fx.di.db, {
      enabled: true,
      intervalHours: 6,
      retentionCount: 5,
    });
    await repo.backupConfig.touchLastBackup(fx.di.db, at);

    const res = await fx.app.request('/api/backup/config', {
      headers: headers(fx.alice.userId),
    });
    const body = (await res.json()) as ConfigBody;
    expect(body.lastBackupAt).toBe(at.toISOString());
    expect(body.nextDueAt).toBe(new Date('2026-06-20T06:00:00.000Z').toISOString());
  });

  it('PUT rejects an out-of-range body (422) and leaves the config unchanged', async () => {
    const before = (await (
      await fx.app.request('/api/backup/config', { headers: headers(fx.alice.userId) })
    ).json()) as ConfigBody;

    const bad = await fx.app.request('/api/backup/config', {
      method: 'PUT',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({ enabled: true, intervalHours: 0, retentionCount: -1 }),
    });
    expect(bad.status).toBe(422);

    const after = (await (
      await fx.app.request('/api/backup/config', { headers: headers(fx.alice.userId) })
    ).json()) as ConfigBody;
    expect(after.intervalHours).toBe(before.intervalHours);
    expect(after.retentionCount).toBe(before.retentionCount);
  });

  it('GET and PUT require a session (401 without auth)', async () => {
    const get = await fx.app.request('/api/backup/config');
    expect(get.status).toBe(401);
    const put = await fx.app.request('/api/backup/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, intervalHours: 24, retentionCount: 14 }),
    });
    expect(put.status).toBe(401);
  });
});

/**
 * recentBackups listing runs against a real temp directory. Its own fixture is
 * built after BACKUP_DIR is pointed at the temp dir so the test DI picks it up;
 * a separate describe keeps the env mutation off the shared fixture above.
 */
describeIfInfra('backup-config recentBackups listing', () => {
  let dir: string;
  let prevBackupDir: string | undefined;
  let fx: ApiFixture;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'backup-list-'));
    // Two valid dumps (the higher timestamp must sort first) plus an unrelated
    // file the listing must ignore.
    await writeFile(join(dir, 'backup-1000.dump'), 'a');
    await writeFile(join(dir, 'backup-2000.dump'), 'bb');
    await writeFile(join(dir, 'notes.txt'), 'ignore me');
    prevBackupDir = process.env['BACKUP_DIR'];
    process.env['BACKUP_DIR'] = dir;
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
    if (prevBackupDir === undefined) delete process.env['BACKUP_DIR'];
    else process.env['BACKUP_DIR'] = prevBackupDir;
    await rm(dir, { recursive: true, force: true });
  });

  it('lists only matching dumps, newest-first', async () => {
    const res = await fx.app.request('/api/backup/config', {
      headers: headers(fx.alice.userId),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigBody;
    expect(body.recentBackups.map((b) => b.name)).toEqual(['backup-2000.dump', 'backup-1000.dump']);
    expect(body.recentBackups[0]?.sizeBytes).toBe(2);
    expect(body.recentBackups[1]?.sizeBytes).toBe(1);
    expect(typeof body.recentBackups[0]?.modifiedAt).toBe('string');
  });
});

// ENOENT path: a BACKUP_DIR that does not exist yields an empty list, not a 500.
describeIfInfra('backup-config recentBackups missing dir', () => {
  let prevBackupDir: string | undefined;
  let fx: ApiFixture;

  beforeAll(async () => {
    prevBackupDir = process.env['BACKUP_DIR'];
    process.env['BACKUP_DIR'] = join(tmpdir(), `backup-missing-${Date.now()}`);
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
    if (prevBackupDir === undefined) delete process.env['BACKUP_DIR'];
    else process.env['BACKUP_DIR'] = prevBackupDir;
  });

  it('returns an empty recentBackups list when the dir is absent', async () => {
    const res = await fx.app.request('/api/backup/config', {
      headers: headers(fx.alice.userId),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigBody;
    expect(body.recentBackups).toEqual([]);
  });
});
