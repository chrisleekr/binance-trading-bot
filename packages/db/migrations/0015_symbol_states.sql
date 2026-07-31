-- 0015_symbol_states.sql
-- Foundation slice of #267: add `symbol_states` table for per-(profile, symbol)
-- strategy state. The flat `profiles.state` / `profiles.strategy_version`
-- columns are intentionally NOT dropped in this migration — the worker still
-- reads/writes them. The follow-up cutover migration (planned 0016) drops
-- those columns once tick-handler, fill-adopter, boot reconcilers, and the
-- TT plugin's v2.0.0 reset migration have all moved over.
--
-- See tracker #267 for the multi-symbol refactor rationale: the flat blob
-- caused every symbol's tick to clobber other symbols' lastBuyPrice /
-- heldQuantity / currentGridTradeIndex / highSinceBuy. The home dashboard
-- PnL divergence (-0.42 vs -3,083.46 on the same SOL position) was the
-- visible symptom.

create table symbol_states (
  profile_id uuid not null references profiles(id) on delete cascade,
  symbol text not null,
  state jsonb not null,
  strategy_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (profile_id, symbol)
);

create index symbol_states_profile_idx on symbol_states (profile_id);
