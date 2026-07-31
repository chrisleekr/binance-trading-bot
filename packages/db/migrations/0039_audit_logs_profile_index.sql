-- audit_logs is a plain Postgres table (not a hypertable). listForProfile and
-- listAllForProfile filter `where user_id = $1 and payload->>'profileId' = $2`
-- and order by (created_at, id). The existing audit_logs_by_user_recent index
-- only covers (user_id, created_at desc), and under single-user user_id is
-- non-selective, so the planner walks the user's whole audit history newest-first
-- and extracts payload->>'profileId' per row until the LIMIT fills (and the
-- unbounded NDJSON export scans the full window).
--
-- The trailing (created_at desc, id desc) matches both the ORDER BY and the
-- keyset cursor predicate (created_at, id), so the profile-scoped reads seek
-- straight to the profile's rows in final sort order — no per-row JSONB
-- extraction and no sort step. listAllForProfile orders ascending and is served
-- by a backward index scan. user_id-leading matches the repo's account-scoped
-- index convention and the multi-account future. No CONCURRENTLY: single-user,
-- small prune-bounded table, and the migration runner wraps each file in a
-- transaction.
create index if not exists audit_logs_by_user_profile_recent
  on audit_logs (user_id, (payload->>'profileId'), created_at desc, id desc);
