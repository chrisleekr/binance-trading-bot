-- 0003_identity.sql
-- users + profiles + api_keys + profile_symbols + profile_notifiers.
-- Better Auth tables are managed separately by its drizzle adapter and reference
-- users.id only via FKs.

create table if not exists users (
  id                 uuid primary key default gen_random_uuid(),
  email              citext not null unique,
  display_name       text,
  email_verified_at  timestamptz,
  disabled_at        timestamptz,
  created_at         timestamptz not null default now()
);

create table if not exists profiles (
  id                            uuid primary key default gen_random_uuid(),
  user_id                       uuid not null references users(id) on delete cascade,
  name                          text not null,
  strategy_name                 text not null,
  strategy_version              text not null,
  config                        jsonb not null,
  state                         jsonb not null,
  enabled                       boolean not null default false,
  binance_mode                  text not null,
  action_log_retention_days     integer,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  constraint profiles_binance_mode_chk
    check (binance_mode in ('test', 'live')),
  constraint profiles_action_log_retention_days_chk
    check (action_log_retention_days is null or action_log_retention_days >= 1)
);

create unique index if not exists profiles_user_name_uniq
  on profiles (user_id, name);

create table if not exists api_keys (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles(id) on delete cascade,
  label       text,
  key         text not null,
  secret      text not null,
  last4       text not null,
  created_at  timestamptz not null default now()
);

create unique index if not exists api_keys_profile_uniq
  on api_keys (profile_id);

create table if not exists profile_symbols (
  profile_id       uuid not null references profiles(id) on delete cascade,
  symbol           text not null,
  override_config  jsonb,
  primary key (profile_id, symbol)
);

create table if not exists profile_notifiers (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles(id) on delete cascade,
  provider    text not null,
  config      jsonb not null,
  secrets     jsonb not null default '{}'::jsonb,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now()
);
