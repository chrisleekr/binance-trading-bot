-- Clear the per-symbol state stranded by past unbinds.
--
-- Until the unbind became a structural teardown, every path that dropped a
-- `profile_symbols` row left the symbol's state behind. A `condition_states`
-- row is closed only by the owning tick writing a null code, and an unbound
-- symbol never ticks again, so those rows can never close: they accumulate
-- without bound, and any reader of open conditions names coins the profile does
-- not hold. The reap made it systematic rather than rare, because it removes
-- exactly the symbols that never entered, and the reason they never entered IS
-- the open condition row.
--
-- The code fix only stops new orphans. This is the one-time repair of the rows
-- already there. Idempotent: each statement deletes what has no binding, so a
-- re-run finds nothing.

-- `symbol <> ''` exempts the profile-level subject. It is a sentinel, not a
-- symbol (the primary key spans `symbol`, and Postgres forbids a nullable
-- primary-key column), so it has no binding to resolve against and never had.
delete from condition_states cs
 where cs.symbol <> ''
   and not exists (
     select 1 from profile_symbols ps
      where ps.profile_id = cs.profile_id and ps.symbol = cs.symbol
   );

-- Paired with the `avg_entry_prices` rule below: a ledger row claiming a
-- position is kept, and the state body is the only place that position carries a
-- price. Deleting one without the other leaves a ledger row no state body prices,
-- which is precisely what `dispose_profile` refuses to hand off over — it checks
-- EVERY ledger row, not just bound ones, so the profile could never be disposed
-- again. The two surfaces are swept together or not at all.
delete from symbol_states ss
 where not exists (
   select 1 from profile_symbols ps
    where ps.profile_id = ss.profile_id and ps.symbol = ss.symbol
 )
   and not exists (
     select 1 from avg_entry_prices ae
      where ae.profile_id = ss.profile_id and ae.symbol = ss.symbol and ae.quantity > 0
   );

-- Zero-quantity rows only. A positive quantity is the durable claim that the
-- operator still holds those coins, and it is the sole surviving cost basis for
-- them: deleting it would make the position unpriced, and no repair can invent
-- an entry price back. Such a row is reported by the orphan-position surfaces
-- and re-adopted when the symbol is bound again, so it is left to that path.
delete from avg_entry_prices ae
 where ae.quantity <= 0
   and not exists (
     select 1 from profile_symbols ps
      where ps.profile_id = ae.profile_id and ps.symbol = ae.symbol
   );

-- Pending rows only, matching what an unbind now cancels. A claimed row is
-- mid-side-effect in a worker and a consumed one is history the dust-transfer
-- view reads back, so neither is this sweep's to delete.
delete from override_actions oa
 where oa.symbol is not null
   and oa.consumed_at is null
   and oa.processing_at is null
   and not exists (
     select 1 from profile_symbols ps
      where ps.profile_id = oa.profile_id and ps.symbol = oa.symbol
   );
