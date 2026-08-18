-- Operator-settable log retention, and a stable row identity for action_logs.
--
-- Two changes that have to land together:
--
-- 1. `action_logs` gains an `id`. Without one, a reader paging on `time` alone
--    skips or repeats rows whenever two rows share a timestamp, and the audit
--    drainer bulk-inserts whole batches with near-identical stamps, so
--    collisions are the norm. TimescaleDB requires the partitioning column in
--    any unique index, so identity is the composite (time, id) and the sort /
--    cursor is (time desc, id desc).
--
-- 2. Retention moves out of env vars and the TimescaleDB policy into a
--    singleton the operator edits from the UI. Two owners for one horizon is
--    how the table came to be swept at 7 days while the dashboard reported 30:
--    the Timescale job dropped the chunks first, the cron's DELETE then found
--    nothing, and the footer read "0 pruned (retain 30d)" — indistinguishable
--    from healthy. The Timescale policy is dropped here so the cron is the
--    only deleter.

-- Added in four steps, not as one `add column ... not null default
-- gen_random_uuid()`. A VOLATILE default has to produce a distinct value per
-- row, so Postgres cannot use the fast attribute-only path and rewrites the
-- whole table -- every chunk of the hypertable -- under ACCESS EXCLUSIVE, which
-- blocks the drainer's inserts and every reader for the duration. Backfilling
-- with a plain UPDATE takes only ROW EXCLUSIVE, so writes keep flowing; the
-- closing SET NOT NULL still scans, but scans without rewriting.
alter table action_logs add column if not exists id uuid;
update action_logs set id = gen_random_uuid() where id is null;
alter table action_logs alter column id set default gen_random_uuid();
alter table action_logs alter column id set not null;

-- Composite indexes carrying the tiebreaker, built after the backfill so they
-- index final values. Each supersedes the plain-time index it replaces (same
-- leading columns), so the old ones are redundant.
create unique index if not exists action_logs_by_profile_time_id
  on action_logs (profile_id, time desc, id desc);
create index if not exists action_logs_by_profile_symbol_time_id
  on action_logs (profile_id, symbol, time desc, id desc);
create index if not exists action_logs_by_profile_level_time_id
  on action_logs (profile_id, level, time desc, id desc);

drop index if exists action_logs_by_profile_time;
drop index if exists action_logs_by_profile_symbol_time;

-- Retention now has exactly one owner: the worker's prune crons, reading this
-- row on every run so a UI change applies without a worker restart.
create table if not exists retention_config (
  id                 integer primary key default 1 check (id = 1),
  action_log_days    integer not null default 7 check (action_log_days between 1 and 365),
  audit_log_days     integer not null default 90 check (audit_log_days between 1 and 365),
  -- Redis stream trim length. Bounds how far back the raw per-tick trace
  -- reaches, and with it the drainer's crash-recovery window.
  audit_stream_maxlen integer not null default 100000
    check (audit_stream_maxlen between 1000 and 5000000),
  -- Deep capture: while `debug_capture_until` is in the future, the drainer
  -- persists every tick of `debug_capture_profile_id` at full fidelity instead
  -- of only actionable ones. Null profile / past timestamp = off.
  debug_capture_profile_id uuid,
  debug_capture_until      timestamptz,
  updated_at         timestamptz not null default now()
);

insert into retention_config (id) values (1) on conflict do nothing;

-- Hand retention back to the cron. The policy defaulted to 7 days from a
-- database-level GUC, which silently outranked the env var the UI reported.
do $$
begin
  if exists (
    select 1 from timescaledb_information.jobs
    where proc_name = 'policy_retention' and hypertable_name = 'action_logs'
  ) then
    perform remove_retention_policy('action_logs');
  end if;
end$$;

-- Cleanup only: nothing reads this GUC after the policy above is gone. Wrapped
-- because `alter database ... reset` demands database ownership even when the
-- parameter was never set, and on a managed instance the migration role usually
-- owns the schema but not the database. Unguarded, a 42501 aborts the whole
-- transaction and `retention_config` never gets created, which is the table the
-- prune cron and the worker cache now require.
do $$
begin
  begin
    execute format('alter database %I reset app.action_log_retention_days', current_database());
  exception when insufficient_privilege then
    raise notice 'left app.action_log_retention_days set: role % does not own database %',
      current_user, current_database();
  end;
end$$;

-- The last would-be owner. `profiles.action_log_retention_days` was a per-profile
-- override that no code ever read: the sweep has always been table-wide, so a
-- value here would have promised a horizon nothing enforced. Dropped rather than
-- left dormant, since the whole point of this migration is one owner.
alter table profiles drop constraint if exists profiles_action_log_retention_days_chk;
alter table profiles drop column if exists action_log_retention_days;
