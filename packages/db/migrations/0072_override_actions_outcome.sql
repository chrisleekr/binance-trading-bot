-- 0072_override_actions_outcome.sql
--
-- An override row marked merely "consumed" cannot tell a filled force-sell apart
-- from one the exchange refused, so every terminal write now records WHAT the
-- operator got. That outcome gets its own column rather than riding `result`:
-- `result` is the side-effect payload (the dust flow stores Binance's convertDust
-- response there), so sharing one column would make `null` mean both "still
-- pending" and "settled, but the payload is not an outcome" — a reader could only
-- tell them apart by guessing at the shape.
--
-- The first index backs the read path, which changed from "the latest UNCONSUMED
-- row for this symbol" to "the latest row for this symbol, settled or not": an
-- operator has to be able to see the outcome of an override that has already run,
-- and a consumed row is exactly the one that carries it. That query orders by
-- created_at within (profile_id, symbol) and the existing indexes do not cover
-- it, leaving a per-request scan of the profile's whole override history.
--
-- The second index backs the stranded-row reaper: rows still pending long after
-- their Redis key expired. Partial on the pending predicate so it stays tiny
-- (the vast majority of rows are settled), and on `symbol is not null` because
-- the account-wide dust-transfer rows have their own lifecycle and must never be
-- reaped by it.

alter table override_actions
  add column if not exists outcome jsonb;

create index if not exists override_actions_profile_symbol_recent_idx
  on override_actions (profile_id, symbol, created_at desc);

create index if not exists override_actions_pending_symbol_idx
  on override_actions (profile_id, created_at)
  where consumed_at is null and symbol is not null;
