import { integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { profiles } from './profiles.js';

// Records that a trade-archive backfill was attempted for a (profile, symbol)
// and what it could reconstruct. A coin with fills but no archive row is
// "missing history"; only by running the backfill do we learn whether that
// history is RECOVERABLE (complete round-trips exist) or not (an open or
// pre-history position with no closed cycle). Without this marker the missing-
// history nudge can't tell "not yet checked" from "checked, nothing to
// recover", so it would nag forever on coins that can never be rebuilt.
//
// `round_trips` is informational (a coin that recovered > 0 has trade_archive
// rows and so leaves the missing set anyway); the counts drive the operator-
// facing reason on the "no recoverable history" note.
export const backfillAttempts = pgTable(
  'backfill_attempts',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    roundTrips: integer('round_trips').notNull(),
    skippedOrphanSells: integer('skipped_orphan_sells').notNull().default(0),
    droppedOvershoot: integer('dropped_overshoot').notNull().default(0),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
    // Null while the coin shows in the "no recoverable history" note; set when
    // the operator hides it, cleared again on un-hide. Server-side per
    // (profile, symbol), so the hidden state persists across devices.
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.profileId, table.symbol] })],
);
