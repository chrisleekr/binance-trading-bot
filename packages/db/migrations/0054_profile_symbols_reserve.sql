-- Per-(profile, symbol) reserve: a base-asset quantity the bot must never sell
-- below ("always hold N units of this coin"). The bot trades only the surplus
-- above this floor. Null means no reserve (the default), so every existing row
-- is unchanged and behaviour stays inert until an operator sets one. Stored as a
-- decimal-string in base units; quantity is decimal.js end to end and never an
-- IEEE-754 number.
alter table profile_symbols add column if not exists reserve_base_quantity text;
