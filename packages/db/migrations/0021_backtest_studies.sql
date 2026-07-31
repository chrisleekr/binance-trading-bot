-- Config-optimization studies over the backtest engine (#326, epic #325).
-- A study searches a strategy's config space for a config that performs well
-- out-of-sample; each trial is a child backtest_runs row linked by study_id.
-- Account-scoped (carries profile_id, ON DELETE CASCADE) and accessed only
-- through the ProfileScope repo. search_space / objective / oos_protocol are
-- validated at the API boundary against @app/contracts schemas, so they are
-- plain jsonb here. best_run_id points at the winning child run.
--
-- The optimizer's own sampler/trial state lives in Optuna's RDB storage
-- (separate tables in this same Postgres); this table is the operator-facing
-- study definition + outcome, the source of truth the UI and apply flow read.

create table backtest_studies (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references profiles(id) on delete cascade,
  search_space  jsonb not null,
  objective     jsonb not null,
  oos_protocol  jsonb not null,
  status        text not null,
  best_run_id   uuid,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz,
  constraint backtest_studies_status_chk check (status in ('queued','running','done','error'))
);

create index backtest_studies_by_profile_created on backtest_studies (profile_id, created_at desc);

-- A study's trials are child backtest_runs. Nullable so a standalone backtest
-- (no study) keeps study_id null. ON DELETE CASCADE so dropping a study reclaims
-- its trial runs.
alter table backtest_runs
  add column study_id uuid references backtest_studies(id) on delete cascade;

create index backtest_runs_by_study on backtest_runs (study_id) where study_id is not null;

-- best_run_id closes the loop back to the winning trial. Added after backtest_runs
-- gained study_id to keep the circular reference resolvable. ON DELETE SET NULL so
-- pruning a run does not delete the study.
alter table backtest_studies
  add constraint backtest_studies_best_run_fk
  foreign key (best_run_id) references backtest_runs(id) on delete set null;
