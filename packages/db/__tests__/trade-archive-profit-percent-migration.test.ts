import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { migrate } from '../src/migrate.js';
import { HAS_INFRA, sharedDatabaseUrl } from './_infra.js';

describe.skipIf(!HAS_INFRA)('trade_archive profit percentage migration', () => {
  const dbName = `bt_trade_archive_pct_${randomUUID().replaceAll('-', '')}`;
  let adminUrl: URL;
  let pool: Pool;

  /**
   * Runs scratch-database DDL through a one-shot maintenance connection because CREATE/DROP DATABASE sit outside the target pool's lifecycle.
   * @param sql - The scratch-database DDL to run on the maintenance database.
   * @returns A promise that settles after the maintenance client closes, including when the statement fails.
   */
  const withAdmin = async (sql: string): Promise<void> => {
    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    try {
      await admin.query(sql);
    } finally {
      await admin.end();
    }
  };

  beforeAll(async () => {
    const baseUrl = await sharedDatabaseUrl();
    adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    await withAdmin(`create database "${dbName}"`);

    const targetUrl = new URL(baseUrl);
    targetUrl.pathname = `/${dbName}`;
    await migrate({ connectionString: targetUrl.toString(), log: () => undefined });
    pool = new Pool({ connectionString: targetUrl.toString() });
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminUrl) await withAdmin(`drop database if exists "${dbName}" with (force)`);
  });

  it('keeps profit and drops profit_percent from a freshly migrated schema', async () => {
    const result = await pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public'
         and table_name = 'trade_archive'
         and column_name in ('profit', 'profit_percent')`,
    );
    const columns = result.rows.map((row) => row.column_name);

    expect(columns).toContain('profit');
    expect(columns).not.toContain('profit_percent');
  });
});
