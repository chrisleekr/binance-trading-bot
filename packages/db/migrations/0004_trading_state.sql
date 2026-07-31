-- 0004_trading_state.sql
-- Trading-state regular tables: grid_trades, orders, manual_orders, last_buy_prices,
-- trade_archive, override_actions, profile_state_history, simulated_orders.

create table if not exists grid_trades (
  id             uuid primary key default gen_random_uuid(),
  profile_id     uuid not null references profiles(id) on delete cascade,
  symbol         text not null,
  buy_grid       jsonb not null,
  sell_grid      jsonb not null,
  stop_loss      jsonb,
  manual_trades  jsonb not null default '[]'::jsonb,
  updated_at     timestamptz not null default now()
);

create unique index if not exists grid_trades_profile_symbol_uniq
  on grid_trades (profile_id, symbol);

create table if not exists orders (
  id                        uuid primary key default gen_random_uuid(),
  profile_id                uuid not null references profiles(id) on delete cascade,
  symbol                    text not null,
  side                      text not null,
  intent                    text not null,
  binance_order_id          bigint not null,
  client_order_id           text not null,
  current_grid_trade_index  integer,
  status                    text not null,
  raw                       jsonb not null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  closed_at                 timestamptz,
  constraint orders_side_chk check (side in ('BUY','SELL')),
  constraint orders_intent_chk
    check (intent in ('grid-buy','grid-sell','grid-stop-loss','manual'))
);

-- Partial unique index: at most one *live* (closed_at is null) row per (profile, symbol, intent).
-- See https://www.postgresql.org/docs/17/indexes-partial.html
create unique index if not exists orders_one_live_per_intent
  on orders (profile_id, symbol, intent)
  where closed_at is null;

create index if not exists orders_history_lookup
  on orders (profile_id, symbol, intent, closed_at desc);

create table if not exists manual_orders (
  id                uuid primary key default gen_random_uuid(),
  profile_id        uuid not null references profiles(id) on delete cascade,
  symbol            text not null,
  binance_order_id  bigint not null,
  raw               jsonb not null,
  status            text not null,
  created_at        timestamptz not null default now()
);

create unique index if not exists manual_orders_profile_binance_uniq
  on manual_orders (profile_id, binance_order_id);

create table if not exists last_buy_prices (
  profile_id     uuid not null references profiles(id) on delete cascade,
  symbol         text not null,
  last_buy_price numeric(38, 18) not null,
  quantity       numeric(38, 18) not null,
  updated_at     timestamptz not null default now(),
  primary key (profile_id, symbol)
);

create table if not exists trade_archive (
  id                 uuid primary key default gen_random_uuid(),
  profile_id         uuid not null references profiles(id) on delete cascade,
  symbol             text not null,
  base_asset         text not null,
  quote_asset        text not null,
  total_buy_quote    numeric(38, 18) not null,
  total_sell_quote   numeric(38, 18) not null,
  buy_grid_quote     numeric(38, 18) not null,
  buy_manual_quote   numeric(38, 18) not null,
  sell_grid_quote    numeric(38, 18) not null,
  sell_manual_quote  numeric(38, 18) not null,
  stop_loss_quote    numeric(38, 18) not null default 0,
  profit             numeric(38, 18) not null,
  profit_percent     numeric(20, 10) not null,
  buy                jsonb not null,
  sell               jsonb not null,
  stop_loss          jsonb,
  manual_trade       jsonb not null default '[]'::jsonb,
  archived_at        timestamptz not null default now()
);

create index if not exists trade_archive_profile_symbol_archived
  on trade_archive (profile_id, symbol, archived_at desc);

create table if not exists override_actions (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references profiles(id) on delete cascade,
  symbol        text,
  action        text not null,
  action_at     timestamptz not null,
  payload       jsonb not null,
  triggered_by  text not null,
  consumed_at   timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists profile_state_history (
  id                uuid primary key default gen_random_uuid(),
  profile_id        uuid not null references profiles(id) on delete cascade,
  strategy_name     text not null,
  strategy_version  text not null,
  state             jsonb not null,
  archived_at       timestamptz not null default now()
);

create index if not exists profile_state_history_profile_archived
  on profile_state_history (profile_id, archived_at desc);

create table if not exists simulated_orders (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid not null references profiles(id) on delete cascade,
  symbol          text not null,
  intent          text not null,
  side            text not null,
  requested_at    timestamptz not null,
  requested_price numeric(38, 18),
  filled_at       timestamptz,
  filled_price    numeric(38, 18),
  quantity        numeric(38, 18) not null,
  raw_request     jsonb not null,
  raw_simulated   jsonb not null
);
