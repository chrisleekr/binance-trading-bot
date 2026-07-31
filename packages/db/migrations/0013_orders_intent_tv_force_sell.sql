-- Extend orders.intent enum to admit `tv-force-sell` rows the trailing-trade
-- strategy emits when a configured TradingView interval reports its
-- force-sell trigger recommendation while a held position is in profit and
-- below its sell-trigger price. Mirrors the OrderIntent zod enum.
--
-- Postgres CHECK constraints can't be altered in place; drop and recreate.

alter table orders drop constraint orders_intent_chk;

alter table orders
  add constraint orders_intent_chk
  check (intent in ('grid-buy', 'grid-sell', 'grid-stop-loss', 'tv-force-sell', 'manual'));
