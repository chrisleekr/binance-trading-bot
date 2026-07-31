-- Denormalize the base asset onto profile_symbols so the repo's symbol-
-- exclusivity guard can key on the shared wallet line (the base asset) without
-- reading Binance exchangeInfo, which the repo cannot do. The base asset, not
-- the symbol, is the unit of exclusivity: BTCUSDT and BTCFDUSD are two symbols
-- over one BTC balance, so a single owner per account protects sizing/stops.

-- Add NULLABLE first so the backfill can run before the NOT NULL constraint.
alter table profile_symbols add column if not exists base_asset text;

-- Backfill by stripping the owning profile's quote_asset suffix from the symbol.
-- All current rows are USDT-quote (base<->symbol is 1:1 today), so the suffix
-- strip is total. Uppercased to match the canonical asset casing. The suffix is
-- matched with right()=, not like, so a quote_asset carrying a % or _ cannot
-- widen the match; the length() guard leaves a symbol that is only the quote
-- (no base prefix) unresolved so it trips the not-null check below.
update profile_symbols ps
set base_asset = upper(left(ps.symbol, length(ps.symbol) - length(p.quote_asset)))
from profiles p
where p.id = ps.profile_id
  and right(ps.symbol, length(p.quote_asset)) = p.quote_asset
  and length(ps.symbol) > length(p.quote_asset);

-- Fail loud on any row the backfill could not resolve (a symbol that does not
-- end in its profile's quote asset, or is only the quote with no base), rather
-- than silently carrying a null or an empty base.
alter table profile_symbols alter column base_asset set not null;
