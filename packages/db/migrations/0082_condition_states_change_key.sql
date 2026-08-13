-- Let a condition record "same reason, moved threshold".
--
-- `recordCondition` compared only `code`, while the tick assembler dedups on a
-- richer identity that also encodes the THRESHOLD the position is waiting on.
-- A threshold that moved under an unchanged reason therefore reached the writer
-- and was dropped: `condition_states.detail` kept the original number for the
-- life of the span, and the diagnosis rendered that stale number as the live
-- exit gate.
--
-- Nullable with no backfill: every producer shipped so far has a code that is
-- its whole identity, and NULL reads as exactly that.

alter table condition_states
  add column if not exists change_key text;
