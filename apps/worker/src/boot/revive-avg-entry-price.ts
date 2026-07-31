// Boot-time revival of strategy `state.avgEntryPrice` from the
// persistent `avg_entry_prices` ledger.
//
// The fill-adopter mutates `state.avgEntryPrice` on every BUY fill so
// the tick gate sees the position. If a fill adoption was missed
// (worker crashed mid-tick, plugin migration cleared the field, or a
// manual order bypassed the adopter), the state can land at `null`
// while the ledger still carries the authoritative row from the
// original BUY. The tick gate then treats the symbol as a fresh-entry
// candidate, the force-sell branch can't fire, and the sell ladder
// is disarmed.
//
// This module runs at boot, mirroring the `reconcile-held-quantity`
// pattern: a pure decision function plus a thin persistence wrapper.
// The strategy's `position` capability owns the state schema (CLAUDE.md
// core invariant 1) — the wrapper reads `avgEntryPrice` / `heldQuantity`
// and writes them back through that capability, so the worker never
// names a field or a schema version. A `null` position view defers the
// row until the in-line migration upgrades it.

import type { Logger } from 'pino';
import { Decimal } from '@app/money';
import type { PositionStateAdapter } from '@app/strategy-core';

/**
 * Outcomes the persist-side wrapper can return:
 * - `no-op` — nothing to do (ledger absent, or state already populated).
 * - `revive-from-ledger` — state.avgEntryPrice was null, ledger row exists,
 *   and the wallet backs a tradable position (wallet ≥ stepSize).
 * - `prune-phantom-ledger` — a claim exists but the wallet holds less than one
 *   stepSize (dust) or nothing at all; DELETE the row instead of reviving from
 *   it. See #262.
 * - `skip-schema-version` — defensive: state isn't at the expected version
 *   after migration; defer to a future boot.
 */
export type ReviveAction =
  | 'no-op'
  | 'revive-from-ledger'
  | 'prune-phantom-ledger'
  | 'skip-schema-version';

export interface ReviveInput {
  /** Current `state.avgEntryPrice` (Decimal-as-string), or null when unset. */
  readonly stateAvgEntryPrice: string | null;
  /** Ledger `avgEntryPrice` (Decimal-as-string), or null when no row exists. */
  readonly ledgerAvgEntryPrice: string | null;
}

export interface ReviveResult {
  readonly action: ReviveAction;
  /** When `action === 'revive-from-ledger'`, the value to write to `state.avgEntryPrice`. Null otherwise. */
  readonly nextAvgEntryPrice: string | null;
}

/**
 * Decide whether this symbol carries a PHANTOM POSITION: something still claims
 * the bot holds the base asset, but the wallet does not back it. The claim can
 * live in either of two places, and BOTH must be cleared:
 *
 *   - the `avg_entry_prices` ledger row, which the boot revive would otherwise
 *     rehydrate into the strategy's state, and
 *   - the strategy state itself, whose in-position gate (`entryPrice !== null`)
 *     is what actually makes the strategy try to manage the position.
 *
 * Phantom claims arise when the operator sold on Binance (or transferred / dusted
 * the base asset) outside the bot: the fill-adopter never fires, so nothing clears
 * either claim.
 *
 * The decision is driven by (wallet, claim) — NOT by the ledger row's existence.
 * That distinction is the whole point. The prune's two writes (clear the state,
 * delete the ledger row) are separate and non-atomic, so a pass can land the
 * delete and lose the clear (a CAS conflict, a crash, a snapshot that read the
 * state as already-null). Gating the next pass on "is there a ledger row?" then
 * answers NO, the strategy state is never converged, and the profile is wedged
 * FOREVER — claiming a position it does not hold, arming a stop the wallet cannot
 * fund, and getting rejected by Binance on every tick until a human intervenes.
 * Observed in production. Driving from the claim instead makes recovery total and
 * idempotent: whatever a previous partial run left behind, the next run finishes.
 *
 * The wallet side is the RAW WALLET (`free + locked`) plus the symbol's
 * `stepSize`: null is a definite absence, and strictly below one `stepSize` is
 * dust the strategy cannot trade anyway. It is deliberately NOT the strategy's
 * reconciled `heldQuantity` — that value was just pinned FROM the wallet, so
 * testing it cannot tell a real minimum-size position apart from a phantom claim
 * of the same magnitude.
 *
 * Pure / Decimal-safe; never reads I/O. The persist-side wrapper owns the writes.
 *
 * KNOWN LIMITATION — cross-profile shared base asset (inherits the
 * `reconcile-held-quantity.ts` v1.0 limitation): two profiles trading
 * the same base asset (e.g. BTCUSDT under profile A, BTCETH under
 * profile B) share a single wallet line. The held-quantity reconciler
 * treats `wallet.free + locked` as belonging to the single profile
 * under inspection. v1.0 ships single-account multi-profile with a strong
 * convention that base assets do not overlap; a future v1.x fix will
 * sum sibling LBP rows before computing the per-profile share.
 */
