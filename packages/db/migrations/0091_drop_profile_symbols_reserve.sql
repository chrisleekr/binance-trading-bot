-- Drop the always-hold reserve.
--
-- `reserve_base_quantity` ringfenced a base quantity the bot must never sell below. It shipped in 0054 and no operator ever set one. The evidence is a direct query of the live database on 2026-08-25: 0 of 37 bindings carried a non-null reserve, across both binance modes (16 live, 21 test). The audit log is deliberately NOT the evidence here — audit writes are best-effort and swallow their own failures, so an empty audit trail cannot distinguish "never written" from "written and the audit write lost".
--
-- Against zero use the column carried real cost: the worker subtracted it from the bot-visible balance on every tick, a profile disposal had to hand-carry it to the target binding, and the boot reconciler had to reason about it. Removing the column removes all three.
--
-- Nothing reads the column after this migration; the API route, the worker plumbing and the web card go with it.

-- Refuse to apply if a reserve has appeared since that query. The drop is irreversible and the currently-deployed image still serves the reserve route, so an operator setting one between now and the deploy would have it destroyed silently. This block is inert on a fresh CI database by construction — there are no rows to count — which is fine: its whole purpose is the production apply, where the ledger is decades of operator writes rather than a migration replay.
do $$
declare
  n bigint;
begin
  select count(*) into n from profile_symbols where reserve_base_quantity is not null;
  if n > 0 then
    raise exception 'refusing to drop reserve_base_quantity: % rows still carry a reserve', n;
  end if;
end $$;

-- Destructive: the column and every value in it are gone, and no down-migration can restore them.
--
-- Safe under both deployments in use. In-repo, `deploy/compose/docker-compose.prod.yml` declares one `app` service with no `replicas` override, and `docker compose up` recreates a changed service by stopping the old container before starting the new one. The live cluster (manifests live outside this repo) was checked directly on 2026-08-25 and runs a single replica with `strategy: Recreate`, which tears the old pod down before creating the new one. Neither leaves a pre-0091 process alive alongside the dropped column. A reader deploying the dormant split topology from `docker-compose.scale.yml` gets no such guarantee — drizzle emits explicit column lists, so a pre-0091 image selects `reserve_base_quantity` by name and fails with Postgres 42703 (undefined_column) on every profile_symbols read until it is replaced.
alter table profile_symbols drop column if exists reserve_base_quantity;
