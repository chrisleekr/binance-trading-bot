-- Align orders_intent_chk with the OrderIntent vocabulary the strategy and
-- @app/contracts now emit. The 0014 config-key rename renamed
-- `tv-force-sell` -> `technicals-force-sell` in strategy-core and contracts,
-- but the CHECK constraint (last set in 0013) still admits only the old
-- `tv-force-sell` spelling. The live executor therefore crashes on the
-- bookkeeping insert AFTER Binance has already accepted a technicals-force-sell
-- SELL, leaving the exchange and local books divergent with no idempotent
-- recovery. Repoint any historical rows first so they survive the stricter
-- constraint, then drop/recreate the CHECK (Postgres can't alter one in place).

update orders set intent = 'technicals-force-sell' where intent = 'tv-force-sell';

alter table orders drop constraint orders_intent_chk;

alter table orders
  add constraint orders_intent_chk
  check (intent in ('grid-buy', 'grid-sell', 'grid-stop-loss', 'technicals-force-sell', 'manual'));
