-- Cross-pod dedup key for trade_archive.
--
-- The archive handler reads latestArchivedAt then INSERTs, so under competing
-- consumers two pods can both read the same cutoff and both insert a row for the
-- same completed cycle — duplicating realised PnL in the net-edge scoreboard.
-- `cycle_end` is the cycle's natural key: the max order close time it covers
-- (forward archive) or a round-trip's closing time (backfill), identical across
-- pods archiving the same cycle. A partial unique index makes the second insert
-- a no-op (ON CONFLICT DO NOTHING).
--
-- Nullable + partial (WHERE cycle_end IS NOT NULL) so pre-existing rows (which
-- have no cycle_end) never collide; only new rows, which always stamp it, are
-- deduped. Idempotent guards for a re-run.
alter table trade_archive
  add column if not exists cycle_end timestamptz;

create unique index if not exists trade_archive_cycle_uniq
  on trade_archive (profile_id, symbol, cycle_end)
  where cycle_end is not null;
