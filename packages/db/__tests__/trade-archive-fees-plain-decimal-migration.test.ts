// Stored `trade_archive.fees` values written before the producer was fixed carry exponential text — `1e-8` where every reader expects `0.00000001`. The jsonb holds strings, so Postgres normalised nothing on the way in, and the api serves them verbatim into a table cell beside a column of fixed decimals.
//
// The migration rewrites only the values that are actually exponential, so an already-plain row must come back byte-identical: an unconditional `::numeric` round-trip would re-scale every stored fee and make the diff unreviewable. It must also leave `fees_quote_complete` exactly as it found it — the completeness marker is a claim about fee EVIDENCE, and re-spelling a string is not new evidence.

import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { migrate } from '../src/migrate.js';
import { HAS_INFRA, sharedDatabaseUrl } from './_infra.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '..', 'migrations');
const TARGET_PREFIX = 92;
const prefixOf = (name: string): number => Number.parseInt(name.slice(0, 4), 10);

interface FeeRow {
  fees: unknown;
  fees_quote: string;
  fees_quote_complete: boolean;
}

describe.skipIf(!HAS_INFRA)('trade archive plain-decimal fees migration', () => {
  const dbName = `fees_plain_${randomUUID().replaceAll('-', '')}_test`;
  const userId = randomUUID();
  const accountId = randomUUID();
  const profileId = randomUUID();
  const exponentialId = randomUUID();
  const plainId = randomUUID();
  const emptyId = randomUUID();
  const arrayFeesId = randomUUID();
  const numericMemberId = randomUUID();
  const hugeExponentId = randomUUID();
  let adminUrl: URL;
  let stageDir: string;
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

  const archiveRow = async (id: string, fees: string, complete: boolean): Promise<void> => {
    await pool.query(
      "insert into trade_archive (id, profile_id, symbol, base_asset, quote_asset, total_buy_quote, total_sell_quote, profit, fees, fees_quote, fees_quote_complete) values ($1, $2, 'BTCUSDT', 'BTC', 'USDT', 100, 110, 10, $3::jsonb, 7.5, $4)",
      [id, profileId, fees, complete],
    );
  };

  const readRow = async (id: string): Promise<FeeRow | undefined> => {
    const result = await pool.query<FeeRow>(
      'select fees, fees_quote, fees_quote_complete from trade_archive where id = $1',
      [id],
    );
    return result.rows[0];
  };

  beforeAll(async () => {
    stageDir = mkdtempSync(join(HERE, '.tmp-fees-plain-mig-'));
    const baseUrl = await sharedDatabaseUrl();
    adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    const target = new URL(baseUrl);
    target.pathname = `/${dbName}`;
    const targetUrl = target.toString();
    await withAdmin(`create database "${dbName}"`);

    const names = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const name of names.filter((name) => prefixOf(name) < TARGET_PREFIX)) {
      copyFileSync(join(MIGRATIONS_DIR, name), join(stageDir, name));
    }
    await migrate({ connectionString: targetUrl, migrationsDir: stageDir, log: () => undefined });
    pool = new Pool({ connectionString: targetUrl });
    await pool.query('insert into users (id, email) values ($1, $2)', [
      userId,
      `fees-plain-${userId}@test.local`,
    ]);
    await pool.query(
      "insert into accounts (id, owner_id, name, binance_mode) values ($1, $2, 'account', 'test')",
      [accountId, userId],
    );
    await pool.query(
      "insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state) values ($1, $2, 'profile', 'trailing-trade', '2.0.0', '{}', '{}')",
      [profileId, accountId],
    );
    // Both exponent spellings Binance-sized amounts really produce, plus an upper-case `E` and a `+` exponent, because the rewrite is regex-scoped and a spelling it does not match is a value it silently leaves broken.
    await archiveRow(
      exponentialId,
      JSON.stringify({ BNB: '1e-8', DOGE: '3.6e-7', SHIB: '1.5E+21', USDT: '0.5' }),
      true,
    );
    // Already plain, and it must come back byte-identical: an unconditional numeric round-trip would re-scale it and make every row a diff.
    await archiveRow(plainId, JSON.stringify({ USDT: '0.00000001', BTC: '0.5' }), false);
    await archiveRow(emptyId, '{}', false);
    // A non-object body. Without the CTE's `jsonb_typeof(fees) = 'object'` filter `jsonb_each` errors on this row and takes the whole migration down with it.
    await archiveRow(arrayFeesId, '[]', false);
    // A member that is a jsonb NUMBER, not a string. Without the per-value `jsonb_typeof(kv.value) = 'string'` halves, `#>> '{}'` would render it and the regex would decide its fate on text the column does not actually store.
    await archiveRow(numericMemberId, '{"BNB": 5}', false);
    // An exponent no `numeric` can hold. Matched, the cast aborts the transaction, the migration records nothing, and every later deploy re-aborts at the same file — which no further migration can repair, because a shipped one is immutable. The bounded exponent is what leaves this value alone.
    await archiveRow(hugeExponentId, JSON.stringify({ BNB: '1e-20000' }), false);

    const targetMigration = names.find((name) => prefixOf(name) === TARGET_PREFIX);
    if (!targetMigration) throw new Error('plain-decimal fees migration not found');
    copyFileSync(join(MIGRATIONS_DIR, targetMigration), join(stageDir, targetMigration));
    await migrate({ connectionString: targetUrl, migrationsDir: stageDir, log: () => undefined });
  });

  afterAll(async () => {
    await pool?.end();
    if (adminUrl) await withAdmin(`drop database if exists "${dbName}" with (force)`);
    if (stageDir) rmSync(stageDir, { recursive: true, force: true });
  });

  it('rewrites every exponential fee string into plain decimal text, preserving value', async () => {
    const row = await readRow(exponentialId);
    expect(row?.fees).toEqual({
      BNB: '0.00000001',
      DOGE: '0.00000036',
      SHIB: '1500000000000000000000',
      USDT: '0.5',
    });
  });

  it('leaves an already-plain fee value byte-identical', async () => {
    // The scoping half. Without the exponent-shaped predicate the rewrite touches every row, and a `numeric` round-trip is free to re-scale a value nobody asked it to change.
    const row = await readRow(plainId);
    expect(row?.fees).toEqual({ USDT: '0.00000001', BTC: '0.5' });
  });

  it('leaves a row with no fees alone', async () => {
    const row = await readRow(emptyId);
    expect(row?.fees).toEqual({});
  });

  it('leaves every fee-completeness marker exactly as it found it', async () => {
    // Re-spelling a string is not new fee evidence. Flipping this would claim exact Net P/L for rows whose commissions were never valued, which is the one thing the marker exists to prevent.
    expect((await readRow(exponentialId))?.fees_quote_complete).toBe(true);
    expect((await readRow(plainId))?.fees_quote_complete).toBe(false);
    expect((await readRow(emptyId))?.fees_quote_complete).toBe(false);
  });

  it('leaves fees_quote untouched, since Postgres already normalised that column', async () => {
    // `fees_quote` is `numeric(38,18)`, so it never held an exponent in the first place; touching it here would be a rewrite with no defect behind it.
    expect((await readRow(exponentialId))?.fees_quote).toBe('7.500000000000000000');
  });

  it('leaves a non-object fees body untouched instead of failing the migration', async () => {
    const row = await readRow(arrayFeesId);
    expect(row?.fees).toEqual([]);
  });

  it('leaves a non-string fee member exactly as stored', async () => {
    const row = await readRow(numericMemberId);
    expect(row?.fees).toEqual({ BNB: 5 });
  });

  it('leaves an exponent too large for numeric alone rather than aborting on the cast', async () => {
    // The migration having reached this assertion at all is half the proof: an unbounded pattern would have matched this value, aborted the transaction on `::numeric`, and failed every test in this file at `beforeAll`.
    const row = await readRow(hugeExponentId);
    expect(row?.fees).toEqual({ BNB: '1e-20000' });
  });

  it('accepts a plain fee value written after the migration', async () => {
    const inserted = await pool.query<{ fees: Record<string, string> }>(
      "insert into trade_archive (profile_id, symbol, base_asset, quote_asset, total_buy_quote, total_sell_quote, profit, fees, fees_quote) values ($1, 'ETHUSDT', 'ETH', 'USDT', 10, 11, 1, '{\"USDT\":\"0.00000002\"}', 0) returning fees",
      [profileId],
    );
    expect(inserted.rows[0]?.fees).toEqual({ USDT: '0.00000002' });
  });
});
