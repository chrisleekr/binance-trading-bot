-- 0017_rename_tradingview_to_technicals_table.sql
-- Rename hypertable `tradingview_recommendations` -> `technicals_recommendations`
-- and its check constraint. 0014 only renamed the JSONB config keys; commit
-- 1e0aaa6f retroactively edited 0005 to use the new name but never added a
-- runtime rename migration, leaving already-migrated DBs with the old table
-- while code (Drizzle schema, repos, UI queries) targets the new name.
--
-- Idempotent: each rename is guarded so fresh DBs (which already have the
-- post-rename names from 0005's current content) skip silently.

do $$
declare
  has_old boolean := to_regclass('public.tradingview_recommendations') is not null;
  has_new boolean := to_regclass('public.technicals_recommendations') is not null;
begin
  if has_old and not has_new then
    execute 'alter table tradingview_recommendations rename to technicals_recommendations';
  elsif has_old and has_new then
    raise exception 'both tradingview_recommendations and technicals_recommendations exist; manual cleanup required';
  end if;
end$$;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'tradingview_recommendations_recommendation_chk'
      and conrelid = 'technicals_recommendations'::regclass
  ) then
    execute 'alter table technicals_recommendations '
         || 'rename constraint tradingview_recommendations_recommendation_chk '
         || 'to technicals_recommendations_recommendation_chk';
  end if;
end$$;
