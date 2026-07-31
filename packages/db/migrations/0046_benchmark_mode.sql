-- Per-profile equity benchmark. `benchmark_mode` picks what the dashboard's
-- "vs holding" line compares against: 'btc' (the legacy BTC hold) or 'basket'
-- (an equal-weight hold of the profile's own traded symbols — the honest "did I
-- beat the coins I picked, not just BTC" benchmark). Default 'btc' preserves the
-- existing curve for every existing profile.
alter table profiles add column if not exists benchmark_mode text not null default 'btc';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_benchmark_mode_chk') then
    alter table profiles
      add constraint profiles_benchmark_mode_chk check (benchmark_mode in ('btc', 'basket'));
  end if;
end $$;

-- Per-symbol mark prices captured at each snapshot (symbol -> quote-price string),
-- so the basket-hold line is computable at render time from stored data without a
-- running index. null on rows written before this shipped; the basket line simply
-- has no data for those points.
alter table equity_snapshots add column if not exists benchmark_prices jsonb;
