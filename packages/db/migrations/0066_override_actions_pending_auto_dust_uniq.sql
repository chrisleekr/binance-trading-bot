-- At most one unconsumed system-triggered dust-transfer per profile.
--
-- The dust-auto-convert cron reads "is one already pending?" then INSERTs, so
-- under competing consumers two pods can both read zero-pending and both queue a
-- dust-transfer override action. The actual conversion is CAS-claimed by the
-- dust-snapshot cron, so this never double-converts real balances, but it does
-- leave a duplicate queued action. This partial unique index makes the enqueue
-- atomic: the second insert collapses on ON CONFLICT DO NOTHING.
--
-- Partial so it constrains ONLY pending auto dust-transfers — manual transfers,
-- other actions, and consumed rows are unaffected. A row becoming consumed
-- (consumed_at set) leaves the predicate, so the next window can queue afresh.
-- Idempotent for a re-run.
create unique index if not exists override_actions_pending_auto_dust_uniq
  on override_actions (profile_id)
  where action = 'dust-transfer' and triggered_by = 'system' and consumed_at is null;
