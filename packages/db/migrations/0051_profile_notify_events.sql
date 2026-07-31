-- Profile-scoped notification subscriptions: which event categories alert the
-- operator (daily-loss halt, edge-decay halt, discovery, periodic summary).
-- Nullable jsonb, mirroring risk_config / enablement_policy: null means the
-- contract defaults (every event on), so existing profiles keep today's
-- behaviour until the operator mutes one. Shape is validated by @app/contracts
-- ProfileNotifyEvents at the boundary, not the DB.
alter table profiles add column if not exists notify_events jsonb;
