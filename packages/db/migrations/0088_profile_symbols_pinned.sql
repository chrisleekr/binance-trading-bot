-- Split reap-protection out of `profile_symbols.source`.
--
-- `source` carried two unrelated facts at once: WHERE a binding came from, and WHETHER discovery may rotate it out. Any path that had to protect a binding could only do so by claiming the operator added it. The fill adopter does exactly that — when a buy fill lands on a symbol discovery already reaped, it re-creates the binding as `manual` so the recovered position stays managed — and the row is then exempt from rotation forever, occupying a slot for a coin the operator never chose.
--
-- After this migration `pinned` alone gates the reap and `source` is pure provenance, widened with `unknown` for bindings the system re-created (crediting either the operator or discovery there would be the same false claim, merely pointed the other way).
--
-- `pinned_at` stays NULL for backfilled rows on purpose. A pin inferred from the old model has no honest timestamp, and fabricating `now()` would make every legacy row indistinguishable from a pin the operator actually chose. The UI reads NULL-on-pinned as "unverified" and asks.

alter table profile_symbols
  add column if not exists pinned boolean not null default false;

alter table profile_symbols
  add column if not exists pinned_at timestamptz;

-- A column default governs no existing row, so the live rows are moved explicitly. Every `manual` row was reap-exempt under the old model and must stay that way.
update profile_symbols set pinned = true where source = 'manual';

-- Both check constraints admit the widened provenance vocabulary. Dropped first so re-running against a database that already carries the old bound still installs the new one.
alter table profile_symbols
  drop constraint if exists profile_symbols_source_chk;
alter table profile_symbols
  add constraint profile_symbols_source_chk check (source in ('manual', 'auto', 'unknown'));

alter table trade_archive
  drop constraint if exists trade_archive_source_chk;
alter table trade_archive
  add constraint trade_archive_source_chk check (source in ('manual', 'auto', 'unknown'));

-- Post-flight. The backfill is the whole reason a deployed database does not silently start rotating out the operator's own coins, so a row that escaped it must stop the deploy rather than surface later as a coin that vanished.
do $$
begin
  if exists (select 1 from profile_symbols where source = 'manual' and not pinned) then
    raise exception 'profile_symbols pin backfill incomplete: an operator-added binding is still unpinned and discovery would reap it';
  end if;
end $$;
