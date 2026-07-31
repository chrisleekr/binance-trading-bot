-- Remove the Optuna config-optimizer.
--
-- The auto-optimize subsystem (optimization campaigns, studies, and per-trial
-- backtest runs) is gone. Plain backtesting and the LLM advisor stay; only the
-- optimizer tables and the trial discriminator on backtest_runs are dropped.
-- `backtest_runs.study_id` was the FK marking a run as a study trial; with no
-- studies it is dead, so drop it (and its index) so every run is a standalone
-- backtest. Drop the child (backtest_studies, which carries campaign_id) before
-- the parent (optimization_campaigns).
--
-- Idempotent: safe to re-run. Greenfield/not-deployed, so no data migration.
drop index if exists backtest_runs_by_study;

alter table backtest_runs
  drop column if exists study_id;

drop table if exists backtest_studies;

drop table if exists optimization_campaigns;
