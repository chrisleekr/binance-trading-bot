-- Record how many of an archived cycle's SELLs had no cost basis.
--
-- `profit` is cost-basis matched: a SELL whose `realized_pnl` is NULL
-- contributes nothing, so the row UNDER-counts rather than fabricating a
-- zero-cost gain. That is the correct arithmetic, but it is indistinguishable
-- from a genuine break-even once written: `profit = 0` renders as "+0.00", and
-- the operator reads a real trade as flat. The count was computed at archive
-- time and only logged; persisting it lets the API and UI say "P/L unavailable"
-- instead of asserting a number nobody measured.
--
-- Defaults 0 so existing rows read as "fully costed". That is not a claim about
-- them, it is the pre-existing assumption the UI already made; a backfill would
-- have to re-derive cost bases that no longer exist.

alter table trade_archive
  add column if not exists missing_cost_basis integer not null default 0;
