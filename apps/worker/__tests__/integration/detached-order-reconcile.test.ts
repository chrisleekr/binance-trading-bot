// End-to-end pin for the DETACHED-ORDER lifecycle, against real Postgres.
//
// `orders.profile_id` is ON DELETE SET NULL, so deleting a profile DETACHES its
// orders rather than erasing them (a resting order is real money on Binance).
// The failure this suite exists to prevent: nothing then CLOSES the row when the
// order reaches a terminal state, so it stays `closed_at NULL` forever —
// permanently inflating `countAccountOpenExposure` (which backs the
// delete-account guard, so the account can never be deleted) and sitting
// undetectably in the tracked-live set.
//
// Deleting the LAST profile is exactly how orders get detached, and it also tears
// down the account's only user-data stream — so the stream-driven close can never
// fire for it. The `detached-orders-reconcile` cron is driven off the ORDERS
// TABLE for that reason, and this suite runs it with zero profiles left on the
// account to prove that path actually settles the ledger.
//
// The other half of the contract is what must NOT happen: the order is closed as
// a LEDGER record only. No cost basis, no strategy state, no re-subscription —
// there is no profile left to adopt a position into.

import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Queue } from 'bullmq';

import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { withPostgres, type PostgresFixture } from '@app/testcontainers';
import { accountRepo, createDb, migrate, projections, repo, scopeAccount } from '@app/db';

import { createFillAdopter } from '../../src/executor/fill-adopter.js';
import { createChainByKey } from '../../src/lib/chain-by-key.js';
import { detachedOrdersReconcileHandler } from '../../src/crons/detached-orders-reconcile.cron.js';
import type { StatePort } from '../../src/state/state-port.js';
import type { SymbolInfoCache } from '../../src/tick/symbol-info-cache.js';

import { describeInfra } from './_infra-gate.js';

const OWNER = asUserId('00000000-0000-0000-0000-0000000605a1');
const ACCOUNT = asAccountId('00000000-0000-0000-0000-0000000605c1');
const PROFILE = asProfileId('00000000-0000-0000-0000-0000000605b1');

// Above 2^32 so a lossy number/bigint hop would surface as a miss, not a pass.
const DETACHED_ORDER_ID = 8_600_000_605n;
const SYMBOL = 'XPLUSDT';

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

/**
 * The production adopter, wired to the real database. `reconcileDetachedFill`
 * touches only `db` + `logger` by design — it is the ledger half of adoption with
 * the strategy half deliberately absent — so the position-side deps are stubs
 * that would THROW if the detached path ever reached for them. That is the point:
 * a regression that starts seeding cost basis or strategy state here fails loudly
 * instead of silently handing a deleted profile's position to a stranger.
 */
const buildAdopter = (db: ReturnType<typeof createDb>) =>
  createFillAdopter({
    db,
    chain: createChainByKey(),
    logger: noopLogger,
    statePort: {
      mutate: () => {
        throw new Error('detached reconcile must not touch strategy state');
      },
    } as unknown as StatePort,
    registry: {
      get: () => {
        throw new Error('detached reconcile must not resolve a strategy');
      },
    },
    pipelineQueue: {
      add: () => {
        throw new Error('detached reconcile must not enqueue an archive');
      },
    } as unknown as Queue,
    symbolInfo: {
      get: () => {
        throw new Error('detached reconcile must not read symbol info');
      },
    } as unknown as SymbolInfoCache,
  });

