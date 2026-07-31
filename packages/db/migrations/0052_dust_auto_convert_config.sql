-- Global singleton holding the operator's automatic dust-to-BNB conversion
-- setting. Dust conversion acts on the whole Binance spot account (balances are
-- account-level, not per-profile), so exactly one row exists. The `id = 1` CHECK
-- plus a default of 1 make a second row impossible.
--
-- One row is seeded so every read finds it and never has to synthesise defaults.
-- Default disabled: the operator must opt in before the bot converts anything.
create table if not exists dust_auto_convert_config (
  id          integer primary key default 1 check (id = 1),
  enabled     boolean not null default false,
  last_run_at timestamptz,
  updated_at  timestamptz not null default now()
);

insert into dust_auto_convert_config (id) values (1) on conflict do nothing;
