-- Clear the per-symbol state, open condition rows, and closed-out ledger rows written for symbols a profile was never bound to.
--
-- Every profile on a shared Binance account receives every execution report from the account's single user-data stream. The ownership gate resolved that from the `orders` row, which is written only after the REST placement returns — while Binance pushes the report before it. In that window no row existed for anyone, so the gate told EVERY profile the order was its own, and each one was enqueued for a tick on a symbol it does not trade. A tick writes state, so the sibling accumulated rows for the placing profile's coins: live evidence shows a BTC-quote profile bound to 4 symbols holding rows for 24 USDT symbols, rewritten up to 66 times, carrying `entryBlocker: technicals-no-signal`.
--
-- The code fix (a placement-ownership marker consulted while the row is uncommitted) only stops new rows. This is the one-time repair of the rows already written.
--
-- All three statements are 0083's, re-run for the rows created SINCE it by a different cause; the second also gains a `heldQuantity` guard. Idempotent for the same reason 0083 was: each deletes only what has no binding, so a re-run finds nothing.
--
-- BOTH halves are needed, and the condition half is the one the operator can SEE. A leaked tick did not write `symbol_states` alone: the same commit upserts a `condition_states` row per (profile, symbol), and such a row is closed only by the owning tick writing a null code — which a symbol that will never tick again can never receive. `profile-symbols.ts` says it in the repo's own words: the `condition_states` half is the one that is read back, so the operator is shown blockers on coins the profile does not hold. That the leaked rows carry `entryBlocker` is what proves this half exists.

-- `symbol <> ''` exempts the profile-level subject. It is a sentinel, not a symbol (the primary key spans `symbol`, and Postgres forbids a nullable primary-key column), so it has no binding to resolve against and never had.
delete from condition_states cs
 where cs.symbol <> ''
   and not exists (
     select 1 from profile_symbols ps
      where ps.profile_id = cs.profile_id and ps.symbol = cs.symbol
   );

-- Paired with the `avg_entry_prices` rule, inherited from 0083: a ledger row claiming a position is kept, and the state body is the only place that position carries a price. Deleting one without the other leaves a ledger row no state body prices, which is precisely what `dispose_profile` refuses to hand off over — it checks EVERY ledger row, not just bound ones, so the profile could never be disposed again. The two surfaces are swept together or not at all.
--
-- "Holds no position" is asserted twice, against two independent surfaces, because a leaked row and a legitimately-held one are indistinguishable by binding alone: the ledger row in `avg_entry_prices`, and the state body's own `heldQuantity` — the one position field every strategy declares (`trailing-trade`, `momentum` and `rebalance` all carry it; the entry-price field name differs between them, so it cannot be the discriminator).
--
-- The `heldQuantity` test is a regex, deliberately NOT a `::numeric` cast. A cast is a partial function: one malformed body aborts the whole migration transaction and wedges the deploy. A regex is total, so it cannot.
--
-- It matches what a FLAT quantity looks like, rather than excluding what a held one looks like, because only the positive form errs toward keeping: a body the pattern does not recognise — garbage, an exponent — fails the match and the row survives. The inverse spelling (`!~ '[1-9]'`) reads as equivalent and is not: a body with no digits at all satisfies it, so the row this cannot read would be the row it deletes. That is the wrong direction for a one-shot delete, and the sibling test pins it.
--
-- NULL is deliberately on the DELETE side, and it is not an exception to the paragraph above: it is not an unreadable value, it is the schema's explicit statement that the profile holds nothing. `TTStateSchema` declares `heldQuantity: z.string().nullable().default(null)`, and `initialTTState()` parses `{schemaVersion}` alone, so a state seeded by a tick that never held a base asset carries JSON null — which is the shape of nearly every row this migration exists to purge. `->>` also yields SQL NULL for a key that is absent entirely, and the same reading applies. Do NOT "simplify" this branch away on the grounds that the regex already covers it: `NULL ~ '…'` evaluates to NULL, not true, so the WHERE clause would exclude the row and keep it. That would make this migration strictly WEAKER than 0083, whose `symbol_states` statement carried no `heldQuantity` condition at all and therefore deleted these rows. This guard may only ever subtract deletions that represent a real position CLAIM, and a null is the absence of one. An empty string is treated the same way and by the regex rather than this branch (every quantifier matches zero characters): '' is no more a claim to a position than null is.
delete from symbol_states ss
 where not exists (
   select 1 from profile_symbols ps
    where ps.profile_id = ss.profile_id and ps.symbol = ss.symbol
 )
   and not exists (
     select 1 from avg_entry_prices ae
      where ae.profile_id = ss.profile_id and ae.symbol = ss.symbol and ae.quantity > 0
   )
   and (
     ss.state->>'heldQuantity' is null
     or ss.state->>'heldQuantity' ~ '^[-+]?0*[.]?0*$'
   );

-- The other half of the pairing the statement above depends on, and it is REQUIRED, not optional. That statement keeps a state row whose ledger row claims a position, which leaves the mirror case: an unbound symbol whose ledger row reads zero fails that `quantity > 0` guard, so its state row is deleted and the zero-quantity ledger row is left behind with nothing to price it. That is precisely the orphan pair the comment above says must never exist, and it is not benign — `assertTargetSeeded` in the dispose-profile handler iterates EVERY ledger row with no quantity filter and throws when the matching state row is missing or unpriced, so the pair wedges any later handoff disposal into that profile permanently. Nothing repairs it: the boot reconciler visits bound symbols only. 0083 avoided it by carrying this statement, and dropping it here would reintroduce the very defect this file inherits its pairing rule from.
--
-- Zero-quantity rows only, exactly as 0083 had it. A positive quantity is the durable claim that the operator still holds those coins, and it is the sole surviving cost basis for them: deleting it would make the position unpriced, and no repair can invent an entry price back. Such a row is reported by the orphan-position surfaces and re-adopted when the symbol is bound again, so it is left to that path.
delete from avg_entry_prices ae
 where ae.quantity <= 0
   and not exists (
     select 1 from profile_symbols ps
      where ps.profile_id = ae.profile_id and ps.symbol = ae.symbol
   );
