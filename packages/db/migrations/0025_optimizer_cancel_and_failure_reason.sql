-- #359 / #367 optimizer reliability batch.
--
-- #359: persist a study's launch params (base / trials / limits) so it is
-- self-describing and can be cloned to retry, and store the failure reason so
-- the UI shows WHY a study failed instead of a generic "Study failed". All
-- nullable: studies created before this migration have no base/trials, and the
-- clone path guards on `base` presence.
alter table backtest_studies
  add column base jsonb,
  add column trials integer,
  add column limits jsonb,
  add column failure_reason text;

-- #367: a trial run the optimizer abandons on timeout is now CANCELLED (the
-- worker polls this mid-run and stops computing a result no longer needed), a
-- terminal status distinct from error. Postgres cannot alter a CHECK in place,
-- so drop and recreate it.
alter table backtest_runs drop constraint backtest_runs_status_chk;

alter table backtest_runs
  add constraint backtest_runs_status_chk
  check (status in ('queued', 'running', 'done', 'error', 'cancelled'));
