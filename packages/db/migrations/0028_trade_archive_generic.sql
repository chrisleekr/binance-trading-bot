-- Make trade_archive strategy-agnostic. The five trailing-trade-specific
-- quote columns (buy_grid/buy_manual/sell_grid/sell_manual/stop_loss) and the
-- four per-intent jsonb order arrays (buy/sell/stop_loss/manual_trade)
-- assumed TT's grid+manual decomposition, so a strategy without that split
-- (e.g. momentum's entry/exit) could not be archived honestly.
--
-- New shape: keep the generic numerics (total_buy_quote, total_sell_quote,
-- profit, profit_percent) and add:
--   breakdown jsonb  - quote summed per "<intent>:<side>" pair
--   orders    jsonb  - all archived order summaries (audit/detail record)
--
-- Backfill maps the old TT columns into breakdown keys so existing history
-- keeps its split, and concatenates the old per-intent arrays into `orders`.
-- The runner applies each file once inside a transaction; the drops run after
-- the backfill commits in the same tx.

alter table trade_archive add column breakdown jsonb not null default '{}'::jsonb;
alter table trade_archive add column orders jsonb not null default '[]'::jsonb;

-- breakdown: only emit keys whose quote is non-zero so a row carries just the
-- intents it actually used (a fresh momentum archive would carry entry/exit).
update trade_archive set breakdown = (
  select coalesce(jsonb_object_agg(key, val), '{}'::jsonb)
  from (
    values
      ('grid-buy:BUY', buy_grid_quote),
      ('manual:BUY', buy_manual_quote),
      ('grid-sell:SELL', sell_grid_quote),
      ('manual:SELL', sell_manual_quote),
      ('grid-stop-loss:SELL', stop_loss_quote)
  ) as kv(key, val)
  where val is not null and val <> 0
);

-- orders: concatenate the old per-intent arrays (stop_loss may be NULL).
-- `jsonb || jsonb` only concatenates when both operands are arrays; the
-- handler always wrote arrays, but guard each column with jsonb_typeof so a
-- stray non-array value degrades to '[]' instead of silently key-merging
-- into a malformed shape.
update trade_archive set orders =
  (case when jsonb_typeof(buy) = 'array' then buy else '[]'::jsonb end)
  || (case when jsonb_typeof(sell) = 'array' then sell else '[]'::jsonb end)
  || (case when jsonb_typeof(stop_loss) = 'array' then stop_loss else '[]'::jsonb end)
  || (case when jsonb_typeof(manual_trade) = 'array' then manual_trade else '[]'::jsonb end);

alter table trade_archive drop column buy_grid_quote;
alter table trade_archive drop column buy_manual_quote;
alter table trade_archive drop column sell_grid_quote;
alter table trade_archive drop column sell_manual_quote;
alter table trade_archive drop column stop_loss_quote;
alter table trade_archive drop column buy;
alter table trade_archive drop column sell;
alter table trade_archive drop column stop_loss;
alter table trade_archive drop column manual_trade;
