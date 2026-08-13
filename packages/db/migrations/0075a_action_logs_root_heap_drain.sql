-- Move rows stranded in the `action_logs` hypertable root heap into a chunk.
--
-- A hypertable keeps its rows in chunks, and the root heap is meant to stay
-- empty. TimescaleDB expands the hypertable to its chunks and leaves the parent
-- out of the plan, so a row stranded in the parent is invisible to every
-- statement naming `action_logs`: the log viewer never returns it, and the
-- retention cron's `delete from action_logs where time < ...` skips it even
-- though that statement carries no `only`. `alter table ... set not null` does
-- not go through the planner, it scans the heap directly, so it sees exactly the
-- rows nothing else can reach.
--
-- That asymmetry is what broke 0076: its `id` backfill reported every row
-- updated and the closing `set not null` still failed with a null. Left alone
-- the rows leak forever, since no retention path reaches them, and they block
-- every future constraint on this table.
--
-- Sequenced ahead of 0076 rather than folded into it. 0076 already applied in
-- environments whose root heap happened to be empty, and the runner refuses a
-- file whose checksum changed after it was recorded. Ordering is lexicographic,
-- so this lands after 0075 and before 0076 on a fresh database, while an
-- environment already carrying 0076 simply picks it up as a new file. The
-- insert omits `id` so both orders work: before 0076 the column does not exist
-- yet and 0076's backfill fills it, after 0076 the column default supplies it.
-- In that second order the rescued row is re-keyed with a fresh `id`, which
-- costs nothing: the old value was never observable, the row being unreachable
-- through the hypertable.

-- Serialises the drain against concurrent writers for the length of this
-- transaction. It does not reach further than that: the runner commits each
-- file separately, so the lock is gone before 0076 begins. The check at the
-- foot of this file, and 0076's own `set not null`, are what catch a row
-- stranded after this point.
lock table action_logs in access exclusive mode;

-- No `where` clause: every row in the parent heap is stranded by definition, so
-- there is nothing to select on.
with stranded as (
  delete from only action_logs
  returning time, profile_id, symbol, level, msg, ctx
)
insert into action_logs (time, profile_id, symbol, level, msg, ctx)
select time, profile_id, symbol, level, msg, ctx from stranded;

-- The re-insert depends on chunk routing, which is the one thing known to have
-- been inactive when these rows were stranded. With `timescaledb.restoring` on,
-- or the extension not preloaded, the rows land straight back in the parent and
-- this file still commits, at which point the runner records it as applied and
-- never offers it again while 0076 keeps failing on the same nulls. Abort the
-- transaction instead, so nothing is recorded and a rerun is still possible.
do $$
declare
  remaining bigint;
begin
  select count(*) into remaining from only action_logs;
  if remaining > 0 then
    raise exception
      'action_logs root heap still holds % rows after the drain (timescaledb.restoring=%): chunk routing is inactive, so the re-insert landed back in the parent',
      remaining,
      coalesce(current_setting('timescaledb.restoring', true), 'unset');
  end if;
end$$;
