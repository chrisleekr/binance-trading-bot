-- Qualitative progress context for a running backtest: phase (backfill / warmup
-- / replay / finalize), replay tick counts, and the symbol currently loading.
-- The numeric percent stays in the `progress` column; this carries the context a
-- fresh page load needs before the first live WS frame arrives. Null until the
-- worker writes it, so every existing row is unchanged.
alter table backtest_runs add column if not exists progress_detail jsonb;
