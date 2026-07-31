import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { OverrideOutcome } from '@app/contracts';
import { profiles } from './profiles.js';

export const overrideActions = pgTable('override_actions', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  profileId: uuid('profile_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  symbol: text('symbol'),
  action: text('action').notNull(),
  actionAt: timestamp('action_at', { withTimezone: true }).notNull(),
  payload: jsonb('payload').notNull(),
  triggeredBy: text('triggered_by').notNull(),
  // Three-state lifecycle. `processing_at` and `consumed_at` both null =
  // pending; `processing_at` set, `consumed_at` null = claimed/in-flight;
  // `consumed_at` set = done. A consumer with a non-idempotent external
  // side-effect (dust conversion) claims pending->processing before the
  // call: a finalize failure then leaves the row `processing`, so the next
  // tick's claim is refused. Replay is bounded to once — when the stale-
  // processing reaper resets a claim a dead worker abandoned — instead of
  // an every-tick retry storm. The single bounded replay is safe because a
  // re-issued dust conversion of already-converted assets is a Binance
  // no-op.
  processingAt: timestamp('processing_at', { withTimezone: true }),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  // Set once, when a tick takes this override OUT of Redis and before the
  // executor dispatches anything, so a row that outlives its worker still proves
  // a tick owned it. Only its NULL-ness is ever read, and by one consumer: the
  // stranded-row sweep, choosing between "no tick ran inside the window" and "a
  // tick ran and never came back". No other path is GATED on it — it appears in that
  // sweep's WHERE, but nothing branches behaviour on it the way a cancel branches on
  // a claim.
  //
  // Neither of the columns above can hold this fact. `processing_at` is a LEASE,
  // built to be cleared and reused: `releaseClaim` and the stale-claim reaper both
  // null it, and a crashed worker is exactly what invites the reaper — so the
  // evidence would be erased by the same event it was supposed to survive. Written
  // once and cleared by nothing, `picked_up_at` survives it. That still holds now that the
  // tick IS a claiming consumer, because a claim marks work in flight NOW, never that
  // work was once in flight. `consumed_at` is terminal: it would settle the override the
  // tick is still holding.
  //
  // Secondary: `processing_at` is also a guard a cancel reads (it skips a claimed row),
  // which is why the tick holds it only across the dispatch window and releases it
  // before re-arming. Held for the whole tick it would swallow cancellation instead of
  // deferring it.
  pickedUpAt: timestamp('picked_up_at', { withTimezone: true }),
  // Durable payload of a money-path action's SIDE EFFECT (dust-transfer):
  // Binance's convertDust response, written on finalisation. Null until
  // finalised and for every non-dust action. Read by the dust-history API.
  result: jsonb('result'),
  // What the operator actually got, written by every terminal transition.
  // Deliberately NOT `result`: that column is the side-effect payload above, so
  // one shared column would make null mean both "still pending" and "settled,
  // but the payload is not an outcome". Null iff the row is still pending.
  outcome: jsonb('outcome').$type<OverrideOutcome>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type OverrideActionRow = typeof overrideActions.$inferSelect;
export type OverrideActionInsert = typeof overrideActions.$inferInsert;
