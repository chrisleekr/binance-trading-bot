-- Account-global ops notification config. A singleton (id = 1) like
-- backup_config: which account-level operational events (a dead-lettered job)
-- send a notification. `events` is a jsonb toggle map
-- validated by @app/contracts OpsNotifyConfig at the boundary; empty = the
-- contract defaults (every category on). The migration seeds the single row so
-- reads always find it.
create table if not exists ops_notify_config (
  id         integer primary key default 1 check (id = 1),
  events     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into ops_notify_config (id) values (1) on conflict do nothing;
