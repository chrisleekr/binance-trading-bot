import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { SymbolSource } from '@app/contracts';
import { numeric20_10, numeric38_18 } from './_types.js';
import { profiles } from './profiles.js';

export const tradeArchive = pgTable(
  'trade_archive',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    baseAsset: text('base_asset').notNull(),
    quoteAsset: text('quote_asset').notNull(),
    totalBuyQuote: numeric38_18('total_buy_quote').notNull(),
    totalSellQuote: numeric38_18('total_sell_quote').notNull(),
    profit: numeric38_18('profit').notNull(),
    profitPercent: numeric20_10('profit_percent').notNull(),
    // Strategy-specific quote decomposition, keyed by `"<intent>:<side>"`
    // (TT: `grid-buy:BUY`, `manual:SELL`, ...). Generic so any strategy's
    // intents archive honestly without dedicated columns.
    breakdown: jsonb('breakdown')
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Order summaries archived in this cycle (all sides/intents). Retained
    // for the audit/detail record; the summary numerics above drive the UI.
    orders: jsonb('orders')
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Binance commissions for this cycle, summed per commission asset (key =
    // asset, value = total paid as a decimal string). Sourced from
    // `/api/v3/myTrades`; `{}` when trade history was unavailable at archive
    // time. Retained for audit; `feesQuote` is the quote-valued roll-up the
    // analytics read so they can report P/L net of fees.
    fees: jsonb('fees')
      .notNull()
      .default(sql`'{}'::jsonb`),
    // The cycle's commissions valued in the quote asset (each commission asset
    // converted at archive time: quote 1:1, base at the fill price, others at a
    // ticker lookup). Lets every analytics surface report net P/L
    // (`profit - feesQuote`) and fee drag. Mirrors migration 0043 (documentation
    // only; the hand-written SQL owns the DDL and the best-effort backfill).
    feesQuote: numeric38_18('fees_quote').notNull().default('0'),
    // Source of the symbol when this cycle was archived: `manual` (operator-
    // added) or `auto` (discovery-rotated). Lets the net-edge scoreboard isolate
    // discovery-attributed realized PnL. Defaults `manual` so pre-discovery rows
    // and every non-discovery archive stamp honestly.
    source: text('source').$type<SymbolSource>().notNull().default('manual'),
    archivedAt: timestamp('archived_at', { withTimezone: true }).notNull().defaultNow(),
    // Natural cross-pod dedup key: the cycle's max order close time (forward
    // archive) or a round-trip's closing time (backfill). Two consumers
    // archiving the same completed cycle compute the same value, so the partial
    // unique index below collapses their inserts. Nullable for pre-cycle_end
    // rows; every new insert stamps it. Distinct from `archivedAt`, which is the
    // clock-pinned write time driving the next archive's `since` cutoff.
    //
    // Correctness precondition: a given (profile, symbol) has at most one
    // archivable cycle per millisecond. Holds because grid cycles close
    // sequentially (monotonic close times); the backfill path additionally
    // dedups on the globally-unique closing trade id in-handler, so a distinct
    // round-trip can never collapse onto another.
    cycleEnd: timestamp('cycle_end', { withTimezone: true }),
  },
  (table) => [
    index('trade_archive_profile_symbol_archived').on(
      table.profileId,
      table.symbol,
      table.archivedAt.desc(),
    ),
    // One archive row per (profile, symbol, cycle). Partial so legacy rows with
    // no cycle_end never collide (mirrors migration 0065; the SQL owns the DDL).
    uniqueIndex('trade_archive_cycle_uniq')
      .on(table.profileId, table.symbol, table.cycleEnd)
      .where(sql`${table.cycleEnd} is not null`),
    // Mirrors migration 0040 (documentation only; the hand-written SQL owns the
    // DDL). Serves the discovery net-edge scoreboard's source-scoped aggregate,
    // which filters (profile_id, source, archived_at) with no symbol predicate.
    index('trade_archive_profile_source_archived').on(
      table.profileId,
      table.source,
      table.archivedAt.desc(),
    ),
    check('trade_archive_source_chk', sql`${table.source} in ('manual', 'auto')`),
  ],
);

export type TradeArchiveRow = typeof tradeArchive.$inferSelect;
export type TradeArchiveInsert = typeof tradeArchive.$inferInsert;
