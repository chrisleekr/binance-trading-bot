-- 0005_hypertables.sql
-- TimescaleDB hypertables: candles, ath_candles, action_logs, tradingview_recommendations.
-- Each create_hypertable() is wrapped with `if_not_exists => true` for idempotency.
--
-- Retention policies:
--   - candles / ath_candles: managed by app-level pruning (out of scope).
--   - action_logs: configured at deploy time via app.action_log_retention_days GUC
--                  (default 7 days); per-profile shorter caps applied by the
--                  action-log-prune cron (apps/worker, phase 06).
--   - tradingview_recommendations: 14 days, fixed.

create table if not exists candles (
  profile_id  uuid not null,
  symbol      text not null,
  interval    text not null,
  time        timestamptz not null,
  open        numeric(38, 18) not null,
  high        numeric(38, 18) not null,
  low         numeric(38, 18) not null,
  close       numeric(38, 18) not null,
  volume      numeric(38, 18) not null,
  primary key (profile_id, symbol, interval, time)
);

select create_hypertable(
  'candles',
  'time',
  chunk_time_interval => interval '1 day',
  if_not_exists => true
);

create table if not exists ath_candles (
  profile_id  uuid not null,
  symbol      text not null,
  interval    text not null,
  time        timestamptz not null,
  open        numeric(38, 18) not null,
  high        numeric(38, 18) not null,
  low         numeric(38, 18) not null,
  close       numeric(38, 18) not null,
  volume      numeric(38, 18) not null,
  primary key (profile_id, symbol, interval, time)
);

select create_hypertable(
  'ath_candles',
  'time',
  chunk_time_interval => interval '7 days',
  if_not_exists => true
);

create table if not exists action_logs (
  time        timestamptz not null,
  profile_id  uuid not null,
  symbol      text,
  level       text not null,
  msg         text not null,
  ctx         jsonb
);

select create_hypertable(
  'action_logs',
  'time',
  chunk_time_interval => interval '1 hour',
  if_not_exists => true
);

create index if not exists action_logs_by_profile_time
  on action_logs (profile_id, time desc);
create index if not exists action_logs_by_profile_symbol_time
  on action_logs (profile_id, symbol, time desc);

-- Default the GUC at the database level; operator can override per-deploy.
do $$
begin
  if not exists (
    select 1 from pg_settings where name = 'app.action_log_retention_days'
  ) then
    -- pg_settings does not list custom GUCs until they are referenced;
    -- alter database guarantees future sessions see the value.
    execute format(
      'alter database %I set app.action_log_retention_days = %L',
      current_database(),
      coalesce(current_setting('app.action_log_retention_days', true), '7')
    );
  end if;
end$$;

-- action_logs retention policy. Wrap so re-runs do not fail.
do $$
declare
  retention_days int;
begin
  retention_days := coalesce(
    nullif(current_setting('app.action_log_retention_days', true), ''),
    '7'
  )::int;
  if not exists (
    select 1 from timescaledb_information.jobs
    where proc_name = 'policy_retention'
      and hypertable_name = 'action_logs'
  ) then
    perform add_retention_policy(
      'action_logs',
      make_interval(days => retention_days),
      if_not_exists => true
    );
  end if;
end$$;

create table if not exists tradingview_recommendations (
  time            timestamptz not null,
  symbol          text not null,
  interval        text not null,
  recommendation  text not null,
  raw             jsonb,
  primary key (time, symbol, interval),
  constraint tradingview_recommendations_recommendation_chk
    check (recommendation in ('STRONG_BUY','BUY','NEUTRAL','SELL','STRONG_SELL'))
);

select create_hypertable(
  'tradingview_recommendations',
  'time',
  chunk_time_interval => interval '1 day',
  if_not_exists => true
);

select add_retention_policy(
  'tradingview_recommendations',
  interval '14 days',
  if_not_exists => true
);
