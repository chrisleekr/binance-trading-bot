-- The edge-decay monitor.mode enum was narrowed to ('off','warn') when the live-gate
-- 'halt' reaction was removed, but existing enablement_policy rows kept mode='halt' and
-- now fail response validation on read (a 422 that bricks the whole profile page).
-- Rewrite any non-current mode to the current default 'warn' — the operator had the
-- monitor active, and 'warn' is the surviving "surface it" mode. Data-only, idempotent:
-- null policies and already-valid rows are untouched.
update profiles
set enablement_policy = jsonb_set(enablement_policy, '{monitor,mode}', '"warn"'::jsonb, false)
where enablement_policy is not null
  and enablement_policy #>> '{monitor,mode}' is not null
  and enablement_policy #>> '{monitor,mode}' not in ('off', 'warn');
