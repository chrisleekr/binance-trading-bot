import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

// Custom migration runner.
// Why custom (not drizzle-kit migrate): we need extensions, roles, and TimescaleDB
// hypertable / retention DDL that drizzle-kit cannot express. Each migration file
// is plain SQL applied once; applied checksums are tracked in `_app_migrations`.
//
// Files in `migrations/` are applied in lexicographic order. Each file is
// idempotent on first run because the runner skips files whose checksum is
// already recorded. Files that are themselves idempotent (the SQL uses
// `if not exists`, `do $$ … end$$`) re-run cleanly on a corrupted environment.

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '..', 'migrations');

const TRACKING_TABLE_DDL = `
  create table if not exists _app_migrations (
    name      text primary key,
    checksum  text not null,
    applied_at timestamptz not null default now()
  );
`;

// Serializes concurrent migrators on one session advisory lock. The present
// driver is parallel vitest workers each migrating the shared test DB; without
// the lock they all read an empty _app_migrations and race on the
// non-transactional `create type` DDL, throwing a pg_type_typname_nsp_index
// duplicate-key. A fixed key shared by every migrator; a no-op when only one
// migrator runs (production migrates from a single entrypoint). This is a
// migration-time DB lock, not a runtime coordination lock, so it does not
// breach the single-replica no-distributed-locks invariant.
const MIGRATION_LOCK_KEY = 4_927_865_201;

interface MigrationFile {
  name: string;
  body: string;
  checksum: string;
}

/**
 * The digest `_app_migrations` stores for a migration body.
 *
 * Exported so `scripts/ci/no-mutated-applied-migration.sh` pins the digest THIS function computes rather than one a copy of it computes. A manifest pinning a value the runner does not produce would pin nothing, and a hand-copy makes that alignment a comment rather than a fact — change the algorithm here and the gate keeps passing against digests nothing checks against.
 *
 * @param input - A migration body, read as utf8.
 * @returns Lowercase hex SHA-256.
 */
export const sha256 = async (input: string): Promise<string> => {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * Every migration in `dir`, in apply order, with the digest the ledger compares against.
 *
 * Exported for the same reason as {@link sha256}: the immutability gate must walk migrations by the runner's own selection rule, not a re-implementation of it. Only top-level `*.sql` counts, so a subdirectory or a `.sql.bak` is not a migration.
 *
 * @param dir - The migrations directory.
 * @returns One entry per migration, sorted by file name, each carrying its body and checksum.
 */
export const loadMigrations = async (dir: string): Promise<MigrationFile[]> => {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort();
  const files: MigrationFile[] = [];
  for (const name of entries) {
    const body = readFileSync(join(dir, name), 'utf8');
    files.push({ name, body, checksum: await sha256(body) });
  }
  return files;
};

export interface MigrateOptions {
  connectionString: string;
  migrationsDir?: string;
  log?: (msg: string) => void;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export const migrate = async (opts: MigrateOptions): Promise<MigrateResult> => {
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const log = opts.log ?? ((m) => console.log(m));
  const files = await loadMigrations(dir);
  const client = new Client({ connectionString: opts.connectionString });
  await client.connect();

  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    // Block until any other migrator releases the lock; the loser then sees
    // every migration already recorded and skips. Session-scoped, so it
    // releases when the connection closes in `finally` (or on crash) and a
    // dead migrator never wedges the next one.
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(TRACKING_TABLE_DDL);
    const known = await client.query<{ name: string; checksum: string }>(
      'select name, checksum from _app_migrations',
    );
    const knownByName = new Map(known.rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const prevChecksum = knownByName.get(file.name);
      if (prevChecksum !== undefined) {
        if (prevChecksum !== file.checksum) {
          throw new Error(
            `Migration ${file.name} already applied with a different checksum (was ${prevChecksum}, now ${file.checksum}). Refusing to mutate history.`,
          );
        }
        skipped.push(file.name);
        continue;
      }

      log(`applying ${file.name}`);
      await client.query('begin');
      try {
        await client.query(file.body);
        await client.query('insert into _app_migrations (name, checksum) values ($1, $2)', [
          file.name,
          file.checksum,
        ]);
        await client.query('commit');
        applied.push(file.name);
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    }
  } finally {
    await client.end();
  }

  return { applied, skipped };
};

export const cliMain = async (): Promise<void> => {
  const conn = process.env['DATABASE_URL'];
  if (!conn) {
    throw new Error('DATABASE_URL is required to run migrations');
  }
  const result = await migrate({ connectionString: conn });
  console.log(`migrations: ${result.applied.length} applied, ${result.skipped.length} skipped`);
};
