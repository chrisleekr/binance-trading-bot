-- Full backtest signature (strategy + effective config + market + fill model)
-- stamped at create. The create handler matches it against the profile's
-- completed standalone runs to dedup an identical re-run instead of enqueuing a
-- duplicate. Additive and nullable, so every existing row is unchanged (a null
-- signature never matches → those runs always run normally).
alter table backtest_runs add column if not exists backtest_signature text;

create index if not exists backtest_runs_by_profile_signature
  on backtest_runs (profile_id, backtest_signature);
