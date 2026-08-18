import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { migrate } from '../src/migrate.js';

// Pins the runner-side half of the migration-immutability invariant, whose repo-side half is guarded by `scripts/ci/no-mutated-applied-migration.sh`.
//
// The gate can only see a file whose digest moved. What makes that fatal lives here, in `migrate()`: the ledger stores a name and a checksum, and a mismatch throws BEFORE any later migration runs. Without a test the four lines that throw could be deleted and every gate in `lint.sh`, plus the rest of the `packages/db` suite, would still pass — the invariant would be unenforced everywhere including production, with the CI gate still reporting the repo clean.
//
// The fixture is synthetic rather than the real `migrations/` tree: the invariant is a property of the runner, not of any particular migration, and throwaway tables keep the cases fast and independent of whatever ships next. Every migration below is written `if not exists` so that re-applying one is silently successful — that is what makes the rename case demonstrate corruption rather than a duplicate-table error.
//
// Each case gets its OWN database. The ledger is the state under test, so sharing one would let an earlier case's rows decide a later case's outcome.
//
// Needs a real Postgres: TESTCONTAINERS=1 boots a throwaway container, or DATABASE_TEST_URL names a pre-existing server. Skipped in the no-Docker unit lane.

const HAS_INFRA =
  process.env['TESTCONTAINERS'] === '1' || Boolean(process.env['DATABASE_TEST_URL']);

describe.skipIf(!HAS_INFRA)('migrate() refuses to replay mutated history', () => {
  let stopContainer: () => Promise<void> = async () => undefined;
  let adminUrl: URL;
  let baseUrl: string;
  const created: string[] = [];
  const fixtureDirs: string[] = [];

  const withAdmin = async (sql: string): Promise<void> => {
    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    try {
      await admin.query(sql);
    } finally {
      await admin.end();
    }
  };

  /** A database of its own for one case, so no case can observe another's ledger. */
  const freshDb = async (): Promise<string> => {
    const name = `bt_mig_immut_${randomUUID().replace(/-/g, '')}`;
    await withAdmin(`create database "${name}"`);
    created.push(name);
    const url = new URL(baseUrl);
    url.pathname = `/${name}`;
    return url.toString();
  };

  /** A fresh two-migration fixture directory, so each case starts from a known-good tree. */
  const seedDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-immut-'));
    fixtureDirs.push(dir);
    writeFileSync(join(dir, '0001_alpha.sql'), 'create table if not exists alpha (id int);\n');
    writeFileSync(join(dir, '0002_beta.sql'), 'create table if not exists beta (id int);\n');
    return dir;
  };

  const run = (connectionString: string, migrationsDir: string) =>
    migrate({ connectionString, migrationsDir, log: () => undefined });

  const ledgerNames = async (connectionString: string): Promise<string[]> => {
    const pool = new Pool({ connectionString });
    try {
      const { rows } = await pool.query<{ name: string }>(
        'select name from _app_migrations order by name',
      );
      return rows.map((r) => r.name);
    } finally {
      await pool.end();
    }
  };

  beforeAll(async () => {
    if (process.env['TESTCONTAINERS'] === '1') {
      const pg = await (await import('@app/testcontainers')).withPostgres();
      baseUrl = pg.databaseUrl;
      stopContainer = pg.stop;
    } else {
      baseUrl = process.env['DATABASE_TEST_URL'] as string;
    }
    adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
  }, 120_000);

  afterAll(async () => {
    // Settled, not sequential-await: one drop that rejects must not strand the container, which is the only teardown here that cannot be swept by anything else.
    try {
      await Promise.allSettled(
        created.map((name) => withAdmin(`drop database if exists "${name}" with (force)`)),
      );
      for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
    } finally {
      await stopContainer();
    }
  });

  it('throws when an applied migration body changes, even by a comment', async () => {
    const db = await freshDb();
    const dir = seedDir();
    const first = await run(db, dir);
    expect(first.applied).toEqual(['0001_alpha.sql', '0002_beta.sql']);

    // A comment is the cheapest possible edit and the one a reviewer is least likely to stop, which is exactly why it is the case worth pinning.
    appendFileSync(join(dir, '0001_alpha.sql'), '-- clarifying note\n');

    await expect(run(db, dir)).rejects.toThrow(/Refusing to mutate history/);
  });

  it('blocks every later migration behind the mutated one', async () => {
    const db = await freshDb();
    const dir = seedDir();
    await run(db, dir);

    // A brand-new migration with nothing to do with the mutation. It must NOT apply: the runner throws at 0001, so a deployment carrying both a repair and an unrelated change lands neither. This is why no repair migration can fix a wedged database in-band.
    appendFileSync(join(dir, '0001_alpha.sql'), '-- clarifying note\n');
    writeFileSync(join(dir, '0003_gamma.sql'), 'create table if not exists gamma (id int);\n');

    await expect(run(db, dir)).rejects.toThrow(/Refusing to mutate history/);
    expect(await ledgerNames(db)).not.toContain('0003_gamma.sql');
  });

  it('cannot see a renamed migration, which is the gap the repo-side gate closes', async () => {
    const db = await freshDb();
    const dir = seedDir();
    await run(db, dir);

    // Renumbering an applied file is invisible to the runner, because the ledger keys on NAME. The old row is orphaned and the identical body re-applies under the new name — no error, no warning, and a ledger that now claims a migration ran which no longer exists. No fresh-database suite can see this either, since a fresh database applies the renamed file once and looks perfectly correct. That blind spot is the whole reason the repo-side digest gate exists.
    renameSync(join(dir, '0001_alpha.sql'), join(dir, '0004_alpha.sql'));

    const second = await run(db, dir);
    expect(second.applied).toEqual(['0004_alpha.sql']);
    expect(await ledgerNames(db)).toEqual(['0001_alpha.sql', '0002_beta.sql', '0004_alpha.sql']);
  });
});
