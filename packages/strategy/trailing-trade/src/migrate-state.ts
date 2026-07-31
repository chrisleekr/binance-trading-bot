import { initialTTState, TTStateSchema, type TTState } from './schema.js';

/**
 * Per-version state migration chain. Each branch performs a single hop
 * forward; the worker's `runStateMigration` loops until the strategy and
 * the stamp agree. Unknown versions throw — feeding an unrecognised state
 * row into `tick()` would silently corrupt the profile.
 *
 * Hops:
 *   - `1.0.0 → 1.1.0`: added `heldQuantity`, seeded `null`. The boot wallet
 *     reconciler populated the real value on the next boot; until then
 *     sell-sizing fell back to `wallet.free`.
 *   - `1.1.0 → 2.0.0`: storage scope changed from per-profile to
 *     per-(profile, symbol). The legacy flat blob cannot be safely sliced
 *     here because `migrateState` has no symbol input. Reset to the
 *     initial slice; the per-(profile, symbol) boot reconciler rehydrates
 *     `avgEntryPrice` (legacy 1.x rows stored it as `lastBuyPrice`) from the
 *     ledger and `heldQuantity` from the wallet on
 *     the next tick for that symbol. Greenfield latitude is sanctioned, so
 *     non-reconciled fields (`highSinceBuy`, `currentGridTradeIndex`,
 *     `autoTriggerBuyAtMs`) lose their pre-cutover values — acceptable for
 *     un-shipped code.
 */
export const migrateTTState = ({
  fromVersion,
  state,
}: {
  readonly fromVersion: string;
  readonly state: unknown;
}): TTState => {
  if (fromVersion === '1.0.0') {
    const prev = state as Record<string, unknown>;
    // Intermediate `1.1.0` shape — re-parsing against the live (2.0.0)
    // schema would reject the version literal, so the cast carries the
    // stamp the runner reads to dispatch the next hop. The runner re-
    // enters this function with `fromVersion: '1.1.0'` and the type-
    // checked branch below produces the terminal `TTState`.
    return { ...prev, schemaVersion: '1.1.0', heldQuantity: null } as unknown as TTState;
  }
  if (fromVersion === '1.1.0') {
    return TTStateSchema.parse(initialTTState());
  }
  throw new Error(`trailing-trade: no migration path from schema version "${fromVersion}"`);
};
