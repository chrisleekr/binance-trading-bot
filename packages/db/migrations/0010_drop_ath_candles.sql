-- 0010_drop_ath_candles.sql
-- Removes the `ath_candles` hypertable. It had no producer and no consumer
-- anywhere in the codebase. If trailing-trade ever adds ATH-restriction buy
-- logic it will choose its own persistence; an empty unwired
-- table is speculative infrastructure (CLAUDE.md anti-pattern).
--
-- `drop table` on a TimescaleDB hypertable drops the hypertable and all its
-- chunks. Wrapped with `if exists` for idempotency.
drop table if exists ath_candles;
