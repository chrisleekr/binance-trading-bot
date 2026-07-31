-- Per-profile net-P/L time series. The worker's `equity-snapshot` cron records
-- one row per cadence with the profile's cumulative NET-of-fee profit (realised
-- from the trade archive + unrealised mark-to-market of open positions) and a
-- passive benchmark price, so the live "is the bot beating buy-and-hold?"
-- question has a curve, not just a single point.
--
-- Net P/L, not account NAV: single-account / multi-profile means cash is not
-- partitioned per profile, so an absolute per-profile equity is ill-defined. A
-- profile's net P/L (cost-basis realised + position mark-to-market) IS
-- well-defined and is the honest per-profile scorecard.
create table if not exists equity_snapshots (
  id                    uuid primary key default gen_random_uuid(),
  profile_id            uuid not null references profiles (id) on delete cascade,
  captured_at           timestamptz not null default now(),
  quote_asset           text not null,
  net_pnl_quote         numeric(38, 18) not null,
  realized_net_quote    numeric(38, 18) not null,
  position_value_quote  numeric(38, 18) not null,
  position_cost_quote   numeric(38, 18) not null,
  benchmark_asset       text not null,
  benchmark_price_quote numeric(38, 18) not null
);

-- The series is read newest-first within a time window for one profile.
create index if not exists equity_snapshots_profile_captured
  on equity_snapshots (profile_id, captured_at desc);
