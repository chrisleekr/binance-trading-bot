-- Profile diagnosis runs: one row per "why isn't it trading?" investigation.
--
-- Durable rather than in-memory because the run is watched, not awaited. The
-- operator starts it, closes the dialog, comes back, reloads the page; each of
-- those has to find the same run in the same state. An in-process map would lose
-- it on a worker restart mid-run and leave the UI polling something that no
-- longer exists.
--
-- `steps` is written incrementally as each check lands, which is what makes the
-- displayed progress the worker's real position rather than a client-side timer.
-- The final `report` is written once, at the end.
--
-- Not a hypertable: this is a small, bounded, mutable working set (a handful of
-- rows per profile, each updated several times during its run), the opposite of
-- the append-only time-series shape hypertables exist for.

create table if not exists diagnosis_runs (
  id          uuid primary key,
  profile_id  uuid not null references profiles(id) on delete cascade,
  status      text not null check (status in ('queued', 'running', 'done', 'error')),
  -- Per-step progress, replaced wholesale on each write. Small and bounded (one
  -- entry per ladder rung), so a rewrite is cheaper than a partial jsonb update.
  steps       jsonb not null default '[]'::jsonb,
  -- The assembled report; null until the run finishes.
  report      jsonb,
  -- Operator-facing failure reason; null unless status = 'error'.
  error       text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

-- Serves both reads: the newest run for a profile on page load, and the
-- keep-newest-N prune. Leads with profile_id so it is account-scoped by row.
create index if not exists diagnosis_runs_by_profile_started
  on diagnosis_runs (profile_id, started_at desc);
