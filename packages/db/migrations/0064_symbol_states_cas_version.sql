-- Optimistic-concurrency token for symbol_states.
--
-- Before the worker fleet, a read-modify-write of a (profile, symbol) strategy
-- slice was serialised only by the in-process chainByKey Promise chain, which
-- does not span pods. Under competing consumers two pods (a tick racing a fill
-- adopt on the stream-owner pod) could interleave read/write and silently
-- lose one mutation. `version` is a monotonic CAS token: every write carries
-- `WHERE version = :expected` and bumps it, so a stale writer's UPDATE matches
-- zero rows and the caller retries (fill path) or skips without clobbering
-- (tick commit). Distinct from `strategy_version`, which is a schema-migration
-- stamp, not a concurrency counter.
--
-- Existing rows default to 0. Idempotent: IF NOT EXISTS guards a re-run.
alter table symbol_states
  add column if not exists version integer not null default 0;
