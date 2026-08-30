// End-to-end pin for ORPHAN-RECOVERY vs DISCOVERY ROTATION, against real Postgres.
//
// Discovery reaps a flat auto-discovered symbol; a buy fill for that symbol can land afterwards (the report was in flight, or the backfiller replays it), and the adopter must re-create the binding or the position would be left untracked. That recovery is correct. What must NOT survive it is an exemption from rotation: once the recovered position is closed and the symbol is flat again, discovery has to be able to reap it exactly as it would any other coin it rotated in.
//
// `profile_symbols.source` is the only thing standing between those two facts, and it carries two meanings at once — WHO bound the symbol, and WHETHER discovery may reap it. Re-subscribing an orphan under the operator-owned value therefore pins the symbol to the profile permanently, and a coin the operator never chose occupies a rotation slot forever.
//
// The suite drives the real `createFillAdopter` through a full buy-then-sell cycle so the binding is created by production code on the production path, then asks discovery's own reap whether it may have the symbol back.

import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Queue } from 'bullmq';

import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { withPostgres, type PostgresFixture } from '@app/testcontainers';
import { createDb, migrate, profileRepo } from '@app/db';
import { trailingTradePositionAdapter } from '@app/strategy-trailing-trade';

import { createFillAdopter } from '../../src/executor/fill-adopter.js';
import { createChainByKey } from '../../src/lib/chain-by-key.js';
import type { StatePort } from '../../src/state/state-port.js';
import type { SymbolInfoCache } from '../../src/tick/symbol-info-cache.js';

import { describeInfra } from './_infra-gate.js';

const OWNER = asUserId('00000000-0000-0000-0000-0000000875a1');
const ACCOUNT = asAccountId('00000000-0000-0000-0000-0000000875c1');
const PROFILE = asProfileId('00000000-0000-0000-0000-0000000875b1');

// The profile settles in USDT (the schema default), so the base asset must be anything else or `upsert`'s self-collision guard would refuse the re-subscribe for an unrelated reason.
const SYMBOL = 'QZXUSDT';
const BASE_ASSET = 'QZX';

// Above 2^32 so a lossy number/bigint hop would surface as a miss, not a pass.
const BUY_ORDER_ID = 8_700_000_875n;
const SELL_ORDER_ID = 8_700_000_876n;

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

