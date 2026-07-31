-- Unify the trailing-trade regime config. The two separate knobs
-- `buy.regimeFilter` (instantaneous promotion suppressor) and
-- `sell.regimeExit` (closes-confirmed cash-rotation exit) collapse into one
-- top-level `regime` block: { ma, period, confirmBars, onBear: { exitToCash,
-- suppressPromotion } }. One MA definition now drives both behaviours so the
-- operator reasons about a single macro trend.
--
-- The worker reads RAW stored config (no schema defaults), so dropping the old
-- keys without rewriting stored rows would silently disable a live operator's
-- bear protection. This migration rewrites both config-bearing jsonb columns to
-- preserve the enabled state.
--
-- MA conflict: when a row set DIFFERENT ma/period on regimeFilter vs regimeExit,
-- the unified block keeps regimeExit's (the richer, confirmBars-bearing) value;
-- regimeFilter's MA is dropped. Unification is one regime by design.
--
-- profiles.config is the authoritative base, so it gets a fully-shaped regime
-- block (schema defaults fill any gap). profile_symbols.override_config is a
-- partial patch the worker deep-merges, so it carries ONLY the keys the override
-- actually set (jsonb_strip_nulls drops absent ones) to avoid clobbering the
-- base regime on merge. The runner applies this file once inside a transaction.

-- Base profile config: full regime block, old keys removed.
update profiles
set config =
  (config #- '{buy,regimeFilter}' #- '{sell,regimeExit}')
  || jsonb_build_object('regime', jsonb_build_object(
       'ma',          coalesce(config #> '{sell,regimeExit,ma}',          config #> '{buy,regimeFilter,ma}',     '"ema"'::jsonb),
       'period',      coalesce(config #> '{sell,regimeExit,period}',      config #> '{buy,regimeFilter,period}', '200'::jsonb),
       'confirmBars', coalesce(config #> '{sell,regimeExit,confirmBars}', '3'::jsonb),
       'onBear', jsonb_build_object(
         'exitToCash',        coalesce(config #> '{sell,regimeExit,enabled}',  'false'::jsonb),
         'suppressPromotion', coalesce(config #> '{buy,regimeFilter,enabled}', 'false'::jsonb)
       )
     ))
where config #> '{regime}' is null
  and (config #> '{buy,regimeFilter}' is not null
       or config #> '{sell,regimeExit}'  is not null);

-- Per-symbol override: minimal regime patch (only the keys the override set),
-- old keys removed. jsonb_strip_nulls drops absent keys so deep-merge leaves the
-- rest of the profile's regime intact.
update profile_symbols
set override_config =
  (override_config #- '{buy,regimeFilter}' #- '{sell,regimeExit}')
  || jsonb_build_object('regime', jsonb_strip_nulls(jsonb_build_object(
       'ma',          coalesce(override_config #> '{sell,regimeExit,ma}',     override_config #> '{buy,regimeFilter,ma}'),
       'period',      coalesce(override_config #> '{sell,regimeExit,period}', override_config #> '{buy,regimeFilter,period}'),
       'confirmBars', override_config #> '{sell,regimeExit,confirmBars}',
       'onBear', jsonb_strip_nulls(jsonb_build_object(
         'exitToCash',        override_config #> '{sell,regimeExit,enabled}',
         'suppressPromotion', override_config #> '{buy,regimeFilter,enabled}'
       ))
     )))
where override_config is not null
  and override_config #> '{regime}' is null
  and (override_config #> '{buy,regimeFilter}' is not null
       or override_config #> '{sell,regimeExit}' is not null);
