-- Live trial progress for a running optimization study: completed/total trials,
-- the best held-out score so far, and an ETA. The optimizer writes it once per
-- trial batch so the detail poll shows movement instead of a binary running/done.
-- Null until the optimizer reports the first batch, so every existing row is
-- unchanged.
alter table backtest_studies add column if not exists progress jsonb;
