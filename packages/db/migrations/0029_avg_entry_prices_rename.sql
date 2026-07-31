-- Rename last_buy_prices -> avg_entry_prices (and its value column). The stored
-- price is the weighted-average cost basis of the open position, folded over
-- every BUY fill (a VWAP), not the last fill price. The "last buy" name implied
-- last-fill semantics and misled a code review into a non-existent bug, so the
-- table/column are renamed to match what they actually hold.
--
-- Pure rename: no data, row-count, or type change. The primary-key and
-- foreign-key constraints carry the table name, so rename them too to keep the
-- catalog free of the old concept. Constraint names are the Postgres inline
-- defaults from 0004 (<table>_pkey, <table>_<col>_fkey). The runner applies each
-- file once inside a transaction.

alter table last_buy_prices rename to avg_entry_prices;
alter table avg_entry_prices rename column last_buy_price to avg_entry_price;
alter table avg_entry_prices rename constraint last_buy_prices_pkey to avg_entry_prices_pkey;
alter table avg_entry_prices rename constraint last_buy_prices_profile_id_fkey to avg_entry_prices_profile_id_fkey;
