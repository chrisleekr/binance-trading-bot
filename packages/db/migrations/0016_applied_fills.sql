-- 0016_applied_fills.sql
-- PG-side dedupe ledger for fill-adopter (#263).
--
-- The adopter previously relied on a per-(profile, symbol) Redis SADD set
-- as its only dedupe primitive. On a mutateTtState failure the SADD was
-- released so BullMQ could retry, but the LBP weighted-average upsert had
-- already committed; the retry re-read the post-upsert row and added the
-- same fill quantity a second time, drifting the position by one fillQty
-- per retry.
--
-- This table records every applied fill on commit. The adopter inserts
-- with ON CONFLICT DO NOTHING; a 0-row result identifies a replay and
-- routes the adopter through a state-convergence path that does not
-- recompute the weighted average. The Redis SADD stays as a hot-path
-- cache, not the source of truth.

create table applied_fills (
  profile_id uuid not null references profiles(id) on delete cascade,
  symbol text not null,
  order_id bigint not null,
  trade_id bigint not null,
  side text not null check (side in ('BUY', 'SELL')),
  applied_at timestamptz not null default now(),
  primary key (profile_id, symbol, order_id, trade_id)
);

create index applied_fills_profile_symbol_idx on applied_fills (profile_id, symbol);
