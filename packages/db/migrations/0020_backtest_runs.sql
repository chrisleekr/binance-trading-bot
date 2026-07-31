-- 0020_backtest_runs.sql
-- Durable record of backtest runs for a profile. The source of truth for a
-- run's status/progress/result so it survives worker restarts and UI
-- reconnects where the WS progress stream has rolled past. Account-scoped
-- (carries profile_id, ON DELETE CASCADE) and accessed only through the
-- ProfileScope repo. `params`/`result` are validated at the API boundary, so
-- they are plain jsonb here.

create table backtest_runs (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references profiles(id) on delete cascade,
  symbols      text[] not null,
  params       jsonb not null,
  status       text not null,
  progress     integer not null default 0,
  result       jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  constraint backtest_runs_status_chk check (status in ('queued','running','done','error')),
  constraint backtest_runs_progress_chk check (progress between 0 and 100)
);

create index backtest_runs_by_profile_created on backtest_runs (profile_id, created_at desc);
