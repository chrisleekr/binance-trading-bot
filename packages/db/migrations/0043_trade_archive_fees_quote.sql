-- Net-of-fee P/L. `profit` is the cost-basis-matched realised P/L BEFORE Binance
-- commissions; the raw per-asset commissions live in the `fees` jsonb but were
-- never valued or subtracted, so every analytics surface showed gross profit.
-- This column holds the cycle's commissions valued in the quote asset, computed
-- at archive time (the only point a BNB->quote price is knowable). Read-time
-- analytics derive net = profit - fees_quote; the raw `fees` jsonb stays for audit.
alter table trade_archive add column if not exists fees_quote numeric(38, 18) not null default 0;

-- Best-effort backfill for rows archived before this column existed: value only
-- the portion of fees already paid in the quote asset (1:1). Commissions paid in
-- BNB or the base asset are left at 0 because their historical price is not
-- recoverable here, so pre-migration rows may under-report fee drag. New rows
-- value every commission asset at archive time.
update trade_archive
set fees_quote = coalesce((fees ->> quote_asset)::numeric, 0)
where fees ? quote_asset and fees_quote = 0;
