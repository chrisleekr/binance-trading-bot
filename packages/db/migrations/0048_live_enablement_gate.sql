-- Live-enablement edge gate. Two additive columns, both nullable so existing
-- rows are untouched.
--
-- backtest_runs.config_fingerprint: a stable hash of the EFFECTIVE merged
-- strategy config a run executed (profile config + run override), stamped by the
-- worker on completion. The gate matches it against the profile's current config
-- so a backtest counts as proof only for the config it actually tested. Null for
-- runs that completed before this column shipped (they never match → re-run).
alter table backtest_runs add column if not exists config_fingerprint text;

-- profiles.enablement_policy: the backtest-quality thresholds a profile must
-- clear before it can be enabled in `live` mode (net profit factor, min trades,
-- alpha-vs-hold, max backtest age, and an on/off toggle), stored OUTSIDE the
-- strategy `config` blob (invariant #1 — gate enforcement is API/worker-side).
-- null = use the contract defaults. Shape validated by @app/contracts
-- EnablementPolicy at the API boundary, not the DB.
alter table profiles add column if not exists enablement_policy jsonb;
