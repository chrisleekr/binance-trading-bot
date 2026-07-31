-- Commissions Binance charged across the archived cycle, summed per asset.
-- Keyed by commission asset (e.g. BNB, USDT, the base asset) to the total
-- commission paid in that asset, as a decimal string. Sourced from
-- /api/v3/myTrades in the archive handler; `{}` when the account's trade
-- history was unavailable at archive time.
alter table trade_archive add column fees jsonb not null default '{}'::jsonb;
