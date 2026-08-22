import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { migrate } from '../src/migrate.js';

// Migration-safety test for the action_logs root-heap drain.
//
// A hypertable keeps its rows in chunks. TimescaleDB leaves the parent relation
// out of a hypertable's query plan, so a row stranded in the root heap is
// invisible to every statement naming action_logs, while `alter table ... set
// not null` scans that heap directly and sees it. That asymmetry aborted 0076
// in deployment: the id backfill reported every row updated and the closing
// constraint still failed on a null.
//
// A fresh database has an empty root heap, so the drain deletes nothing and
// inserts nothing. Running the migrations proves precisely nothing unless a
// stranded row is present first. So each scenario below applies migrations up to
// a chosen point, seeds a row into the root heap, asserts it really is stranded,
// and only then applies the rest.
//
// Both orderings the drain claims to support get their own scenario, because
// they are not the same statement: before 0076 the `id` column does not exist
// and 0076's backfill supplies it, after 0076 the column is NOT NULL with a
// default and a unique index on (profile_id, time desc, id desc) already exists.
//
// Needs a real Postgres: TESTCONTAINERS=1 boots a throwaway container, or
// DATABASE_TEST_URL names a pre-existing server (a throwaway database is created
// on it so the partial-migration sequence starts from an empty schema). Skipped
// in the no-Docker unit lane.

const HAS_INFRA =
  process.env['TESTCONTAINERS'] === '1' || Boolean(process.env['DATABASE_TEST_URL']);

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '..', 'migrations');

// The drain sorts between 0075 and 0076, so a numeric prefix cannot split the
// sequence here: `0075a` and `0075` share the first four characters.
const DRAIN_MIGRATION = '0075a_action_logs_root_heap_drain.sql';

const STRANDED_CTX = { rescued: true, n: 1 };

const migrationNames = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

/** Copies the named migrations into a scratch directory for the runner to apply. */
const stageDirFor = (names: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'root-heap-mig-'));
  for (const name of names) {
    copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
  }
  return dir;
};

type Seeded = {
  pool: Pool;
  strandedBefore: number;
  visibleBefore: number;
  chunksBefore: number;
};

