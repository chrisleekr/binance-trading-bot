-- Durable backtest results ledger: a per-profile record of every completed
-- backtest's identity and summary outcome that SURVIVES deletion of the
-- backtest_runs / backtest_studies rows it came from. Powers (a) dedupe of an
-- identical backtest and (b) the optimizer's avoidance of known losers. There is
-- NO foreign key to runs or studies on purpose — a cascade delete of a run or a
-- whole study must never reach this table, so the operator can clear run history
-- without erasing what the optimizer has learned. Upserted on
-- (profile_id, backtest_signature).
create table if not exists backtest_result_ledger (
  id                  uuid primary key default gen_random_uuid(),
  profile_id          uuid not null references profiles (id) on delete cascade,
  backtest_signature  text not null,
  config_fingerprint  text,
  strategy_id         text not null,
  symbols             text[] not null,
  -- "window" is a reserved word (window functions); quote it. Drizzle quotes all
  -- identifiers, so the ORM read/write path needs no special handling.
  "window"            jsonb not null,
  params              jsonb not null,
  outcome             jsonb not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists backtest_result_ledger_sig_uq
  on backtest_result_ledger (profile_id, backtest_signature);

create index if not exists backtest_result_ledger_by_profile_strategy
  on backtest_result_ledger (profile_id, strategy_id);
