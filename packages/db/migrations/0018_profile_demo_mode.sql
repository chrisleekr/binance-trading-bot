-- Promote demoMode to a first-class profiles column.
-- It previously lived only in the profiles.state JSON blob, which no
-- writer touches per-profile after the per-symbol state cutover, leaving
-- the executor's demo-mode gate permanently false (an orphaned read).
alter table profiles
  add column if not exists demo_mode boolean not null default false;
