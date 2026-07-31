-- 0009_drop_candles.sql
-- Removes the `candles` hypertable. Candle OHLCV is exchange-global market
-- data, not account-scoped state, and was never written by any producer.
-- The chart endpoint now reads candles live from Binance's public klines
-- REST endpoint, so no persisted table is needed.
--
-- `drop table` on a TimescaleDB hypertable drops the hypertable and all its
-- chunks. Wrapped with `if exists` for idempotency, matching the other
-- migrations in this directory.
drop table if exists candles;
