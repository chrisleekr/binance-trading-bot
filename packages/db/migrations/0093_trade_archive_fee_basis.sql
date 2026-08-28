-- Replace the fee-completeness boolean with a three-tier fee basis on both tables that carried it.
--
-- `fees_quote_complete` answered "did the writer value every commission at execution time?", and true/false was the whole vocabulary. That leaves nowhere to record the third thing that actually happens: a charge reconstructed later, from a rate table or a ticker read long after the fill. Those rows were written `true`, so a figure with a real basis and no way left to check it has been rendering as a certified Net P/L. `fee_basis` splits that apart into `exact` (valued from evidence dated to the fill), `estimated` (reconstructed from a source that is not) and `unknown` (a charge is missing outright, so the recorded total under-states what was paid).
--
-- The backfill below is a SELF-CONSISTENCY rule, not "every fee key is native to the pair". Two things a stored row cannot show make the naive reading unsound. `fees` accumulates only for MATCHED orders, so a row that silently dropped whole fills still looks native. And `fees_quote` on older rows was written by two retired algorithms, one that dropped the base and third-asset legs to zero and one that valued a third-asset leg at a current ticker. A row may therefore only be certified `exact` when its stored total is reproducible from its own quote-asset fee leg. Every certifying arm carries that reproducibility test explicitly, including the all-zero arm: legs that are all zero imply a zero total, and a row claiming otherwise is contradicting itself, not reporting a measurement.
--
-- Two arms of that rule were got wrong first and neither is visible without real rows. The base asset is not a third asset: Binance charges the commission in the asset the account RECEIVES, so a base-asset commission is definitionally buy-side and the writer returns zero for it on purpose, because the cost basis already absorbed it. Subtracting only the quote key leaves the base key behind and reads every ordinary buy as carrying an unaccounted foreign charge. And a third-asset leg that was never valued is not an estimate, it is a hole: when the stored total does not exceed the quote leg, the BNB charge contributed nothing, so the row records zero fee drag on a cycle that paid some. That bias only ever runs one way — a missing charge makes the result look better — so those rows must land `unknown`, where the display gate withholds the statistics derived from them.
--
-- A base-leg row cannot reach `exact` either, and not for want of a rule. `orders[].base_commission_netted` is the only evidence that the cost basis really absorbed the charge; it shipped with 0090 and was never backfilled, so it is null on every row this migration sees. The proof does not exist, and `estimated` is the strongest honest reading.
--
-- That is deliberately NOT the answer the live writer gives the same-shaped evidence. `resolveFeesFromTrades` counts an unproven base BUY into `unprovenBaseBuyOrders`, which forces `unknown`, and it is right to: on a row written after 0090, a null `base_commission_netted` means the writer looked for the proof and did not find it. Here the column did not yet exist, so null means the question was never asked. Absence of evidence and evidence of absence read identically in the column and mean opposite things either side of 0090, which is why the tier differs. A change to either side has to be a change to both.
--
-- Checked against the live database on 2026-08-27, at 0092, over all 6,312 trade_archive rows: 6,211 exact (205 writer-proven, 6,005 all-commissions-zero, 1 quote-only reproducing), 86 estimated, 15 unknown. Of the 102 live-mode rows: 1 exact, 86 estimated (67 with a valued third-asset leg, 19 base-leg-only), 15 unknown. Testnet pays no commission and live pays in BNB, which is why every proven and every zero-fee row is testnet.
--
-- Two of those live rows are the reason the base-leg arm carries a reproducibility test rather than matching on shape alone. ETHBTC and LINKUSDT each record a real quote-asset commission (0.00000154 BTC, 0.0328536 USDT) against a stored `fees_quote` of zero, so the total omits a charge visible on its own row. Matching base-leg rows by shape alone certified them `estimated` and rendered a profit factor from a total known to be short; the equality conjunct drops them to `unknown`, where the display gate withholds it.
--
-- equity_snapshots converts without a rule: its boolean was stamped from the realised input's own completeness, so true becomes `exact` and false becomes `unknown`. There is no third state a boolean could have meant. The chart's eligibility filter admits every tier that HAS a basis (`fee_basis <> 'unknown'`), which is exactly the set the boolean admitted: no converted snapshot lands on `estimated`, so this migration changes no existing point's plotted state. Forward rows may land there, and those are plotted too, because an account Binance bills in BNB reconstructs a commission on every cycle and an `exact`-only filter would leave its chart permanently empty.

alter table trade_archive
  add column if not exists fee_basis text not null default 'unknown';

alter table equity_snapshots
  add column if not exists fee_basis text not null default 'unknown';

