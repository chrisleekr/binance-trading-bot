-- 0006_audit_logs.sql
-- Regular Postgres table; retention enforced by audit-prune cron in apps/worker.

create table if not exists audit_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  actor       text not null,
  event       text not null,
  ip          text,
  user_agent  text,
  payload     jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_logs_by_user_recent
  on audit_logs (user_id, created_at desc);
