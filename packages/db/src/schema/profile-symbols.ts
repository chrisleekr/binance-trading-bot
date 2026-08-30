import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
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
    // PROVENANCE only: the operator added this symbol (`manual`), discovery rotated it in (`auto`), or the system re-created the binding to recover a position nobody was tracking (`unknown`). Nothing reads it to decide anything — reap protection is `pinned` below. The split exists because a recovery path could previously protect a binding only by claiming the operator added it, which exempted it from rotation forever.
    source: text('source').$type<SymbolSource>().notNull().default('manual'),
    // Whether discovery is barred from reaping this binding. The reap's DELETE predicate keys on THIS column alone. Defaults false, so a binding created by a recovery path rotates like any other unless someone deliberately pins it.
    pinned: boolean('pinned').notNull().default(false),
    // When the pin was set; null when it was never pinned OR when the pin was backfilled from the pre-split `source='manual'` rows. A backfilled pin has no honest timestamp, so null-on-pinned is the "inferred, not chosen" marker the UI surfaces rather than a missing value to paper over.
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),
    // Last time this symbol was flattened (manual eject or discovery drop).
    // Feeds the discovery re-add hysteresis cooldown (Slice 3, filter 9); null
    // until the first flatten.
    lastFlattenAt: timestamp('last_flatten_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.profileId, table.symbol] }),
    check('profile_symbols_source_chk', sql`${table.source} in ('manual', 'auto', 'unknown')`),
  ],
);

export type ProfileSymbolRow = typeof profileSymbols.$inferSelect;
export type ProfileSymbolInsert = typeof profileSymbols.$inferInsert;