describeInfra('db', 'orphan re-subscribe — end-to-end against Postgres', () => {
  let pool: Pool;
  let pgFx: PostgresFixture | undefined;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    pgFx = await withPostgres();
    await migrate({ connectionString: pgFx.databaseUrl, log: () => undefined });
    pool = new Pool({ connectionString: pgFx.databaseUrl });
    db = createDb(pool);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await pgFx?.stop();
  });

  beforeEach(async () => {
    // Start from an empty slice. The worker integration suites run SERIALLY (`--no-file-parallelism`) against one database, and sibling suites already `truncate ... cascade` in their own setup, so a table-wide wipe here is safe. It is also necessary: the reap this suite asks for reads `avg_entry_prices` and `orders`, so a row another suite left behind would answer 'held' for reasons that have nothing to do with the defect under test.
    await pool.query(
      `truncate table api_keys, profile_notifiers, symbol_states, avg_entry_prices,
         profile_symbols, applied_fills, profiles, accounts, users, orders, action_logs
       restart identity cascade`,
    );
    await pool.query(`insert into users (id, email) values ($1, 'op-875@local')`, [OWNER]);
    await pool.query(
      `insert into accounts (id, owner_id, name, binance_mode) values ($1, $2, 'acct-875', 'test')`,
      [ACCOUNT, OWNER],
    );
    await pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
       values ($1, $2, 'prof-875', 'trailing-trade', '1.0.0', '{}'::jsonb, '{}'::jsonb)`,
      [PROFILE, ACCOUNT],
    );
    // Both legs of the cycle, as the placing tick would have recorded them. The adopter's origin gate adopts only fills that match an order THIS profile placed, so without these rows the fills are classified external and nothing at all happens.
    await pool.query(
      `insert into orders (account_id, profile_id, symbol, side, intent, binance_order_id, client_order_id, status, raw)
       values ($1, $2, $3, 'BUY', 'grid-buy', $4, 'cid-875-buy', 'NEW', '{}'::jsonb),
              ($1, $2, $3, 'SELL', 'grid-sell', $5, 'cid-875-sell', 'NEW', '{}'::jsonb)`,
      [ACCOUNT, PROFILE, SYMBOL, BUY_ORDER_ID.toString(), SELL_ORDER_ID.toString()],
    );
    // No `profile_symbols` row: this is the state discovery leaves behind after it reaps a flat auto-discovered symbol, and it is the precondition for the late fill to hit the orphan-recovery path.
  });

  /**
   * The production adopter wired to the real database. Only the DURABLE surfaces matter here — `profile_symbols`, `avg_entry_prices`, `orders` — so the strategy-state boundary is an in-memory map rather than Redis. The mutator still runs against the real trailing-trade position adapter, so a body the plugin cannot fold would still throw.
   */
  const buildAdopter = () => {
    const states = new Map<string, unknown>();
    return createFillAdopter({
      db,
      chain: createChainByKey(),
      logger: noopLogger,
      statePort: {
        mutate: async (_scope: unknown, symbol: string, mutate: (s: unknown) => unknown) => {
          states.set(symbol, mutate(states.get(symbol) ?? { schemaVersion: '2.0.0' }));
        },
      } as unknown as StatePort,
      registry: { get: () => ({ position: trailingTradePositionAdapter }) },
      pipelineQueue: { add: async () => undefined } as unknown as Queue,
      symbolInfo: {
        get: async () => ({
          baseAsset: BASE_ASSET,
          filters: { stepSize: '0.001', minNotional: '10' },
        }),
      } as unknown as SymbolInfoCache,
    });
  };

  const scoped = () => profileRepo(db, OWNER, ACCOUNT, PROFILE);

  const countRows = async (sql: string, params: unknown[]) =>
    (await pool.query(sql, params)).rowCount;

  it('a discovery-reaped symbol re-created by a late fill stays reapable once flat', async () => {
    const adopter = buildAdopter();

    await adopter.adopt({
      operatorId: OWNER,
      accountId: ACCOUNT,
      profileId: PROFILE,
      symbol: SYMBOL,
      orderId: Number(BUY_ORDER_ID),
      tradeId: 8_750_001,
      orderStatus: 'FILLED',
      side: 'BUY',
      cumQty: '2',
      cumQuoteQty: '100',
    });

    // The premise: the late BUY really did recover the binding. Without this the reap below would answer 'not-found' and the test would look like it failed for the defect when it had never reached the defect at all.
    const recovered = await (await scoped()).profileSymbols.findForSymbol(SYMBOL);
    expect(
      recovered,
      'setup failed: the late BUY fill did not re-create the profile_symbols binding',
    ).not.toBeNull();

    await adopter.adopt({
      operatorId: OWNER,
      accountId: ACCOUNT,
      profileId: PROFILE,
      symbol: SYMBOL,
      orderId: Number(SELL_ORDER_ID),
      tradeId: 8_750_002,
      orderStatus: 'FILLED',
      side: 'SELL',
      cumQty: '2',
      cumQuoteQty: '110',
    });

    // The exit really did flatten the symbol, so the reap's own guard (no held quantity, no open order) is satisfied and the only thing left that can refuse is the source column.
    expect(
      await countRows(`select 1 from avg_entry_prices where profile_id = $1 and symbol = $2`, [
        PROFILE,
        SYMBOL,
      ]),
      'setup failed: the closing SELL left a cost-basis row, so the symbol is not flat',
    ).toBe(0);
    expect(
      await countRows(
        `select 1 from orders where profile_id = $1 and symbol = $2 and closed_at is null`,
        [PROFILE, SYMBOL],
      ),
      'setup failed: an order is still open, so the symbol is not flat',
    ).toBe(0);
    expect(
      await (await scoped()).profileSymbols.findForSymbol(SYMBOL),
      'setup failed: the binding vanished before the reap',
    ).not.toBeNull();

    expect(await (await scoped()).profileSymbols.removeUnpinnedIfFlat(SYMBOL)).toBe('removed');
  });
});
