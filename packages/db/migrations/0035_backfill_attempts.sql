-- Records that a trade-archive backfill was attempted for a (profile, symbol)
-- and what it could reconstruct. A coin with fills but no archive row is
-- "missing history"; only running the backfill reveals whether that history is
-- RECOVERABLE (complete round-trips exist) or not (an open / pre-history
-- position with no closed cycle). Without this marker the missing-history nudge
-- cannot tell "not yet checked" from "checked, nothing to recover", so it would
-- nag forever on coins that can never be rebuilt. The reconstruct counts drive
-- the operator-facing reason on the "no recoverable history" note.
create table if not exists backfill_attempts (
  profile_id           uuid not null references profiles (id) on delete cascade,
  symbol               text not null,
  round_trips          integer not null,
  skipped_orphan_sells integer not null default 0,
  dropped_overshoot    integer not null default 0,
  attempted_at         timestamptz not null default now(),
  primary key (profile_id, symbol)
);
