-- Current-state store for named conditions ("why isn't this trading right now?").
--
-- Every subsystem here already resolves why something is not happening on every
-- tick or scan -- the entry-blocker ladder per tick, discovery's staleness and
-- breadth verdicts per scan -- and each one throws that answer away into, at
-- best, a bespoke `action_logs` row. That makes the log an EDGE stream while
-- operators ask LEVEL questions: "what is wrong now, and since when?"
--
-- Edges alone cannot answer that once pruned. A symbol stuck on one reason for
-- three weeks has exactly one transition row, written three weeks ago, and it is
-- already gone -- so the log viewer is emptiest for the most-stuck symbol, which
-- is the worst possible failure mode for a diagnostic. Shortening action_log
-- retention makes it strictly worse.
--
-- Why a plain table rather than more rows in `action_logs`:
--
--   1. Opposite lifetimes. History is meant to be prunable; current state must
--      never be. One table means one retention policy serving two contradictory
--      requirements, and exempting "newest row per subject" from the sweep would
--      make the prune cron a second implicit owner of the horizon -- the exact
--      hazard 0076 was written to remove.
--   2. Unindexable read. "Current condition per subject" over the log is a
--      DISTINCT ON over a jsonb expression key that none of the action_logs
--      indexes can serve. Here it is a primary-key lookup.
--   3. The upsert is impossible. action_logs is a TimescaleDB hypertable
--      partitioned on `time`, and a unique index on a hypertable must contain
--      every partitioning column. A key of (profile_id, condition, symbol)
--      cannot exist there; adding `time` to it would make every write a new row
--      rather than a replaced one, which defeats the purpose.
--
-- So: the log stays an append-only edge stream, and this table is the mutable
-- keyed row. Both are written by one shared `recordCondition` writer, which
-- writes NOTHING when the code is unchanged -- the per-tick hot path stays free.
--
-- Size is bounded by (open conditions x symbols), not by time. A row exists only
-- while the condition is open; resolving deletes it and records the resolution
-- as an action_logs edge.
create table if not exists condition_states (
  profile_id uuid not null references profiles(id) on delete cascade,
  -- Which named condition. Deliberately `text`, not an enum: adding a producer
  -- should not need a migration, and the closed set lives in the contracts
  -- package where the readers already validate it.
  condition  text not null,
  -- Subject within the profile. Empty string means the condition is about the
  -- PROFILE itself, not one symbol. A sentinel rather than NULL because Postgres
  -- forbids nullable columns in a primary key, and the alternative -- two partial
  -- unique indexes -- would force two separate upsert paths for one write.
  symbol     text not null default '',
  -- The specific reason within the condition, e.g. 'knife-guard'. Per-strategy
  -- codes come from each strategy's own reason attribution, never a list here.
  code       text not null,
  -- Whatever structured payload the producer already carries, verbatim.
  detail     jsonb,
  -- When this (condition, code) began. Survives any log retention setting, so
  -- durations stay exact even after the opening edge row has been swept. This is
  -- the column that makes aggressive action_logs pruning safe.
  since      timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (profile_id, condition, symbol)
);

-- The primary key already leads with profile_id, so "every open condition for
-- this profile" -- the diagnosis's main read -- is served without another index.
