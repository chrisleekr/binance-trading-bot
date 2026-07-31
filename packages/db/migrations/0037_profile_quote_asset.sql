-- Promote the trading quote asset to a first-class per-profile column. It used
-- to live in discovery_config.quoteAsset; it is now the single source of truth
-- for the profile's quote currency (discovery filters on it, and the valuation /
-- order paths read it). NOT NULL with a 'USDT' default so existing rows and any
-- create that omits it land on the prior implicit default.
alter table profiles add column if not exists quote_asset text not null default 'USDT';

-- Backfill from the old discovery_config location so a profile that had a
-- non-USDT quote keeps it. Uppercased and empty-string-guarded to match the
-- suffix discovery compares against; a missing / empty value falls back to USDT.
update profiles
set quote_asset = upper(coalesce(nullif(discovery_config->>'quoteAsset', ''), 'USDT'));
