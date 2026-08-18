-- The archive page (listForProfilePaginated) keysets on `where profile_id = ? and (archived_at, id) < (?, ?)` ordered by `archived_at desc, id desc`. Neither existing index serves that order: both lead (profile_id, symbol, ...) and (profile_id, source, ...), so the second column is unusable here and the planner sorts the profile's whole archive on every page. Cost therefore scales with the archive's total size rather than with `limit`, and past the size where that sort exceeds the route's 5s statement budget the page stops being slow and becomes a 503 on every load — a floor no retry clears.
--
-- Column order matches the page's sort exactly so the scan is an index-ordered read with no sort node, and both keyset columns are in the index so the cursor becomes the scan's start position instead of a per-row filter.
--
-- No CONCURRENTLY: the migration runner wraps each file in a single transaction, which CONCURRENTLY cannot run inside, and the table is small per profile on a single-operator deployment (same reasoning as trade_archive_profile_source_archived).
create index if not exists trade_archive_profile_archived_id
  on trade_archive (profile_id, archived_at desc, id desc);
