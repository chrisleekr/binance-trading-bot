-- Global singleton holding the operator's scheduled-backup settings. Backup is a
-- whole-database dump, not per-user / per-profile, so exactly one row exists. The
-- `id = 1` CHECK plus a default of 1 make a second row impossible.
--
-- One row is seeded so every read finds it and never has to synthesise defaults.
create table if not exists backup_config (
  id              integer primary key default 1 check (id = 1),
  enabled         boolean not null default false,
  interval_hours  integer not null default 24,
  retention_count integer not null default 14,
  last_backup_at  timestamptz,
  updated_at      timestamptz not null default now()
);

insert into backup_config (id) values (1) on conflict do nothing;
