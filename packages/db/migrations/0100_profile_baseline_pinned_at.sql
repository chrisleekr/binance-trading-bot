-- 0100_profile_baseline_pinned_at.sql
-- When the operator pinned the current baseline backtest. The edge-decay monitor and the live-vs-backtest scorecard judge only trades archived at or after this instant, so trades closed under an earlier config no longer count against the config the baseline was pinned for. Nullable and additive: a row pinned before this migration keeps NULL, which every reader treats as the all-time window it used before, and re-pinning stamps it.
alter table profiles add column if not exists baseline_pinned_at timestamptz;
