-- Profile-scoped risk controls (the daily-loss circuit breaker), stored OUTSIDE
-- the strategy `config` blob so the pure strategy never sees them (invariant #1).
-- Enforcement is worker-side and cross-symbol; the strategy stays
-- per-(profile,symbol). null = no risk controls configured. Shape is validated by
-- @app/contracts RiskConfigSchema at the API/worker boundary, not the DB.
alter table profiles add column if not exists risk_config jsonb;