export const isPhantomLedgerRow = (input: {
  readonly ledgerAvgEntryPrice: string | null;
  /** The strategy state's own position claim (`state.avgEntryPrice`), or null. */
  readonly stateAvgEntryPrice: string | null;
  /**
   * `free + locked` from the wallet snapshot the held-quantity reconciler already
   * read. Null when the base asset is absent from the wallet entirely.
   */
  readonly walletQuantity: string | null;
  readonly stepSize: string | null;
}): boolean => {
  // Nothing claims a position ⇒ nothing to prune. This is the only "no" the
  // ledger row's absence may produce, and only when the STATE is silent too.
  if (input.ledgerAvgEntryPrice === null && input.stateAvgEntryPrice === null) return false;
  if (input.walletQuantity === null) return true;
  if (input.stepSize === null) return false;
  try {
    const wallet = new Decimal(input.walletQuantity);
    const step = new Decimal(input.stepSize);
    if (step.lte(0)) return false;
    // Phantom means THE WALLET DOES NOT BACK THE CLAIM — so the predicate tests
    // the wallet, never the strategy's own reconciled heldQuantity (which the
    // reconciler just pinned FROM the wallet, so testing it conflates "state
    // claims one step, wallet holds none" with "state claims one step and the
    // wallet holds exactly that" — same number, opposite meanings).
    //
    // STRICT, deliberately. On many alts `minQty == stepSize`, so a wallet
    // holding exactly one step is the SMALLEST POSITION THAT CAN LEGALLY BE
    // BOUGHT: it is real, tradable, and pruning it would disarm the protective
    // stop and let the entry gate re-buy. Below one step the strategy can never
    // sell it, so it is dust and the claim on it is phantom.
    //
    // This is NOT the same predicate as the held-quantity reconciler's
    // `diff.lte(step)` no-op band, and it must not be made to match it: that band
    // measures a DIFFERENCE (|held - wallet|), this measures an ABSOLUTE holding.
    return wallet.lt(step);
  } catch {
    return false;
  }
};

/**
 * Pure decision: should `state.avgEntryPrice` be revived from the
 * ledger? Returns the next value to persist (or null when no change).
 *
 * - Ledger absent → nothing to revive (`no-op`).
 * - State already populated → trust the state (`no-op`); fill-adopter
 *   owns mutations after this boot step lands.
 * - Both populated → `no-op`; never overwrite a live state value with
 *   a stale ledger snapshot.
 * - State null + ledger present → `revive-from-ledger`.
 */
export const reviveAvgEntryPrice = (input: ReviveInput): ReviveResult => {
  if (input.ledgerAvgEntryPrice === null) {
    return { action: 'no-op', nextAvgEntryPrice: null };
  }
  if (input.stateAvgEntryPrice !== null) {
    return { action: 'no-op', nextAvgEntryPrice: null };
  }
  return { action: 'revive-from-ledger', nextAvgEntryPrice: input.ledgerAvgEntryPrice };
};

