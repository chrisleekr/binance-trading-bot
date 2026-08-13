import { jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { profiles } from './profiles.js';

/**
 * One row per currently-open condition ("entry blocked by knife-guard since
 * Tuesday"). The counterpart to `action_logs`: that table is an append-only
 * stream of state CHANGES, this one is the mutable current state.
 *
 * Both are needed because they answer different questions and have opposite
 * lifetimes. History is meant to be pruned; current state must not be, or the
 * longest-running problem becomes the one with no surviving evidence. `since`
 * lives here precisely so a duration stays exact after its opening log row has
 * been swept.
 *
 * This cannot live in `action_logs`: that is a TimescaleDB hypertable, and a
 * unique index on a hypertable must contain the partitioning column, so a key of
 * `(profileId, condition, symbol)` is not expressible there at all.
 */
export const conditionStates = pgTable(
  'condition_states',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    /** Which named condition. `text` so a new producer needs no migration. */
    condition: text('condition').notNull(),
    /**
     * Subject within the profile; `''` means the profile itself rather than one
     * symbol. A sentinel instead of NULL because Postgres forbids nullable
     * primary-key columns, and partial unique indexes would split one upsert
     * into two code paths.
     */
    symbol: text('symbol').notNull().default(''),
    /** The specific reason within the condition, e.g. `knife-guard`. */
    code: text('code').notNull(),
    /**
     * The producer's full identity for this state, e.g. the code plus the
     * threshold it is waiting on. Persisted so "same reason, moved level" is
     * still detectable after a restart, when the in-process dedup cache is gone.
     * NULL means the code is the whole identity, which is what a producer with
     * no volatile threshold wants.
     */
    changeKey: text('change_key'),
    /** The producer's own structured payload, stored opaque. */
    detail: jsonb('detail'),
    /** When this `(condition, code)` began. Independent of log retention. */
    since: timestamp('since', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.profileId, table.condition, table.symbol] })],
);

export type ConditionStateRow = typeof conditionStates.$inferSelect;
