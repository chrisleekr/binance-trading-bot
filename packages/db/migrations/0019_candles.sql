-- 0019_candles.sql
-- Re-introduces a `candles` hypertable, this time GLOBAL (no profile_id).
-- Migration 0009 dropped the original because it was account-scoped yet
-- candle OHLCV is exchange-global market data and had no producer. The
-- backtesting subsystem (#319) needs durable historical candles so a run
-- reads from Postgres instead of re-fetching Binance every time, so the
-- table returns in its correct, global shape.
--
-- Money columns are numeric(38,18); the repo reads/writes them as
-- decimal-strings via the `numeric38_18` custom type so IEEE-754 never
-- touches the price path. Closed candles are immutable, so backfill upserts
-- with `on conflict do nothing` and re-running a range is a no-op.
--
-- No retention policy: backtest history is intentionally long-lived. The
-- operator prunes out-of-band if disk pressure arises.

create table if not exists candles (
  symbol      text not null,
  interval    text not null,
  open_time   timestamptz not null,
  open        numeric(38, 18) not null,
  high        numeric(38, 18) not null,
  low         numeric(38, 18) not null,
  close       numeric(38, 18) not null,
  volume      numeric(38, 18) not null,
  close_time  timestamptz not null,
  primary key (symbol, interval, open_time)
);

select create_hypertable(
  'candles',
  'open_time',
  chunk_time_interval => interval '7 days',
  if_not_exists => true
);
