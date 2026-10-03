// Migration 0095 and the drizzle mirror in `schema/better-auth-oauth.ts` are two hand-written transcriptions of one generated schema, and nothing else in the repo reads these tables: no repo function, no projection, no domain query. A column misspelled in one file and not the other therefore produces no type error and no failing query anywhere, and surfaces only as a runtime adapter fault the first time an agent tries to authorize.
//
// So the assertion is column-for-column between the migrated database and the drizzle table objects, in both directions, including nullability and SQL type. A column the SQL creates and the mirror omits is as much a defect as the reverse: the adapter's writes go through the mirror, so a column it cannot see is a field Better Auth silently drops.

import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import {
  jwks,
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
} from '../src/schema/better-auth-oauth.js';
import { HAS_INFRA, sharedDatabaseUrl } from './_infra.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '..', 'migrations');

const MIRRORED_TABLES: readonly PgTable[] = [
  jwks,
  oauthClient,
  oauthResource,
  oauthClientResource,
  oauthRefreshToken,
  oauthAccessToken,
  oauthConsent,
  oauthClientAssertion,
];

interface ColumnShape {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
}

const byName = (a: ColumnShape, b: ColumnShape): number => a.name.localeCompare(b.name);

/** What the drizzle mirror claims the table looks like, in the same shape the catalogue query returns so the two can be compared directly. */
const mirroredColumns = (table: PgTable): ColumnShape[] =>
  getTableConfig(table)
    .columns.map((column) => ({
      name: column.name,
      type: column.getSQLType(),
      notNull: column.notNull,
    }))
    .sort(byName);

describe.skipIf(!HAS_INFRA)('OAuth provider tables migration', () => {
  const dbName = `oauth_tables_${randomUUID().replaceAll('-', '')}_test`;
  let adminUrl: URL;
  let pool: Pool;

  const withAdmin = async (sql: string): Promise<void> => {
    const client = new Client({ connectionString: adminUrl.toString() });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    const baseUrl = await sharedDatabaseUrl();
    adminUrl = new URL(baseUrl);
    await withAdmin(`create database "${dbName}"`);
    const target = new URL(baseUrl);
    target.pathname = `/${dbName}`;
    // The whole ledger, not a staged subset: 0095 creates tables that never existed, so there is no pre-migration state to seed and the thing worth proving is that it applies behind all 94 predecessors.
    await migrate({
      connectionString: target.toString(),
      migrationsDir: MIGRATIONS_DIR,
      log: () => undefined,
    });
    pool = new Pool({ connectionString: target.toString() });
  });

  afterAll(async () => {
    await pool?.end();
    await withAdmin(`drop database if exists "${dbName}" with (force)`);
  });

  it.each(MIRRORED_TABLES.map((table) => [getTableConfig(table).name, table] as const))(
    'creates %s with exactly the columns the drizzle mirror declares',
    async (_name, table) => {
      const tableName = getTableConfig(table).name;
      const live = await pool.query<{ name: string; type: string; not_null: boolean }>(
        `select a.attname as name,
                format_type(a.atttypid, a.atttypmod) as type,
                a.attnotnull as not_null
           from pg_attribute a
           join pg_class c on c.oid = a.attrelid
           join pg_namespace n on n.oid = c.relnamespace
          where c.relname = $1 and n.nspname = 'public' and a.attnum > 0 and not a.attisdropped`,
        [tableName],
      );
      const actual: ColumnShape[] = live.rows
        .map((row) => ({ name: row.name, type: row.type, notNull: row.not_null }))
        .sort(byName);

      // Non-emptiness first: a typo in `relname` returns zero rows, and comparing two empty lists would certify a table that does not exist.
      expect(actual.length).toBeGreaterThan(0);
      expect(actual).toEqual(mirroredColumns(table));
    },
  );

  it('registers 0095 in the migration ledger', async () => {
    const applied = await pool.query<{ name: string }>(
      `select name from _app_migrations where name = '0095_oauth_provider_tables.sql'`,
    );
    expect(applied.rows).toHaveLength(1);
  });
});
