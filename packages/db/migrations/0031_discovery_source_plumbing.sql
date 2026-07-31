-- Slice 1 of the auto-discover-bull-coins epic: persistence + guardrails so a
-- later discovery cron can rotate symbols in/out safely. No behaviour change
-- with discovery off — every new column defaults to the manual/disabled steady
-- state, so existing operator-added symbols and profiles are unaffected.

-- profile_symbols.source: did the operator add this symbol (manual) or did
-- discovery rotate it in (auto). Discovery may only ever reap source='auto'
-- rows, and only when the symbol is flat (the flat-guard lives in the repo).
-- Every existing row is operator-added, hence the 'manual' default + backfill.
alter table profile_symbols
  add column source text not null default 'manual',
  add column last_flatten_at timestamptz;

alter table profile_symbols
  add constraint profile_symbols_source_chk check (source in ('manual', 'auto'));

-- trade_archive.source: stamped at archive time from the symbol's source so the
-- net-edge scoreboard can isolate discovery-attributed realized PnL
-- (WHERE source='auto'). Pulled forward from Slice 4 so the scoreboard accrues
-- history from the day discovery is first enabled, not from a later migration.
alter table trade_archive
  add column source text not null default 'manual';

alter table trade_archive
  add constraint trade_archive_source_chk check (source in ('manual', 'auto'));

-- profiles.discovery_config: profile-scoped discovery settings, stored OUTSIDE
-- config so the strategy schema never sees them (invariant #1 — the worker reads
-- this column directly; the strategy is discovery-agnostic). Keeping it out of
-- profiles.config also dodges the backtest-runner's configSchema.parse, which
-- would silently strip an unknown key. NULL = discovery disabled (the default
-- for every existing profile). Shape is validated in Slice 3, not at the DB.
alter table profiles
  add column discovery_config jsonb;
