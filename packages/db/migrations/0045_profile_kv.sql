-- Per-profile cross-symbol KV store (tracker #267). A strategy trading several
-- symbols on one profile gets one tick() slice per symbol and cannot read a
-- sibling symbol's state directly; it publishes facts here under a strategy-owned
-- namespaced key via set-kv / delete-kv decisions, and every symbol's later ticks
-- read the merged snapshot back through TickInput.profileKv. Keyed on
-- (profile_id, key), NOT per-symbol. The value is JSON-opaque to the worker.
create table if not exists profile_kv (
  profile_id uuid not null references profiles (id) on delete cascade,
  key        text not null,
  value      jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (profile_id, key)
);
