-- A profile can pin one finished backtest run as its baseline, so the dashboard
-- can check whether LIVE trading still matches that backtest's edge profile
-- (scale-invariant win-rate / profit-factor — absolute P&L is not comparable
-- across different capital). FK with ON DELETE SET NULL: deleting the run just
-- clears the pin. The constraint lives here, not in the Drizzle schema, to avoid
-- a profiles <-> backtest_runs import cycle (backtest_runs already references
-- profiles).
alter table profiles add column if not exists baseline_backtest_run_id uuid;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_baseline_backtest_run_fk') then
    alter table profiles
      add constraint profiles_baseline_backtest_run_fk
      foreign key (baseline_backtest_run_id) references backtest_runs(id) on delete set null;
  end if;
end $$;