describe.skipIf(!HAS_INFRA)('action_logs root-heap drain', () => {
  let stopContainer: () => Promise<void> = async () => undefined;
  let baseUrl = '';
  const createdDbs: string[] = [];
  const openPools: Pool[] = [];

  const withAdmin = async (sql: string): Promise<void> => {
    const adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    try {
      await admin.query(sql);
    } finally {
      await admin.end();
    }
  };

  /**
   * Applies `stage1`, strands a row in the root heap, then applies everything.
   * Returns the pool plus the pre-drain counts the assertions rest on.
   */
  const seedAndDrain = async (stage1: string[], profileId: string): Promise<Seeded> => {
    const dbName = `bt_root_heap_${randomUUID().replace(/-/g, '')}`;
    await withAdmin(`create database "${dbName}"`);
    createdDbs.push(dbName);

    const target = new URL(baseUrl);
    target.pathname = `/${dbName}`;
    const connectionString = target.toString();

    await migrate({ connectionString, migrationsDir: stageDirFor(stage1), log: () => undefined });

    const pool = new Pool({ connectionString });
    openPools.push(pool);

    // A normally-routed row first, so the hypertable owns at least one chunk.
    // Not decoration: with zero chunks TimescaleDB has nothing to expand the
    // hypertable to and leaves the parent in the plan, so 0076's backfill
    // reaches the stranded row and `set not null` passes. Only once a chunk
    // exists does the planner drop the parent and reproduce the deployed
    // failure. Production carried 192 chunks.
    await pool.query(
      `insert into action_logs (time, profile_id, symbol, level, msg, ctx)
       values (now(), $1, 'ETHUSDT', 'info', 'routed into a chunk', '{}'::jsonb)`,
      [randomUUID()],
    );

    // Restoring mode is the one supported way to reach the root heap: it
    // suspends the routing that would otherwise file the row into a chunk.
    // post_restore must always run, the database is not usable normally until
    // it does. Seeded at now() rather than backdated, because until 0076 runs
    // action_logs still carries 0005's 7-day retention policy and post_restore
    // restarts the background workers that would enforce it.
    await pool.query('select timescaledb_pre_restore()');
    try {
      await pool.query(
        `insert into action_logs (time, profile_id, symbol, level, msg, ctx)
         values (now(), $1, 'BTCUSDT', 'warn', 'stranded in root heap', $2::jsonb)`,
        [profileId, JSON.stringify(STRANDED_CTX)],
      );
    } finally {
      await pool.query('select timescaledb_post_restore()');
    }

    const countOf = async (sql: string): Promise<number> =>
      Number((await pool.query<{ n: string }>(sql)).rows[0]?.n ?? '-1');

    const seeded: Seeded = {
      pool,
      strandedBefore: await countOf('select count(*) as n from only action_logs'),
      visibleBefore: await countOf('select count(*) as n from action_logs'),
      chunksBefore: await countOf(
        `select count(*) as n from timescaledb_information.chunks
         where hypertable_name = 'action_logs'`,
      ),
    };

    // Fail here rather than let the rest of the scenario run against a fixture
    // that was never built. TimescaleDB discards a root-heap row from 2.28.0 on,
    // so on a newer server every assertion below would either pass vacuously or
    // fail as an unexplained `column "id" contains null values` out of the next
    // migrate() call. Say which server refused instead.
    if (seeded.strandedBefore !== 1) {
      const { rows } = await pool.query<{ v: string }>(
        `select extversion as v from pg_extension where extname = 'timescaledb'`,
      );
      throw new Error(
        `could not strand a row in the action_logs root heap on timescaledb ${rows[0]?.v ?? 'unknown'} ` +
          `(only action_logs = ${seeded.strandedBefore}). Servers from 2.28.0 discard rows inserted ` +
          `while timescaledb.restoring is on, so this fixture needs the pinned pre-2.28.0 legacy image.`,
      );
    }

    // Without the drain this call throws on 0076's `set not null`.
    await migrate({
      connectionString,
      migrationsDir: stageDirFor(migrationNames()),
      log: () => undefined,
    });

    return seeded;
  };

  beforeAll(async () => {
    if (process.env['TESTCONTAINERS'] === '1') {
      const { ROOT_HEAP_MIGRATION_POSTGRES_IMAGE, withPostgres } =
        await import('@app/testcontainers');
      const pg = await withPostgres(ROOT_HEAP_MIGRATION_POSTGRES_IMAGE);
      baseUrl = pg.databaseUrl;
      stopContainer = pg.stop;
    } else {
      baseUrl = process.env['DATABASE_TEST_URL'] as string;
    }
  }, 180_000);

  afterAll(async () => {
    // Pools first: `drop database ... with (force)` terminates their backends,
    // and node-postgres surfaces that as an uncaught 57P01 on an idle client.
    await Promise.all(openPools.map((p) => p.end()));
    for (const dbName of createdDbs) {
      await withAdmin(`drop database if exists "${dbName}" with (force)`);
    }
    await stopContainer();
  });

  /** The assertions both orderings must satisfy. */
  const sharedExpectations = (seeded: () => Seeded, profileId: () => string): void => {
    it('seeds a row that is genuinely stranded and invisible', () => {
      // The precondition the rest of the scenario rests on. Without it every
      // assertion below would hold trivially against an empty root heap.
      expect(seeded().strandedBefore).toBe(1);
      // Only the routed row is reachable through the hypertable.
      expect(seeded().visibleBefore).toBe(1);
      // Pins the condition that makes the failure reproduce at all. Drop the
      // routed row and the parent stays in the backfill's plan, which turns the
      // whole scenario green against an unfixed migration.
      expect(seeded().chunksBefore).toBeGreaterThan(0);
    });

    it('empties the root heap', async () => {
      const res = await seeded().pool.query<{ n: string }>(
        'select count(*) as n from only action_logs',
      );
      expect(Number(res.rows[0]?.n)).toBe(0);
    });

    it('carries every column of the rescued row through the drain', async () => {
      // The drain repeats a six-column list twice, which is the most fragile
      // thing in the migration. Asserting only that some row survived would
      // stay green if a column were dropped from either list.
      const res = await seeded().pool.query<{
        symbol: string;
        level: string;
        msg: string;
        ctx: unknown;
        id: string | null;
      }>('select symbol, level, msg, ctx, id from action_logs where profile_id = $1', [
        profileId(),
      ]);
      expect(res.rowCount).toBe(1);
      expect(res.rows[0]?.symbol).toBe('BTCUSDT');
      expect(res.rows[0]?.level).toBe('warn');
      expect(res.rows[0]?.msg).toBe('stranded in root heap');
      expect(res.rows[0]?.ctx).toEqual(STRANDED_CTX);
      expect(res.rows[0]?.id).not.toBeNull();
    });

    it('conserves the row count and leaves the routed row alone', async () => {
      const res = await seeded().pool.query<{ total: string; routed: string }>(
        `select count(*) as total,
                count(*) filter (where msg = 'routed into a chunk') as routed
         from action_logs`,
      );
      expect(Number(res.rows[0]?.total)).toBe(2);
      expect(Number(res.rows[0]?.routed)).toBe(1);
    });
  };

  describe('applied before 0076, on a fresh database', () => {
    const profileId = randomUUID();
    let seeded: Seeded;

    beforeAll(async () => {
      const all = migrationNames();
      const cut = all.indexOf(DRAIN_MIGRATION);
      // Guards against a rename silently turning this into a full-sequence run
      // with nothing seeded, which would pass while testing nothing.
      if (cut < 0) {
        throw new Error(`${DRAIN_MIGRATION} not found in ${MIGRATIONS_DIR}`);
      }
      seeded = await seedAndDrain(all.slice(0, cut), profileId);
    }, 180_000);

    sharedExpectations(
      () => seeded,
      () => profileId,
    );
  });

  describe('picked up later, on a database already carrying 0076', () => {
    const profileId = randomUUID();
    let seeded: Seeded;

    beforeAll(async () => {
      // The ordering that runs on any environment where 0076 already applied.
      // Here `id` is already NOT NULL with a default, and the unique index on
      // (profile_id, time desc, id desc) is already in place, so the re-insert
      // has to satisfy a constraint that did not exist in the other ordering.
      const withoutDrain = migrationNames().filter((n) => n !== DRAIN_MIGRATION);
      if (withoutDrain.length === migrationNames().length) {
        throw new Error(`${DRAIN_MIGRATION} not found in ${MIGRATIONS_DIR}`);
      }
      seeded = await seedAndDrain(withoutDrain, profileId);
    }, 180_000);

    sharedExpectations(
      () => seeded,
      () => profileId,
    );
  });
});
