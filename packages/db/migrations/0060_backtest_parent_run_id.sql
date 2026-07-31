-- A re-run forks from the run it was launched against, so the new run records
-- that lineage in parent_run_id. Self-referential FK with ON DELETE SET NULL:
-- deleting the parent run just clears the child's pointer (the child survives,
-- it is not cascade-deleted). Additive + nullable so existing runs keep a null
-- parent. The Drizzle schema declares the full .references() FK (like profile_id /
-- study_id), but db:generate is not used: that declaration only informs typing
-- and relations. This hand-authored migration is the authoritative DDL applied to
-- the live DB, consistent with the table's other FKs.
alter table backtest_runs add column if not exists parent_run_id uuid;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'backtest_runs_parent_run_fk') then
    alter table backtest_runs
      add constraint backtest_runs_parent_run_fk
      foreign key (parent_run_id) references backtest_runs(id) on delete set null;
  end if;
end $$;
