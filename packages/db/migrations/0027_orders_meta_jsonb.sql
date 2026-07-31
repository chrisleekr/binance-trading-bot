-- Move the trailing-trade-specific `current_grid_trade_index` order column
-- into a generic `meta` jsonb so the core orders schema names no strategy
-- concept. A non-grid strategy (e.g. momentum) attaches no metadata; TT keeps
-- writing its level under `meta.gridTradeIndex`.
--
-- Backfill preserves existing TT history (level N -> {"gridTradeIndex": N}),
-- then drops the column. The runner applies each file once inside a
-- transaction; the drop runs after the backfill commits in the same tx.

alter table orders add column meta jsonb;

update orders
  set meta = jsonb_build_object('gridTradeIndex', current_grid_trade_index)
  where current_grid_trade_index is not null;

alter table orders drop column current_grid_trade_index;
