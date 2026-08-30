import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { profiles } from './profiles.js';
import { numeric38_18 } from './_types.js';

export const orders = pgTable(
  'orders',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // Orders are account-domain: the Binance order id is unique per account and
    // the user-data stream that reconciles it is per account. CASCADE because an
    // account delete cascades to profiles, and a SET NULL here would then fail.
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // Nullable + SET NULL: deleting a profile DETACHES its orders rather than
    // destroying them. An order that is still resting on Binance must survive its
    // placer, or the only record of a live exchange order disappears with it.
    profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'set null' }),
    symbol: text('symbol').notNull(),
    side: text('side').notNull(),
    intent: text('intent').notNull(),
    binanceOrderId: bigint('binance_order_id', { mode: 'bigint' }).notNull(),
    clientOrderId: text('client_order_id').notNull(),
    // Strategy-owned order metadata (TT: `{ gridTradeIndex }`; momentum:
    // none). Opaque jsonb so the core schema names no strategy concept.
    meta: jsonb('meta'),
    status: text('status').notNull(),
    raw: jsonb('raw').notNull(),
    // Exact application-owned BUY base commission subtracted from the quantity used by cost basis. NULL means no such amount is proven; vendor JSON cannot populate it.
    baseCommissionNetted: numeric38_18('base_commission_netted'),
    // Cost-basis-matched realised P/L of a SELL fill, written once by the
    // fill-adopter from the position's avg entry price at fill time. NULL on
    // BUY rows and on a SELL with no known cost basis (the archiver never
    // fabricates a number for the latter). `cost_basis_quote` is the cost
    // removed from the position (matchedQty × avgEntryPrice); the archive sums
    // these instead of differencing buy/sell cashflow over a time window, so an
    // adopted or boundary-spanning position can no longer inflate profit.
    realizedPnl: numeric('realized_pnl'),
    costBasisQuote: numeric('cost_basis_quote'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [
    check('orders_side_chk', sql`${table.side} in ('BUY','SELL')`),
    // `intent` is an open, strategy-owned string (no CHECK): each strategy
    // names its own intents, so a second strategy's orders are not rejected
    // at insert. Dropping the closed enum also retired the drift class
    // where the CHECK and the contract diverged and crashed the executor.
    uniqueIndex('orders_one_live_per_intent')
      .on(table.profileId, table.symbol, table.intent)
      .where(sql`${table.closedAt} is null`),
    index('orders_history_lookup').on(
      table.profileId,
      table.symbol,
      table.intent,
      table.closedAt.desc(),
    ),
    // Reconciliation seeks by (account, Binance id): the user-data stream, the
    // orphan sweep and the adopt route all key on that pair, and a DETACHED row
    // (profile_id NULL) is only reachable through it.
    index('orders_account_binance_order_id').on(table.accountId, table.binanceOrderId),
  ],
);

export type OrderRow = typeof orders.$inferSelect;
export type OrderInsert = typeof orders.$inferInsert;
