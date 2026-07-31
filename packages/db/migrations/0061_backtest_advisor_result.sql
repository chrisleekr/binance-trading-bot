-- Durable per-(profile, run, variant) advisor result. A generated config-advisor
-- variant SURVIVES page reload and tab-close, so the operator rehydrates saved
-- suggestions without a fresh (re-billed) model call. The row doubles as the
-- single-flight guard: transitionToRunning does a conditional upsert to `running`
-- and enqueues a background job only when it wins the transition, so a variant
-- already in flight never spawns a duplicate job.
--
-- Scoped by profile_id (the account-isolation key, cascade-deleted with the
-- profile) and cascade-deleted with its backtest_runs row. user_id is stored to
-- tag the owning account per the multi-account data model; it is never a query
-- key here (all reads filter profile_id), so it carries no FK or index — the
-- profile_id cascade already reclaims a deleted user's rows via profiles.
create table if not exists backtest_advisor_result (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  profile_id    uuid not null references profiles (id) on delete cascade,
  run_id        uuid not null references backtest_runs (id) on delete cascade,
  variant       text not null,
  status        text not null,
  summary       text,
  suggestions   jsonb,
  dropped       jsonb,
  error_reason  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint backtest_advisor_result_status_chk check (status in ('running', 'done', 'error')),
  constraint backtest_advisor_result_variant_chk
    check (variant in ('safe', 'ride-trend', 'trade-more', 'aggressive', 'defensive', 'manual'))
);

-- One row per variant per run: the conditional-upsert single-flight guard keys
-- off this, and rehydration lists at most one row per variant.
create unique index if not exists backtest_advisor_result_uq
  on backtest_advisor_result (profile_id, run_id, variant);

-- The rehydration list route reads every variant for a run.
create index if not exists backtest_advisor_result_run_idx
  on backtest_advisor_result (run_id);
