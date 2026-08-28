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
const TARGET_PREFIX = 90;
const prefixOf = (name: string): number => Number.parseInt(name.slice(0, 4), 10);

describe.skipIf(!HAS_INFRA)('trade archive fee-completeness migration', () => {
  const dbName = `fee_complete_${randomUUID().replaceAll('-', '')}_test`;
  const userId = randomUUID();
  const accountId = randomUUID();
  const profileId = randomUUID();
  const archiveId = randomUUID();
  const equityId = randomUUID();
  let adminUrl: URL;
  let targetUrl: string;
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

  beforeAll(async () => {
    stageDir = mkdtempSync(join(HERE, '.tmp-fee-complete-mig-'));
    const baseUrl = await sharedDatabaseUrl();
    adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    const target = new URL(baseUrl);
    target.pathname = `/${dbName}`;
    targetUrl = target.toString();
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
      `fee-complete-${userId}@test.local`,
    ]);
    await pool.query(
      "insert into accounts (id, owner_id, name, binance_mode) values ($1, $2, 'account', 'test')",
      [accountId, userId],
    );
    await pool.query(
      "insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state) values ($1, $2, 'profile', 'trailing-trade', '2.0.0', '{}', '{}')",
      [profileId, accountId],
    );
    await pool.query(
      "insert into trade_archive (id, profile_id, symbol, base_asset, quote_asset, total_buy_quote, total_sell_quote, profit, fees, fees_quote) values ($1, $2, 'BTCUSDT', 'BTC', 'USDT', 100, 110, 10, '{\"BNB\":\"0.01\"}', 7.5)",
      [archiveId, profileId],
    );
    await pool.query(
      "insert into equity_snapshots (id, profile_id, quote_asset, net_pnl_quote, realized_net_quote, position_value_quote, position_cost_quote, benchmark_asset, benchmark_price_quote) values ($1, $2, 'USDT', 10, 5, 110, 100, 'BTC', 50000)",
      [equityId, profileId],
    );

    const targetMigration = names.find((name) => prefixOf(name) === TARGET_PREFIX);
    if (!targetMigration) throw new Error('fee-completeness migration not found');
    copyFileSync(join(MIGRATIONS_DIR, targetMigration), join(stageDir, targetMigration));
    await migrate({ connectionString: targetUrl, migrationsDir: stageDir, log: () => undefined });
  });

  afterAll(async () => {
    await pool?.end();
    if (adminUrl) await withAdmin(`drop database if exists "${dbName}" with (force)`);
    if (stageDir) rmSync(stageDir, { recursive: true, force: true });
  });

  it('preserves legacy scalar and raw fee values while marking the row incomplete', async () => {
    const result = await pool.query<{
      fees: Record<string, string>;
      fees_quote: string;
      fees_quote_complete: boolean;
    }>('select fees, fees_quote, fees_quote_complete from trade_archive where id = $1', [
      archiveId,
    ]);
    expect(result.rows[0]).toEqual({
      fees: { BNB: '0.01' },
      fees_quote: '7.500000000000000000',
      fees_quote_complete: false,
    });
  });

  it('accepts a legacy insert that omits the additive marker', async () => {
    const result = await pool.query<{ fees_quote_complete: boolean }>(
      "insert into trade_archive (profile_id, symbol, base_asset, quote_asset, total_buy_quote, total_sell_quote, profit, fees_quote) values ($1, 'ETHUSDT', 'ETH', 'USDT', 10, 11, 1, 0) returning fees_quote_complete",
      [profileId],
    );
    expect(result.rows[0]?.fees_quote_complete).toBe(false);
  });

  it('quarantines legacy equity points from Net charts', async () => {
    const result = await pool.query<{ fees_quote_complete: boolean }>(
      'select fees_quote_complete from equity_snapshots where id = $1',
      [equityId],
    );
    expect(result.rows[0]?.fees_quote_complete).toBe(false);
  });

  it('accepts an old-shape equity insert after migration and keeps it quarantined', async () => {
    const result = await pool.query<{ fees_quote_complete: boolean }>(
      "insert into equity_snapshots (profile_id, quote_asset, net_pnl_quote, realized_net_quote, position_value_quote, position_cost_quote, benchmark_asset, benchmark_price_quote) values ($1, 'USDT', 10, 5, 110, 100, 'BTC', 50000) returning fees_quote_complete",
      [profileId],
    );
    expect(result.rows[0]?.fees_quote_complete).toBe(false);
  });

  it('keeps legacy order inserts compatible without granting cost-basis proof', async () => {
    const result = await pool.query<{ base_commission_netted: string | null }>(
      "insert into orders (account_id, profile_id, symbol, side, intent, binance_order_id, client_order_id, status, raw) values ($1, $2, 'ETHUSDT', 'BUY', 'migration-test', 123, 'migration-test', 'FILLED', '{}') returning base_commission_netted",
      [accountId, profileId],
    );
    expect(result.rows[0]?.base_commission_netted).toBeNull();
  });
});
