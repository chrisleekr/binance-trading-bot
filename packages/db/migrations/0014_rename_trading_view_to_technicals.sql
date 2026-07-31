-- 0014_rename_trading_view_to_technicals.sql
-- Carry over `config.tradingView` and `config.forceBuyOverride.checkTradingView`
-- from rows written before the rename to their new keys (`config.technicals`,
-- `config.forceBuyOverride.checkTechnicals`).
--
-- The TT strategy schema was renamed `tradingView` -> `technicals` and
-- `checkTradingView` -> `checkTechnicals` across packages/strategy/trailing-trade
-- in the iter61-70 sweep. The persisted JSONB columns were not migrated, so
-- existing rows still carry the old keys. Zod parsing on read silently strips
-- unknown keys and fills `technicals` from the schema default, so an
-- operator's actual Technicals configuration (intervals, freshness window,
-- ifExpires policy) is lost without warning. Same for `checkTradingView`,
-- which defaults to `true` and reads identical to the old value but leaves
-- a stale key on disk.
--
-- Rewrite is idempotent: if a row already carries the new key, the old one
-- is just stripped; if it carries only the old key, the value is moved.
-- Both columns are updated in one statement so a partial write cannot leave
-- the two halves out of sync.

update profiles
set config = (
  case
    when config ? 'tradingView' and not (config ? 'technicals')
      then (config - 'tradingView') || jsonb_build_object('technicals', config->'tradingView')
    when config ? 'tradingView' and (config ? 'technicals')
      then config - 'tradingView'
    else config
  end
) || (
  case
    when (config->'forceBuyOverride') ? 'checkTradingView'
      then jsonb_build_object(
        'forceBuyOverride',
        (
          coalesce(config->'forceBuyOverride', '{}'::jsonb)
          - 'checkTradingView'
        ) || jsonb_build_object(
          'checkTechnicals',
          coalesce(
            (config->'forceBuyOverride')->'checkTechnicals',
            (config->'forceBuyOverride')->'checkTradingView'
          )
        )
      )
    else '{}'::jsonb
  end
)
where config ? 'tradingView'
   or (config->'forceBuyOverride') ? 'checkTradingView';

update profile_symbols
set override_config = (
  case
    when override_config ? 'tradingView' and not (override_config ? 'technicals')
      then (override_config - 'tradingView') || jsonb_build_object('technicals', override_config->'tradingView')
    when override_config ? 'tradingView' and (override_config ? 'technicals')
      then override_config - 'tradingView'
    else override_config
  end
) || (
  case
    when (override_config->'forceBuyOverride') ? 'checkTradingView'
      then jsonb_build_object(
        'forceBuyOverride',
        (
          coalesce(override_config->'forceBuyOverride', '{}'::jsonb)
          - 'checkTradingView'
        ) || jsonb_build_object(
          'checkTechnicals',
          coalesce(
            (override_config->'forceBuyOverride')->'checkTechnicals',
            (override_config->'forceBuyOverride')->'checkTradingView'
          )
        )
      )
    else '{}'::jsonb
  end
)
where override_config is not null
  and (
    override_config ? 'tradingView'
    or (override_config->'forceBuyOverride') ? 'checkTradingView'
  );
