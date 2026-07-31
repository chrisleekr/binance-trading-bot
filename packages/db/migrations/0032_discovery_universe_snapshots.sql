-- Durable point-in-time discovery universe series (#436). Binance serves no
-- historical all-symbols ticker stream and the repo logs none, so a faithful
-- net-edge backtest of the dynamic universe needs "what was the ranked universe
-- at time t" captured forward, one row per discovery cycle. The discovery cron
-- already computes the universe + shortlist + diff + the thresholds in force; it
-- now persists that bundle here every cycle so a window accumulates from the day
-- the cron runs. Append-only, profile-scoped, pure observability — the write
-- never changes the selection or the add/reap behaviour.

create table discovery_universe_snapshots (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  captured_at timestamptz not null default now(),
  -- Point-in-time cycle bundle: full quote-matched ranked universe, the
  -- post-ticker-filter shortlist, the resolved add/remove/desired diff, and the
  -- threshold digest in force. Raw jsonb (shape validated app-side, like
  -- profile_state_history.state) so the series can extend without a migration.
  snapshot jsonb not null
);

-- Read path is "latest N snapshots for this profile, newest first" (the future
-- operator backtest read), so index (profile_id, captured_at desc).
create index discovery_universe_snapshots_profile_captured
  on discovery_universe_snapshots (profile_id, captured_at desc);
