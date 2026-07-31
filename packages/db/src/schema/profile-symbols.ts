import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { SymbolSource } from '@app/contracts';
import { profiles } from './profiles.js';

export const profileSymbols = pgTable(
  'profile_symbols',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    // Denormalized base asset (the wallet line `symbol` trades into the quote).
    // Stored so the repo exclusivity guard stays a total pure-SQL backstop: the
    // repo cannot read Binance exchangeInfo, so every bind seam resolves the
    // base and passes it in. One base asset is managed by at most one profile
    // per account, which subsumes the per-symbol check (two quotes, one base).
    baseAsset: text('base_asset').notNull(),
    overrideConfig: jsonb('override_config'),
    // Whether the operator added this symbol (`manual`) or discovery rotated it
    // in (`auto`). Discovery may only reap `auto` rows, and only when flat.
    source: text('source').$type<SymbolSource>().notNull().default('manual'),
    // Last time this symbol was flattened (manual eject or discovery drop).
    // Feeds the discovery re-add hysteresis cooldown (Slice 3, filter 9); null
    // until the first flatten.
    lastFlattenAt: timestamp('last_flatten_at', { withTimezone: true }),
    // Reserve floor in base units (decimal-string): the quantity the bot must
    // never sell below. Null = no reserve. The worker subtracts it from the
    // bot-visible base balance, so the strategy trades only the surplus above it
    // and never sells into it. Strategy-agnostic; see
    // docs/architecture/account-isolation.md.
    reserveBaseQuantity: text('reserve_base_quantity'),
  },
  (table) => [
    primaryKey({ columns: [table.profileId, table.symbol] }),
    check('profile_symbols_source_chk', sql`${table.source} in ('manual', 'auto')`),
  ],
);

export type ProfileSymbolRow = typeof profileSymbols.$inferSelect;
export type ProfileSymbolInsert = typeof profileSymbols.$inferInsert;
