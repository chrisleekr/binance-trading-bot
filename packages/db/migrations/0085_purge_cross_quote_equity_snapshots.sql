-- Discard equity snapshots whose realised leg was summed across quote assets.
--
-- The realised-P/L aggregates in `trade_archive` filtered on profile and window but never on `quote_asset`, so `equity_snapshots.realized_net_quote` was the sum of EVERY cycle the profile had ever closed, whatever currency it settled in. A profile whose `quote_asset` was changed after it had closed cycles therefore carries rows where the realised leg is counted in the OLD quote and the position legs in the new one, added together and stamped with the new quote. Such a row is not merely mis-scaled, it is internally inconsistent: no single rate converts it back, so the values cannot be recomputed and there is nothing to repair.
--
-- These rows cannot be filtered out on read either, which is what separates them from the other cross-quote case. A snapshot recorded under a PREVIOUS quote is stamped with that quote and is simply omitted by the reader now that `listForProfileInRange` selects one currency; it stays on disk and becomes readable again if the operator switches back. A contaminated row is stamped with the CURRENT quote, so every reader accepts it. Deleting is the only way to stop it plotting.
--
-- `archived_at < captured_at` is the visibility bound: the cron's aggregate ran over `[epoch, now)` at capture time, so a cycle archived after the capture never entered that total and the snapshot is clean. The two timestamps come from different clocks (`captured_at` is the DB `now()`, `archived_at` a worker-side stamp), so the bound is exact only up to skew; contamination is monotone once a foreign-quote cycle exists, so skew can spare at most the first affected row.
--
-- KNOWN RESIDUAL, deliberately not covered. A snapshot can also be contaminated through its POSITION legs — an open holding in the old quote, marked at its own currency's price, which `computeEquitySnapshot` now excludes but previously summed in. Such a holding has no `trade_archive` row until its cycle closes, so this predicate cannot see it. Catching it would mean keying on `avg_entry_prices`, which records no "opened at" and would therefore delete every snapshot of any profile currently holding a foreign-quote position, including the clean ones from before it opened. Verified against the deployed database before writing: zero positions settle in anything other than their profile's quote, so the residual set is empty there. Over-deleting correct history to cover an empty set is the worse trade.
delete from equity_snapshots e
 where exists (
   select 1
     from trade_archive t
    where t.profile_id = e.profile_id
      -- Case-folded on BOTH sides, matching the reader. `trade_archive.quote_asset` carries Binance's upper casing, but this column is stamped from `profiles.quote_asset`, which this repo allows to be stored lower or mixed case. A raw compare would read `'USDT' <> 'usdt'` as a currency mismatch and delete the entire correct series of any profile that happens to store its quote in another casing — the same over-deletion the note above refuses, arriving through letters instead of through position legs.
      and upper(t.quote_asset) <> upper(e.quote_asset)
      and t.archived_at < e.captured_at
 );
