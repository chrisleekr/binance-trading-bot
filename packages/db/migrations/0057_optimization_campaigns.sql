-- Auto-optimize campaign: an operator-driven loop of up to `max_iterations`
-- optimization studies. Each iteration's search space is LLM-seeded from the
-- previous winner's "why it didn't trade" funnel, then Optuna refines it with a
-- held-out (out-of-sample) split. The campaign is the durable parent; each
-- iteration is a `backtest_studies` row carrying `campaign_id`. The loop is
-- advanced by the existing study-completion webhook, so the campaign holds only
-- its definition and rolling best — no trial internals.
create table if not exists optimization_campaigns (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid not null references profiles (id) on delete cascade,
  status          text not null,
  -- Loop budget: at most this many studies before the campaign finalizes with
  -- the best candidate found.
  max_iterations  integer not null,
  -- The study definition reused for every iteration (only the search space
  -- changes between iterations). Validated at the API boundary against the
  -- @app/contracts schemas; opaque jsonb here.
  objective       jsonb not null,
  oos_protocol    jsonb not null,
  base            jsonb not null,
  trials          integer not null,
  limits          jsonb,
  -- The done backtest run whose funnel seeds the first iteration. No FK: consumed
  -- once the first study launches, so a later delete of that run must not block.
  seed_run_id     uuid,
  -- Rolling best across iterations, ranked by held-out aggregate score. No FK on
  -- the study/run ids (same-profile, read-scoped); `best_config` is the winning
  -- partial strategyConfigOverride the operator loads into Setup to promote.
  best_study_id   uuid,
  best_run_id     uuid,
  best_config     jsonb,
  best_score      double precision,
  -- Whether the best candidate cleared the held-out quality bar (the live gate
  -- still decides go-live on a fresh full-window backtest at promote time).
  goal_met        boolean not null default false,
  failure_reason  text,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz,
  constraint optimization_campaigns_status_chk
    check (status in ('queued', 'running', 'done', 'error'))
);

create index if not exists optimization_campaigns_by_profile_created
  on optimization_campaigns (profile_id, created_at desc);

-- Link each study to its parent campaign (null for a standalone study). ON
-- DELETE CASCADE so deleting a campaign removes its iteration studies, which in
-- turn cascade their trial runs via backtest_runs.study_id.
alter table backtest_studies
  add column if not exists campaign_id uuid
  references optimization_campaigns (id) on delete cascade;

create index if not exists backtest_studies_by_campaign
  on backtest_studies (campaign_id);

-- At most one in-flight iteration study per campaign. A unique partial index so a
-- concurrent advance (the completion webhook racing a manual Resume) cannot launch
-- a second study while one is queued/running: the loser's insert hits 23505 and is
-- swallowed as the no-op it is. The normal sequential loop keeps only one iteration
-- non-terminal at a time, so it never trips; standalone studies (campaign_id null)
-- are excluded.
create unique index if not exists optimization_campaign_one_active_study
  on backtest_studies (campaign_id)
  where campaign_id is not null and status in ('queued', 'running');
