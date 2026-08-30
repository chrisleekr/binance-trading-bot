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
import { isValuelessResidue, type PositionStateAdapter } from '@app/strategy-core';

/**
 * Outcomes the persist-side wrapper can return:
 * - `no-op` — nothing to do (ledger absent, or state already populated).
 * - `revive-from-ledger` — state.avgEntryPrice was null, ledger row exists,
 *   and the wallet backs a tradable position (wallet ≥ stepSize).
 * - `prune-phantom-ledger` — a claim exists but the wallet holds nothing, less
 *   than one stepSize (an untradeable INCREMENT), or a balance worth a rounding
 *   error of one minimum order (an untradeable VALUE); DELETE the row instead of
 *   reviving from it.
 * - `skip-schema-version` — defensive: state isn't at the expected version
 *   after migration; defer to a future boot.
 */
export type ReviveAction =
  'no-op' | 'revive-from-ledger' | 'prune-phantom-ledger' | 'skip-schema-version';

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
 * The wallet side is the WALLET TOTAL — `free + locked` as the caller parsed it, which both the increment bound and the value bound are judged against. It is deliberately NOT the strategy's reconciled `heldQuantity` — that value was just pinned FROM the wallet, so testing it cannot tell a real minimum-size position apart from a phantom claim of the same magnitude.
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
  /** The symbol's NOTIONAL order-value floor, or null to skip the value bound. */
  readonly minNotional: string | null;
  /** Latest cached quote-asset price that values the wallet against `minNotional`, or null when no ticker is cached and the value bound must be skipped rather than guessed. */
  readonly referencePrice: string | null;
  /** The strategy's `heldQuantity` as it stood BEFORE this pass's reconciler pinned it to the wallet, or null when nothing claimed a quantity. Guards the value bound against a stale wallet snapshot; null counts as valueless so a genuine external sale still prunes. */
  readonly preReconcileHeldQuantity: string | null;
}): boolean => {
  // Nothing claims a position ⇒ nothing to prune. This is the only "no" the
  // ledger row's absence may produce, and only when the STATE is silent too.
  if (input.ledgerAvgEntryPrice === null && input.stateAvgEntryPrice === null) return false;
  if (input.walletQuantity === null) return true;
  try {
    const wallet = new Decimal(input.walletQuantity);
    // The VALUE half of "does the wallet back this claim", asked of the same `free + locked` total the increment half below reads. A wallet string that would not parse never reaches here: the `new Decimal` above throws into the catch and the prune stands down. `referencePrice` and `minNotional` can still go missing on their own, and each DISARMS this bound rather than falling back, because the prune only ever DELETES, so a missing input must mean "do not act". `isValuelessResidue` rather than a bare `isBelowMinNotional`: a holding worth most of one minimum order is what a `rebalance` target weight looks like, and pruning that would delete a real cost basis.
    const price = parse(input.referencePrice);
    const minNotional = parse(input.minNotional);
    // The CLAIM has to be valueless too, exactly as the reconciler's flatten requires, and for the same reason: the wallet snapshot is read once per profile OUTSIDE the per-symbol loop, so on the Nth symbol it is several REST round trips old. A BUY that filled in that window leaves a fresh 420-unit position over a stale dust balance, and the reconciler ahead of this one has already declined to flatten it — pruning on the wallet alone would delete the same cost basis by the other door.
    //
    // The claim tested is the PRE-reconcile one. The post-reconcile `heldQuantity` is the stale wallet's own verdict written back onto state, so testing it would ask the same number twice and guard nothing. A null claim counts as valueless, matching the reconciler: a genuine external sale leaves nothing claiming a quantity, and that must still prune.
    const claim = parse(input.preReconcileHeldQuantity);
    if (
      isValuelessResidue(wallet, price, minNotional) &&
      (claim === null || isValuelessResidue(claim, price, minNotional))
    ) {
      return true;
    }
    if (input.stepSize == null) return false;
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
    // The `diff.lte(step)` band in the held-quantity reconciler remains a
    // different predicate, and this one still must not be made to match it: that
    // band measures a DIFFERENCE (|held - wallet|) and this measures an ABSOLUTE
    // holding. What DOES belong here, and was wrongly ruled out with it, is the
    // value half of the same absolute question — asked just above, before this
    // line. An increment test alone is what let the live case through: 1.18 steps
    // of a coin worth a tenth of a cent reads as a real holding to every
    // comparison on this line, and the claim on it survived every pass forever.
    return wallet.lt(step);
  } catch {
    return false;
  }
};

/**
 * @param raw - Decimal-as-string from a target, which may be absent or malformed.
 * @returns The parsed value, or null when there is nothing usable and the bound reading it must stand down.
 */
const parse = (raw: string | null | undefined): Decimal | null => {
  if (raw == null) return null;
  try {
    return new Decimal(raw);
  } catch {
    return null;
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
   * threshold: a WALLET strictly below `stepSize` is dust the strategy can
   * never sell, so a ledger row backed only by dust is phantom. When `stepSize` is
   * null the increment half stands down entirely — better to leave a real row
   * untouched than to delete a row whose quantity we cannot compare — and the
   * prune is left to the value bound and the "asset absent from the wallet
   * entirely" gate.
   */
  readonly stepSize: string | null;
  /** The symbol's NOTIONAL order-value floor from the cached exchangeInfo, or null when the symbol carries no such filter. Half of the prune's absolute test: `stepSize` says whether the balance is a tradeable INCREMENT, this says whether it is a tradeable VALUE, and a balance can clear one and fail the other by orders of magnitude. */
  readonly minNotional: string | null;
  /** Latest cached quote-asset price, used only to value the wallet against `minNotional`. Null when no ticker is cached, which skips the value bound rather than guessing — the bound only ever REMOVES a position, so a wrong price here deletes a real cost basis. */
  readonly referencePrice: string | null;
  /** The strategy's `heldQuantity` from the state body read at the START of this pass, before the held-quantity reconciler pinned it to the wallet, or null when nothing claimed a quantity. The value bound will not prune a claim that is still worth something, which is what keeps a stale once-per-profile wallet snapshot from deleting a position bought seconds ago. Required-but-nullable, not optional: an omitted field is one a forwarding hop can drop silently, and a silently-dropped bound input is how an earlier fix here shipped as a no-op. */
  readonly preReconcileHeldQuantity: string | null;
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
   * (a "phantom" row). Routed to
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
      minNotional: target.minNotional,
      referencePrice: target.referencePrice,
      preReconcileHeldQuantity: target.preReconcileHeldQuantity,
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
        minNotional: target.minNotional,
        referencePrice: target.referencePrice,
        preReconcileHeldQuantity: target.preReconcileHeldQuantity,
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