export interface ReviveTarget {
  readonly userId: string;
  readonly profileId: string;
  readonly symbol: string;
  readonly state: unknown;
  readonly ledgerAvgEntryPrice: string | null;
  /**
   * Ledger `quantity` (Decimal-as-string), or null when no row exists.
   * Used purely as an observability surface: when revival fires we
   * surface the divergence between ledger qty and the already-
   * reconciled `state.heldQuantity` so a stale ledger row is visible
   * in logs. The revival itself does not mutate ledger qty.
   */
  readonly ledgerQuantity: string | null;
  /**
   * `free + locked` for the symbol's base asset, from the same wallet snapshot the
   * held-quantity reconciler read. Null when the asset is absent from the wallet.
   *
   * The phantom prune is driven from HERE and not from the strategy's reconciled
   * `heldQuantity`: "phantom" means the wallet does not back the claim, so the
   * wallet is the thing to test.
   */
  readonly walletQuantity: string | null;
  /**
   * Symbol `stepSize` from the cached exchangeInfo, or null when the
   * caller could not resolve it. Drives the phantom-ledger prune
   * threshold (#262): a WALLET strictly below `stepSize` is dust the strategy can
   * never sell, so a ledger row backed only by dust is phantom. When `stepSize` is
   * null the prune falls back to the stricter "the asset is absent from the wallet
   * entirely" gate — better to leave a real row untouched than to delete a row
   * whose quantity we cannot compare.
   */
  readonly stepSize: string | null;
}

export interface ReviveTargetDeps {
  readonly logger: Logger;
  /**
   * Apply a per-(profile, symbol) state mutation. Production routes
   * through `mutateSymbolState` so reads + writes operate on a single
   * `symbol_states` row, sibling symbols on the same profile no longer
   * race a shared blob. The mutator returns `null` for no-op.
   */
  readonly mutate: (symbol: string, mutator: (state: unknown) => unknown | null) => Promise<void>;
  /**
   * Strategy's position capability. The reviver reads `avgEntryPrice` /
   * `heldQuantity` via {@link PositionStateAdapter.readPosition} and writes
   * via `setAvgEntryPrice` / `clearPosition`, so this module never names
   * the strategy's state fields or its schema version (core invariant #1).
   */
  readonly position: PositionStateAdapter;
  /**
   * DELETE the `avg_entry_prices` row for the given symbol. Invoked when
   * the boot reconciler proves the wallet doesn't back the ledger row
   * (a "phantom" row, see #262). Routed to
   * `scope.avgEntryPrices.remove(symbol)` in production.
   */
  readonly removeLedgerRow: (userId: string, profileId: string, symbol: string) => Promise<void>;
}

/**
 * Persistence wrapper. Schema-gates the row, runs the pure decision,
 * writes the merged state, and logs the outcome. Returns the action
 * so the orchestrator can tally a single summary line.
 *
 * `highSinceBuy` is intentionally left at its current value (null on a
 * cold-revival row). The strategy's tick handler arms the trailing
 * stop on the first tick where `currentPrice >= avgEntryPrice *
 * triggerPercentage`; pre-seeding it here would mis-state the
 * high-water mark.
 */
