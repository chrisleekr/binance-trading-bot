-- Shorter action-log horizon, plus a per-profile row cap.
--
-- Both halves are only safe together with `condition_states` (0077). Current
-- state used to be readable only as the newest transition row in `action_logs`,
-- so a symbol stuck on one reason for weeks had a single row, written weeks ago,
-- and any aggressive sweep deleted the only evidence of the longest-running
-- problem. State now lives in its own keyed table with its own `since`, so the
-- log can go back to being what it is: a prunable history of edges.

alter table retention_config
  add column if not exists action_log_max_rows integer not null default 200000;

-- A separate statement so re-running the migration against a database that
-- already has the column still installs the bound.
alter table retention_config
  drop constraint if exists retention_config_action_log_max_rows_check;
alter table retention_config
  add constraint retention_config_action_log_max_rows_check
  check (action_log_max_rows between 1000 and 10000000);

alter table retention_config alter column action_log_days set default 1;

-- The default on the column governs no existing row, so the live singleton is
-- moved explicitly. Guarded on the old default so any other horizon survives,
-- which is a weaker promise than it looks: 0076 seeded the row at 7, so a
-- deliberate 7 is indistinguishable from an untouched one and gets moved too.
-- Accepted rather than solved (0076 records no "operator has edited this" bit,
-- and nothing is deployed yet to lose a setting); noted so a later reader does
-- not mistake the guard for full protection.
update retention_config set action_log_days = 1, updated_at = now()
  where id = 1 and action_log_days = 7;
