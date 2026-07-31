-- Make orders.intent a generic, strategy-owned string by dropping the closed
-- orders_intent_chk CHECK. Trailing-trade's grid vocabulary
-- (grid-buy/grid-sell/grid-stop-loss/technicals-force-sell/manual) was the
-- only allowed set, so a second strategy's orders (e.g. momentum's
-- entry/exit) would be rejected at insert AFTER Binance accepted the order.
-- Each strategy now owns its intent names; the column stays NOT NULL.
--
-- This also permanently retires the #352 drift class: with no closed CHECK to
-- diverge from the @app/contracts enum, the executor can no longer crash on
-- the bookkeeping insert because of an unrecognised intent.

alter table orders drop constraint orders_intent_chk;