export const reviveAvgEntryPriceForTarget = async (
  deps: ReviveTargetDeps,
  target: ReviveTarget,
): Promise<ReviveAction> => {
  if (!target.state || typeof target.state !== 'object') {
    return 'no-op';
  }
  // The plugin owns the schema. A `null` position view means the body is
  // not the strategy's current schema after the orchestrator's in-line
  // migration — either a strategy without a current-schema state yet
  // (rare) or a migration that silently regressed. Worth investigating;
  // do not paper over.
  const view = deps.position.readPosition(target.state);
  if (view === null) {
    deps.logger.warn(
      {
        userId: target.userId,
        profileId: target.profileId,
        symbol: target.symbol,
      },
      'reviveAvgEntryPrice: state not at current strategy schema after migration; investigate',
    );
    return 'skip-schema-version';
  }
  const stateAvgEntryPrice = view.avgEntryPrice;

  // Phantom-position prune. If the WALLET is absent, or holds strictly less than
  // one stepSize, it backs NOTHING the strategy can trade — so every claim on the
  // position must go: the strategy state's (which is what makes the strategy act)
  // and the ledger row's (which would rehydrate the state on the next boot).
  // Gated on the presence of a CLAIM, not on the ledger row's existence, so a
  // previous run that deleted the row but failed to clear the state is finished
  // here rather than wedging forever.
  const reconciledHeldQuantity = view.heldQuantity;
  if (
    isPhantomLedgerRow({
      ledgerAvgEntryPrice: target.ledgerAvgEntryPrice,
      stateAvgEntryPrice,
      walletQuantity: target.walletQuantity,
      stepSize: target.stepSize,
    })
  ) {
    // Clear `state.avgEntryPrice` FIRST, then DELETE the ledger row.
    // If the mutate throws, the ledger row is still present and the
    // next boot retries cleanly. The reverse order would leave the
    // state carrying a `avgEntryPrice` value with no ledger row to
    // heal from (the next-boot revive falls into the `ledger absent`
    // no-op branch and the phantom price stays).
    //
    // Snapshot-gated: only fire the per-symbol mutate when the
    // inspected snapshot carried a populated avgEntryPrice. A null
    // snapshot means no clear is needed and the ledger DELETE below
    // is the only side effect. Production routes the mutator through
    // `mutateSymbolState`, which re-reads the live body, the
    // snapshot check here matches the legacy `applyState`-gated
    // semantics and saves a Redis/PG roundtrip on the cold-revival
    // path where the live body and the snapshot agree.
    if (stateAvgEntryPrice !== null) {
      await deps.mutate(target.symbol, (live) => deps.position.clearPosition(live));
    }
    await deps.removeLedgerRow(target.userId, target.profileId, target.symbol);
    deps.logger.info(
      {
        userId: target.userId,
        profileId: target.profileId,
        symbol: target.symbol,
        prunedAvgEntryPrice: target.ledgerAvgEntryPrice,
        prunedQuantity: target.ledgerQuantity,
        walletQuantity: target.walletQuantity,
        reconciledHeldQuantity,
        stepSize: target.stepSize,
      },
      'reviveAvgEntryPrice: pruned phantom ledger row (wallet does not back the position)',
    );
    return 'prune-phantom-ledger';
  }

  const result = reviveAvgEntryPrice({
    stateAvgEntryPrice,
    ledgerAvgEntryPrice: target.ledgerAvgEntryPrice,
  });
  if (result.action !== 'revive-from-ledger' || result.nextAvgEntryPrice === null) {
    return result.action;
  }

  const revivedAvgEntryPrice = result.nextAvgEntryPrice;
  await deps.mutate(target.symbol, (live) =>
    deps.position.setAvgEntryPrice(live, revivedAvgEntryPrice),
  );
  deps.logger.info(
    {
      userId: target.userId,
      profileId: target.profileId,
      symbol: target.symbol,
      previous: null,
      next: result.nextAvgEntryPrice,
    },
    'reviveAvgEntryPrice: revived state.avgEntryPrice from ledger',
  );
  // Surface a ledger-vs-state qty divergence so a stale ledger row is
  // observable in logs. The wallet reconciler ran first and already
  // pinned the position's heldQuantity to wallet truth; the ledger qty
  // stays un-mutated here (operator decision tracked separately) but
  // should not be invisible.
  const stateHeld = view.heldQuantity;
  if (
    target.ledgerQuantity !== null &&
    typeof stateHeld === 'string' &&
    target.ledgerQuantity !== stateHeld
  ) {
    deps.logger.warn(
      {
        userId: target.userId,
        profileId: target.profileId,
        symbol: target.symbol,
        ledgerQuantity: target.ledgerQuantity,
        stateHeldQuantity: stateHeld,
      },
      'reviveAvgEntryPrice: ledger quantity diverges from reconciled state.heldQuantity; ledger qty considered stale',
    );
  }
  return result.action;
};
