import { integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { profiles } from './profiles.js';

// Per-(profile, symbol) strategy state. Replaces the flat `profiles.state` /
// `profiles.strategy_version` columns: the trailing-trade tick handler
// previously read and wrote ONE blob per profile, so every symbol's tick
// clobbered the others' avgEntryPrice / heldQuantity / currentGridTradeIndex /
// highSinceBuy. The runtime row is the single (profile, symbol) slice the
// strategy operates on; concurrency is already serialised per (profileId,
// symbol) via `chainByKey` so each row mutates without cross-symbol races.
//
// strategy_version is carried per-row (lockstep with `state.schemaVersion`)
// so a profile mid-migration can have heterogeneous slices without losing
// the version stamp on rows the migration has not yet touched. Atomic
// two-column write (`state` + `strategy_version`) lands via the worker's
// `persistSymbolState` path.
//
// `version` is the optimistic-concurrency (CAS) token — a monotonic counter
// distinct from `strategy_version` (a schema-migration stamp). Every durable
// write carries `WHERE version = :expected` and increments it, so under
// competing consumers a stale writer matches zero rows and either retries (the
// fill path) or skips without clobbering (the tick commit). This is what makes
// the read-modify-write cross-pod safe without a lock; chainByKey only
// serialises within one process.
export const symbolStates = pgTable(
  'symbol_states',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    state: jsonb('state').notNull(),
    strategyVersion: text('strategy_version').notNull(),
    version: integer('version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.profileId, table.symbol] })],
);

export type SymbolStateRow = typeof symbolStates.$inferSelect;
export type SymbolStateInsert = typeof symbolStates.$inferInsert;
