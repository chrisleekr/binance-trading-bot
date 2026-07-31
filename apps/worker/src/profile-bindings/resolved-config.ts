/**
 * Profile-config scalars resolved once per tick (in `buildProfileTickContext`)
 * and threaded into the tick-path bindings build so it skips the redundant
 * `profile.findById` re-read. One shape shared by the tick context, the
 * executor bindings, and `applyAll`'s pre-resolved argument, so the three
 * cannot drift.
 *
 * `binance_mode` is deliberately absent: it is mutable and the tick context can
 * be seconds stale, so a bindings build must always read it fresh (a stale
 * test/live value would build the wrong REST client). Credentials are likewise
 * read fresh per tick and are not carried here.
 *
 * Leaf module: imports nothing, so it can be shared across the tick and
 * executor subtrees without forming an import cycle.
 */
export interface ProfileResolved {
  /**
   * Trading quote currency (e.g. USDT, BTC). Names the asset a placement
   * spends, which the executor's funding pre-flight needs: a SELL of ENAUSDT
   * spends ENA, a BUY spends USDT.
   */
  readonly quoteAsset: string;
  /** Per-account 1-minute Binance request-weight ceiling. */
  readonly weightLimit1m: number;
}
