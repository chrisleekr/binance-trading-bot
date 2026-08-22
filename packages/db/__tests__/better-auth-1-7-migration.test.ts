import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DB_URL = process.env['DATABASE_TEST_URL'];
const HAS_INFRA = process.env['TESTCONTAINERS'] === '1' || Boolean(TEST_DB_URL);
const HERE = dirname(fileURLToPath(import.meta.url));
const migration = (name: string): string =>
  readFileSync(resolve(HERE, '..', 'migrations', name), 'utf8');
const LEGACY_SCHEMA = migration('0007_better_auth.sql');
const UPGRADE = migration('0087_better_auth_account_issuer.sql');

let databaseUrl = TEST_DB_URL ?? '';
let stopPostgres: () => Promise<void> = async () => undefined;

const withLegacySchema = async (run: (client: Client) => Promise<void>): Promise<void> => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const schemaName = `better_auth_17_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query('begin');
    await client.query(`create schema "${schemaName}"`);
    await client.query(`set local search_path to "${schemaName}"`);
    await client.query(LEGACY_SCHEMA);
    await run(client);
  } finally {
    await client.query('rollback');
    await client.end();
  }
};

describe.skipIf(!HAS_INFRA)('Better Auth 1.7 account identity migration', () => {
  beforeAll(async () => {
    if (process.env['TESTCONTAINERS'] !== '1') return;
    const postgres = await import('@app/testcontainers').then((m) => m.withPostgres());
    databaseUrl = postgres.databaseUrl;
    stopPostgres = postgres.stop;
  }, 120_000);

  afterAll(async () => stopPostgres());

  it('backfills credential identity and replaces the legacy provider index', async () => {
    await withLegacySchema(async (client) => {
      const userId = randomUUID();
      await client.query(`insert into "user" (id, email) values ($1, $2)`, [
        userId,
        `${userId}@test.local`,
      ]);
      await client.query(
        `insert into "account" (id, "userId", "providerId", "accountId", password)
         values ($1, $2, 'credential', 'legacy-provider-id', 'hash')`,
        [randomUUID(), userId],
      );

      await client.query(UPGRADE);

      const identity = await client.query<{ issuer: string; accountId: string }>(
        `select issuer, "accountId" from "account"`,
      );
      expect(identity.rows).toEqual([{ issuer: 'local:credential', accountId: userId }]);

      const column = await client.query<{ is_nullable: string }>(
        `select is_nullable from information_schema.columns
         where table_schema = current_schema() and table_name = 'account' and column_name = 'issuer'`,
      );
      expect(column.rows[0]?.is_nullable).toBe('NO');

      const indexes = await client.query<{ indexname: string; indexdef: string }>(
        `select indexname, indexdef from pg_indexes
         where schemaname = current_schema() and tablename = 'account'`,
      );
      expect(indexes.rows.some((row) => row.indexname === 'account_provider_uniq')).toBe(false);
      expect(
        indexes.rows.find((row) => row.indexname === 'account_issuer_accountId_uidx')?.indexdef,
      ).toContain('UNIQUE INDEX');
    });
  });

  it('refuses to guess the issuer for an unexpected provider', async () => {
    await withLegacySchema(async (client) => {
      const userId = randomUUID();
      await client.query(`insert into "user" (id, email) values ($1, $2)`, [
        userId,
        `${userId}@test.local`,
      ]);
      await client.query(
        `insert into "account" (id, "userId", "providerId", "accountId")
         values ($1, $2, 'github', 'provider-user')`,
        [randomUUID(), userId],
      );

      await expect(client.query(UPGRADE)).rejects.toThrow(/supports only credential accounts/);
    });
  });

  it('rejects identities that collide after the credential backfill', async () => {
    await withLegacySchema(async (client) => {
      const userId = randomUUID();
      await client.query(`insert into "user" (id, email) values ($1, $2)`, [
        userId,
        `${userId}@test.local`,
      ]);
      await client.query(
        `insert into "account" (id, "userId", "providerId", "accountId")
         values ($1, $2, 'credential', 'legacy-one'),
                ($3, $2, 'credential', 'legacy-two')`,
        [randomUUID(), userId, randomUUID()],
      );
      await client.query('savepoint before_upgrade');

      await expect(client.query(UPGRADE)).rejects.toThrow(/account identity collision/);
      await client.query('rollback to savepoint before_upgrade');

      const issuerColumn = await client.query(
        `select 1 from information_schema.columns
         where table_schema = current_schema() and table_name = 'account' and column_name = 'issuer'`,
      );
      expect(issuerColumn.rowCount).toBe(0);
      const legacyIndex = await client.query(
        `select 1 from pg_indexes
         where schemaname = current_schema() and indexname = 'account_provider_uniq'`,
      );
      expect(legacyIndex.rowCount).toBe(1);
    });
  });
});
