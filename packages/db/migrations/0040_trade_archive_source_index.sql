-- The discovery net-edge scoreboard (sumProfitInRangeForSource) aggregates
-- realized PnL + win rate over `where profile_id = ? and source = ? and
-- archived_at in [from, to)` with NO symbol predicate. The existing
-- trade_archive_profile_symbol_archived index leads (profile_id, symbol, ...),
-- so the planner can use only its profile_id prefix and then residual-filters
-- source + archived_at over the whole profile partition. The route runs this
-- twice per discovery-dashboard poll (all-time + 7d window).
--
-- This composite lets both aggregates seek (profile_id, source) and range-scan
-- archived_at. trade_archive is small per profile today, so the win is modest
-- now and grows with auto-archive history. No CONCURRENTLY: small table,
-- single-user, and the migration runner wraps each file in a transaction.
create index if not exists trade_archive_profile_source_archived
  on trade_archive (profile_id, source, archived_at desc);
