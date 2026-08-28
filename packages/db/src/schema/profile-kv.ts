import { jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { profiles } from './profiles.js';

/**
 * Per-profile cross-symbol KV store. A strategy trading several
 * symbols on one profile gets one `tick()` slice per symbol and so cannot read a
 * sibling symbol's state directly; it publishes facts here under a strategy-owned
 * namespaced `key` via `set-kv` / `delete-kv` decisions, and every symbol's later
 * ticks read the merged snapshot back through `TickInput.profileKv`.
 *
 * Keyed on `(profile_id, key)`, NOT per-symbol — that is the whole point. The
 * `value` is JSON-opaque to the worker (stored straight into jsonb, like
 * `symbol_states.state`). Concurrent sibling ticks are last-writer-wins per key.
 */
export const profileKv = pgTable(
  'profile_kv',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.profileId, table.key] })],
);

export type ProfileKvRow = typeof profileKv.$inferSelect;