-- Refuse to apply if any row claims the writer valued every commission while carrying no fee evidence at all. That pairing is a self-contradiction, and the first arm of the rule below resolves it silently in favour of `exact` — permanently certifying a row nothing ever valued.
--
-- Both halves of "no evidence" are checked, because arm 2 names both and arm 1 shadows both. An empty `fees` body is one; an empty `orders` array is the other, and `resolveFeesFromTrades` requires `expectedOrders.length > 0` before it can report a complete total, so no writer can produce that pairing honestly either.
--
-- Deliberately NOT "refuse if a complete row did not land exact": arm 1 certifies every complete row unconditionally, so such a guard would sit behind its own gate and could never fire. This predicate is the contradiction arm 1 hides from arm 2, and it fires. Zero rows match on the live database today.
do $$
declare
  n bigint;
begin
  select count(*) into n
    from trade_archive
   where fees_quote_complete
     and (fees = '{}'::jsonb or orders = '[]'::jsonb);
  if n > 0 then
    raise exception 'refusing to convert fee evidence: % rows claim complete fee accounting with no fee body or no archived orders', n;
  end if;
end $$;

update trade_archive
   set fee_basis = case
     when fees_quote_complete then 'exact'
     when orders = '[]'::jsonb or fees = '{}'::jsonb then 'unknown'
     -- The two certifying arms may only overrule a `false` that carries no information. 0090 added the marker with `default false` and no backfill, so on an older row `false` means the question was never asked and the stored body is the only evidence there is. A row whose order summaries carry the `baseCommissionNetted` key was written by a later writer, and that writer sets the marker false only after finding a real gap: an order `getMyTrades` never returned, fill totals that did not reconcile, an unproven base BUY. Its `fees_quote` still accumulates from the legs that DID match, so the body can look perfectly self-consistent while a whole order's commission is missing from it. Shape must not outrank a writer that looked and said no.
     when not exists (select 1 from jsonb_array_elements(orders) o where o ? 'baseCommissionNetted')
      and (select bool_and(value::numeric = 0) from jsonb_each_text(fees))
      and fees_quote = 0 then 'exact'
     when not exists (select 1 from jsonb_array_elements(orders) o where o ? 'baseCommissionNetted')
      and fees - quote_asset = '{}'::jsonb
      and fees_quote = coalesce((fees->>quote_asset)::numeric, 0) then 'exact'
     when fees_quote > coalesce((fees->>quote_asset)::numeric, 0) then 'estimated'
     when fees - quote_asset - base_asset = '{}'::jsonb
      and fees_quote = coalesce((fees->>quote_asset)::numeric, 0) then 'estimated'
     else 'unknown'
   end;

update equity_snapshots
   set fee_basis = case when fees_quote_complete then 'exact' else 'unknown' end;

-- Text plus a named CHECK rather than a native enum, matching `trade_archive_source_chk`. A native enum gains a value only through its own migration, and `alter type ... add value` cannot run in the same transaction as the rows that would use it.
alter table trade_archive
  add constraint trade_archive_fee_basis_chk check (fee_basis in ('exact', 'estimated', 'unknown'));

alter table equity_snapshots
  add constraint equity_snapshots_fee_basis_chk check (fee_basis in ('exact', 'estimated', 'unknown'));

-- `fees_quote_complete` is deliberately NOT dropped here. This migration is the EXPAND half of an expand/contract pair; the contract half belongs in a later DEPLOY, not merely a later migration file, and shipping both together would defeat it.
--
-- On the live cluster the migrate hook is an Argo CD Job at `sync-wave: "1"` and the Deployment is at `"2"`, so every migration in a release commits a full wave BEFORE any pod is replaced, with the pre-release pod still serving under `SKIP_MIGRATIONS=1`. Dropping a column here therefore removes it out from under running code by construction. `strategy: Recreate` does not save it: Recreate orders pod-vs-pod, never migration-vs-pod. That exact reasoning appeared in 0091, and on 2026-08-25 it dropped `profile_symbols.reserve_base_quantity` under the live pod and dead-lettered 178 tick jobs in a 7.7 second burst. Drizzle emits explicit column lists, so a pre-0093 image selects `fees_quote_complete` by name and 42703s on every trade_archive and equity_snapshots read — here that would span the dashboard route, the archive router, the equity-snapshot cron and the archive insert path, which dead-letters.
--
-- Leaving the column costs nothing until then: it is `not null default false`, so inserts from the new code, which no longer names it, keep satisfying it. Once no pre-0093 image can be rolled back to, a contract migration drops it from both tables.
