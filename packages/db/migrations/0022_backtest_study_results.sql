-- Slice-3 rich results summary for an optimization study (#328, epic #325).
-- The optimizer computes per-trial aggregates (Pareto membership + the
-- per-(symbol, window) robustness heatmap) and writes them here when the study
-- completes, so the API/UI render the Pareto front and heatmap without
-- reconstructing aggregates from raw child runs. Validated at the API boundary
-- against @app/contracts OptimizationResults, so it is opaque jsonb here.
alter table backtest_studies add column results jsonb;