describeInfra('db', 'detached-order reconcile — end-to-end against Postgres', () => {
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
    // The container stop runs even when the pool refuses to close. This suite only gained a container to strand when it moved off a supplied DATABASE_TEST_URL, and a rejected `pool.end()` would otherwise return from the hook with it still up.
    try {
      await pool?.end();
    } finally {
      await pgFx?.stop();
    }
  });

  beforeEach(async () => {
    // Start from an empty slice. The worker integration suites run SERIALLY
    // (`--no-file-parallelism`) against one database — sibling suites such as
    // resolve-profile / multi-symbol-state-isolation already `truncate ... cascade`
    // in their own setup, so the files cannot safely share the DB concurrently and
    // never do. A table-wide wipe here is therefore safe, and it is also necessary:
    // this suite's assertions that the reconcile path leaves the side tables empty
    // (symbol_states, avg_entry_prices, profile_symbols) would otherwise trip over
    // rows a prior suite left behind.
    await pool.query(
      `truncate table api_keys, profile_notifiers, symbol_states, avg_entry_prices,
         profile_symbols, profiles, accounts, users, orders, action_logs
       restart identity cascade`,
    );
    await pool.query(`insert into users (id, email) values ($1, 'op-605@local')`, [OWNER]);
    await pool.query(
      `insert into accounts (id, owner_id, name, binance_mode) values ($1, $2, 'acct-605', 'test')`,
      [ACCOUNT, OWNER],
    );
    await pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
       values ($1, $2, 'prof-605', 'trailing-trade', '1.0.0', '{}'::jsonb, '{}'::jsonb)`,
      [PROFILE, ACCOUNT],
    );
    await pool.query(
      `insert into api_keys (account_id, key, secret, last4) values ($1, 'pk', 'sk', '1234')`,
      [ACCOUNT],
    );
    // A resting SELL (a protective stop) the profile placed and never closed.
    await pool.query(
      `insert into orders (account_id, profile_id, symbol, side, intent, binance_order_id, client_order_id, status, raw)
       values ($1, $2, $3, 'SELL', 'stop-loss', $4, 'cid-605', 'NEW', '{}'::jsonb)`,
      [ACCOUNT, PROFILE, SYMBOL, DETACHED_ORDER_ID.toString()],
    );
    // Delete the account's ONLY profile. The order detaches instead of cascading,
    // and the account is left with no profile — hence no user-data stream.
    await pool.query(`delete from profiles where id = $1`, [PROFILE]);
  });

  const exposure = async () =>
    projections.countAccountOpenExposure(await scopeAccount(db, OWNER, ACCOUNT));

  it('a deleted profile detaches its resting order, which then blocks the account delete forever', async () => {
    // The premise the rest of the suite rests on: the row SURVIVES the profile,
    // and it counts. That is correct while the order is genuinely resting — but it
    // is also a trap the account can never escape if nothing ever closes it.
    const detached = await repo.orders.listLiveDetached(db);
    expect(detached).toHaveLength(1);
    expect(detached[0]).toMatchObject({
      binanceOrderId: DETACHED_ORDER_ID,
      accountId: ACCOUNT,
      operatorId: OWNER,
      symbol: SYMBOL,
    });
    expect(await exposure()).toEqual({ openOrderCount: 1, openPositionCount: 0 });
  });

  it('closes the row when the exchange says the detached order FILLED, with no profile left on the account', async () => {
    const adopter = buildAdopter(db);
    const getOrder = vi.fn(async () => ({
      status: 'FILLED',
      executedQty: '3',
      cummulativeQuoteQty: '150',
      updateTime: 1_700_000_000_000,
    }));

    await detachedOrdersReconcileHandler({
      logger: noopLogger,
      listLiveDetached: () => repo.orders.listLiveDetached(db),
      // The account still holds its own key pair — accounts outlive their
      // profiles, which is the whole reason a zero-profile account is reachable.
      resolveBinance: async () => ({ getOrder }) as never,
      reconcileDetachedFill: adopter.reconcileDetachedFill,
      nowMs: () => 1_700_000_000_000,
    })({} as never);

    expect(getOrder).toHaveBeenCalledWith({ symbol: SYMBOL, orderId: Number(DETACHED_ORDER_ID) });

    // The ledger settled: closed, off the live set, and the account's phantom
    // exposure is gone — the operator can finally delete it.
    const [row] = (
      await pool.query(`select status, closed_at, raw from orders where binance_order_id = $1`, [
        DETACHED_ORDER_ID.toString(),
      ])
    ).rows;
    expect(row.status).toBe('FILLED');
    expect(row.closed_at).not.toBeNull();
    // The exchange's true totals, so the row is honest about what actually traded.
    expect(row.raw).toMatchObject({ executedQty: '3', cummulativeQuoteQty: '150' });

    expect(await repo.orders.listLiveDetached(db)).toHaveLength(0);
    expect(await repo.orders.listLiveBinanceOrderIdsByAccount(db)).toHaveLength(0);
    expect(await exposure()).toEqual({ openOrderCount: 0, openPositionCount: 0 });

    // The half that must NOT happen: no position was invented for anyone. (The
    // adopter's strategy-side deps throw, so reaching for them would already have
    // failed the run — this pins the durable outcome as well.)
    expect((await pool.query(`select 1 from avg_entry_prices`)).rowCount).toBe(0);
    expect((await pool.query(`select 1 from symbol_states`)).rowCount).toBe(0);
    expect((await pool.query(`select 1 from profile_symbols`)).rowCount).toBe(0);
  });

  it('closes the row on a non-fill terminal status (cancelled by hand on Binance)', async () => {
    const adopter = buildAdopter(db);
    await detachedOrdersReconcileHandler({
      logger: noopLogger,
      listLiveDetached: () => repo.orders.listLiveDetached(db),
      resolveBinance: async () =>
        ({
          getOrder: async () => ({
            status: 'CANCELED',
            executedQty: '0',
            cummulativeQuoteQty: '0',
            updateTime: 1_700_000_000_000,
          }),
        }) as never,
      reconcileDetachedFill: adopter.reconcileDetachedFill,
      nowMs: () => 1_700_000_000_000,
    })({} as never);

    const [row] = (
      await pool.query(`select status, closed_at from orders where binance_order_id = $1`, [
        DETACHED_ORDER_ID.toString(),
      ])
    ).rows;
    expect(row.status).toBe('CANCELED');
    expect(row.closed_at).not.toBeNull();
    expect(await exposure()).toEqual({ openOrderCount: 0, openPositionCount: 0 });
  });

  it('leaves a still-RESTING detached order open — that exposure is real and the guard should keep refusing', async () => {
    const adopter = buildAdopter(db);
    await detachedOrdersReconcileHandler({
      logger: noopLogger,
      listLiveDetached: () => repo.orders.listLiveDetached(db),
      resolveBinance: async () =>
        ({
          getOrder: async () => ({
            status: 'NEW',
            executedQty: '0',
            cummulativeQuoteQty: '0',
            updateTime: 1_700_000_000_000,
          }),
        }) as never,
      reconcileDetachedFill: adopter.reconcileDetachedFill,
      nowMs: () => 1_700_000_000_000,
    })({} as never);

    expect(await exposure()).toEqual({ openOrderCount: 1, openPositionCount: 0 });
    expect(await repo.orders.listLiveDetached(db)).toHaveLength(1);
  });

  it('is idempotent: a re-run (or the same report fanned out to N profiles) closes once and does not reopen', async () => {
    const adopter = buildAdopter(db);
    const event = {
      operatorId: OWNER,
      accountId: ACCOUNT,
      symbol: SYMBOL,
      orderId: Number(DETACHED_ORDER_ID),
      orderStatus: 'FILLED',
      cumQty: '3',
      cumQuoteQty: '150',
      eventTimeMs: 1_700_000_000_000,
    };
    await adopter.reconcileDetachedFill(event);
    const firstClosedAt = (
      await pool.query(`select closed_at from orders where binance_order_id = $1`, [
        DETACHED_ORDER_ID.toString(),
      ])
    ).rows[0].closed_at;

    // A second delivery must not re-stamp the close (the status guard makes it a
    // no-op), so the ledger keeps the moment the order actually settled.
    await adopter.reconcileDetachedFill(event);
    const secondClosedAt = (
      await pool.query(`select closed_at from orders where binance_order_id = $1`, [
        DETACHED_ORDER_ID.toString(),
      ])
    ).rows[0].closed_at;

    expect(secondClosedAt).toEqual(firstClosedAt);
    expect(await exposure()).toEqual({ openOrderCount: 0, openPositionCount: 0 });
  });

  it('refuses to touch a row that still has an owning profile — that is adopt()’s job, not this one', async () => {
    // Re-attach the order to a live profile: `reconcileDetachedFill` must leave it
    // alone, or it would close a profile-owned order behind the strategy's back
    // (and without the cost-basis stamp adopt() owes it).
    await pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
       values ($1, $2, 'prof-605-b', 'trailing-trade', '1.0.0', '{}'::jsonb, '{}'::jsonb)`,
      [PROFILE, ACCOUNT],
    );
    await pool.query(`update orders set profile_id = $1 where binance_order_id = $2`, [
      PROFILE,
      DETACHED_ORDER_ID.toString(),
    ]);

    await buildAdopter(db).reconcileDetachedFill({
      operatorId: OWNER,
      accountId: ACCOUNT,
      symbol: SYMBOL,
      orderId: Number(DETACHED_ORDER_ID),
      orderStatus: 'FILLED',
      cumQty: '3',
      cumQuoteQty: '150',
      eventTimeMs: 1_700_000_000_000,
    });

    const [row] = (
      await pool.query(`select status, closed_at from orders where binance_order_id = $1`, [
        DETACHED_ORDER_ID.toString(),
      ])
    ).rows;
    expect(row.status).toBe('NEW');
    expect(row.closed_at).toBeNull();
    // And it is not in the detached set at all, so the cron never sees it.
    expect(await repo.orders.listLiveDetached(db)).toHaveLength(0);
    // The account-scoped ownership proof still resolves; nothing was corrupted.
    expect((await accountRepo(db, OWNER, ACCOUNT)).scope.accountId).toBe(ACCOUNT);
  });
});
