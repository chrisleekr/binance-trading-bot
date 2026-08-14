import { and, eq, gt, isNull, ne, notExists, sql } from 'drizzle-orm';
import type { AccountId, ProfileId, SymbolSource } from '@app/contracts';
import { avgEntryPrices } from '../schema/avg-entry-prices.js';
import { orders } from '../schema/orders.js';
import {
  profileSymbols,
  type ProfileSymbolInsert,
  type ProfileSymbolRow,
} from '../schema/profile-symbols.js';
import { profiles } from '../schema/profiles.js';
import type { Database } from './_db.js';
import {
  type ProfileScope,
  SiblingQuoteConflictError,
  SymbolOwnershipConflictError,
  withTx,
} from './_scoped.js';
import { remove as removeAvgEntryPrice } from './avg-entry-prices.js';
import { clearAllForSymbol as clearConditionsForSymbol } from './condition-states.js';
import { deletePendingForSymbol as deletePendingOverridesForSymbol } from './override-actions.js';
import { remove as removeSymbolState } from './symbol-states.js';

/**
 * Finds a sibling profile under the SAME account that already manages
 * `baseAsset`, or null. Base asset, not symbol, because the base asset IS the
 * shared wallet line: BTCUSDT and BTCFDUSD are different symbols but one BTC
 * balance, so a single owner per account protects sizing and stops.
 * Account-scoped on purpose: the exclusivity invariant spans an account's
 * profiles, so the query reaches across profile rows the caller's
 * {@link ProfileScope} does not cover. An account is one Binance account with
 * one environment, so `account_id` alone identifies the shared wallet — no
 * `binance_mode` filter is needed (profiles under distinct accounts never
 * collide).
 */
export async function findOwningSiblingByBase(
  db: Database,
  accountId: AccountId,
  baseAsset: string,
  excludeProfileId: ProfileId,
): Promise<{ profileId: string; name: string } | null> {
  const [row] = await db
    .select({ profileId: profileSymbols.profileId, name: profiles.name })
    .from(profileSymbols)
    .innerJoin(profiles, eq(profiles.id, profileSymbols.profileId))
    .where(
      and(
        eq(profileSymbols.baseAsset, baseAsset),
        eq(profiles.accountId, accountId),
        ne(profileSymbols.profileId, excludeProfileId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Finds a sibling profile under the SAME account whose SETTLEMENT (quote) asset
 * is `baseAsset`, or null. That sibling funds every buy out of the shared
 * `baseAsset` balance, so a profile adding it as a tradable base would size
 * sells and arm stops against a balance the sibling silently spends. The mirror
 * of {@link findOwningSiblingByBase}. `baseAsset` arrives exchangeInfo-uppercase
 * but `profiles.quote_asset` may be stored lower/mixed case, so the compare
 * uppercases the stored quote — a raw compare would silently miss the collision.
 */
export async function findSiblingQuotingBase(
  db: Database,
  accountId: AccountId,
  baseAsset: string,
  excludeProfileId: ProfileId,
): Promise<{ profileId: string; name: string } | null> {
  const [row] = await db
    .select({ profileId: profiles.id, name: profiles.name })
    .from(profiles)
    .where(
      and(
        eq(profiles.accountId, accountId),
        ne(profiles.id, excludeProfileId),
        eq(sql`upper(${profiles.quoteAsset})`, baseAsset),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Whether THIS profile already manages `baseAsset` as a tradable base. The
 * self-collision counterpart to {@link findOwningSiblingByBase} (which excludes
 * self): used when a profile edits its own settlement (quote) asset, since a
 * profile trading `baseAsset` while settling in it would size sells and arm
 * stops against the same shared wallet line it trades.
 */
export async function profileManagesBase(scope: ProfileScope, baseAsset: string): Promise<boolean> {
  const [row] = await scope.db
    .select({ one: sql`1` })
    .from(profileSymbols)
    .where(
      and(eq(profileSymbols.profileId, scope.profileId), eq(profileSymbols.baseAsset, baseAsset)),
    )
    .limit(1);
  return row !== undefined;
}

export async function listForProfile(scope: ProfileScope): Promise<ProfileSymbolRow[]> {
  return scope.db
    .select()
    .from(profileSymbols)
    .where(eq(profileSymbols.profileId, scope.profileId));
}

/** Resolves one symbol's stored override row so a caller can apply or display it; null when the symbol is not attached to the profile. */
export async function findForSymbol(
  scope: ProfileScope,
  symbol: string,
): Promise<ProfileSymbolRow | null> {
  const [row] = await scope.db
    .select()
    .from(profileSymbols)
    .where(and(eq(profileSymbols.profileId, scope.profileId), eq(profileSymbols.symbol, symbol)))
    .limit(1);
  return row ?? null;
}

export async function upsert(
  scope: ProfileScope,
  symbol: string,
  baseAsset: string,
  input: Omit<ProfileSymbolInsert, 'profileId' | 'symbol' | 'baseAsset'>,
): Promise<ProfileSymbolRow> {
  // Exclusivity guard: a base asset is the shared wallet line, so it is managed
  // by at most one profile per Binance account — otherwise neither profile sizes
  // a sell or arms a stop correctly off a balance the other also draws on. Two
  // halves: (1) another profile already TRADES this base (its own base line), and
  // (2) another profile SETTLES in this base (spends it as a quote to fund buys).
  // Both collide on one wallet line. Keyed on base asset (not symbol) so two quote
  // pairs over one base, e.g. BTCUSDT vs BTCFDUSD, still collide. Owns-base is
  // checked first and wins precedence. Total across the in-process bind seams
  // (discovery add, manual add, fill-adopter re-subscribe, orphan adoption) — they
  // all funnel through here. Not a DB constraint: this app-level check is the only
  // enforcement. Safe because the worker is single-replica and discovery serialises
  // per profile; a concurrent API write is the only theoretical race and is
  // operator-driven.
  const owner = await findOwningSiblingByBase(
    scope.db,
    scope.accountId,
    baseAsset,
    scope.profileId,
  );
  if (owner) throw new SymbolOwnershipConflictError(baseAsset, owner.profileId, owner.name);
  const quoter = await findSiblingQuotingBase(
    scope.db,
    scope.accountId,
    baseAsset,
    scope.profileId,
  );
  if (quoter) throw new SiblingQuoteConflictError(baseAsset, quoter.profileId, quoter.name);
  // Self half of the same invariant: the binding profile settling in `baseAsset`
  // while trading it as a base would size sells and arm stops against the very
  // wallet line it spends to fund buys. The sibling finders above exclude self, so
  // this symmetric collision needs its own check. Read this profile's stored quote
  // inline (importing profiles.ts would cycle — it imports this file). Checked last,
  // after the two sibling guards. A missing row is impossible under a valid scope,
  // so there is nothing to collide on and the insert proceeds (FK enforces existence).
  const [self] = await scope.db
    .select({ quoteAsset: profiles.quoteAsset, name: profiles.name })
    .from(profiles)
    .where(eq(profiles.id, scope.profileId))
    .limit(1);
  if (self && self.quoteAsset.toUpperCase() === baseAsset) {
    throw new SymbolOwnershipConflictError(baseAsset, scope.profileId, self.name, 'self');
  }
  const [row] = await scope.db
    .insert(profileSymbols)
    .values({ ...input, profileId: scope.profileId, symbol, baseAsset })
    .onConflictDoUpdate({
      target: [profileSymbols.profileId, profileSymbols.symbol],
      set: {
        overrideConfig: input['overrideConfig'] ?? null,
        baseAsset,
        // Only when the caller actually supplied one. The reserve is the operator's
        // ringfenced base quantity and most callers (discovery re-add, config reset)
        // never mention it — writing `?? null` here would silently clear a reserve
        // on every ordinary re-bind. A profile disposal's handoff DOES carry it, and
        // must, or the target would treat the ringfenced coins as tradeable.
        ...(input['reserveBaseQuantity'] !== undefined
          ? { reserveBaseQuantity: input['reserveBaseQuantity'] }
          : {}),
      },
    })
    .returning();
  if (!row) throw new Error('profile-symbols.upsert: insert returned no rows');
  return row;
}

/**
 * Every per-symbol row the binding owns, dropped together.
 *
 * The binding is what makes a symbol tick, and each of these tables is written
 * ONLY by that tick. Dropping the binding alone strands them: nothing runs to
 * close a `condition_states` row, revise a `symbol_states` body or consume a
 * pending override ever again. The `condition_states` half is the one that is
 * read back, so the operator is shown blockers on coins the profile does not
 * hold.
 *
 * It lives inside the two unbind functions rather than in a helper the callers
 * invoke, because a helper is what every unbind path already forgot. A caller
 * cannot drop a binding without this running.
 *
 * `avg_entry_prices` is the cost basis, and deleting it is only safe because
 * both callers have already established the position is not this profile's to
 * hold: the reap runs its flat guard in the DELETE predicate, and `remove` is
 * the operator (or a disposal handoff that has already re-pointed the ledger row
 * at its new owner) saying so explicitly.
 */
const tearDownSymbolState = async (scope: ProfileScope, symbol: string): Promise<void> => {
  await clearConditionsForSymbol(scope, symbol);
  await removeSymbolState(scope, symbol);
  await removeAvgEntryPrice(scope, symbol);
  await deletePendingOverridesForSymbol(scope, symbol);
};

/**
 * Detach a symbol from the profile and tear down everything that symbol owned,
 * in one transaction, so a crash can never leave the state without the binding
 * that explains it.
 *
 * The teardown is unconditional, not gated on a binding row having existed: the
 * disposal handoff calls this for a position whose binding was already lost
 * while it was open (a ledger row with no binding), and that row is exactly what
 * must not be left behind.
 *
 * What does NOT ride along: the profile's Redis keys and the dashboard
 * aggregate cache. Both are api-side concerns and are handled by the DELETE
 * route; the discovery reap deliberately imports nothing but `@app/db`.
 */
export async function remove(scope: ProfileScope, symbol: string): Promise<void> {
  await scope.db.transaction(async (tx) => {
    const txScope = withTx(scope, tx);
    await tx
      .delete(profileSymbols)
      .where(and(eq(profileSymbols.profileId, scope.profileId), eq(profileSymbols.symbol, symbol)));
    await tearDownSymbolState(txScope, symbol);
  });
}

/**
 * Flip a symbol's discovery source. The "Pin" operator action calls this with
 * `'manual'` so discovery stops reaping a coin it rotated in; discovery sets
 * `'auto'` when it rotates one in. Idempotent — pinning an already-
 * manual symbol is a no-op flip. Returns the updated row, or null when the
 * symbol is not attached to the profile.
 */
export async function setSource(
  scope: ProfileScope,
  symbol: string,
  source: SymbolSource,
): Promise<ProfileSymbolRow | null> {
  const [row] = await scope.db
    .update(profileSymbols)
    .set({ source })
    .where(and(eq(profileSymbols.profileId, scope.profileId), eq(profileSymbols.symbol, symbol)))
    .returning();
  return row ?? null;
}

/**
 * Set (or clear with `null`) a symbol's reserve floor — the base-asset quantity
 * the bot must never sell below. Targeted UPDATE so it never disturbs the stored
 * `override_config` (the generic {@link upsert} resets that column on conflict).
 * Returns the updated row, or null when the symbol is not attached to the
 * profile, which the caller maps to a 404. Mirrors {@link setSource}.
 */
export async function setReserve(
  scope: ProfileScope,
  symbol: string,
  reserveBaseQuantity: string | null,
): Promise<ProfileSymbolRow | null> {
  const [row] = await scope.db
    .update(profileSymbols)
    .set({ reserveBaseQuantity })
    .where(and(eq(profileSymbols.profileId, scope.profileId), eq(profileSymbols.symbol, symbol)))
    .returning();
  return row ?? null;
}

/**
 * Stamp the symbol's last-flatten time. Called whenever a position is taken to
 * cash (discovery drop OR manual eject) so the discovery re-add hysteresis
 * cooldown can suppress an immediate rotation back in. Returns the updated row,
 * or null when the symbol is not attached to the profile.
 */
export async function recordFlatten(
  scope: ProfileScope,
  symbol: string,
  at: Date,
): Promise<ProfileSymbolRow | null> {
  const [row] = await scope.db
    .update(profileSymbols)
    .set({ lastFlattenAt: at })
    .where(and(eq(profileSymbols.profileId, scope.profileId), eq(profileSymbols.symbol, symbol)))
    .returning();
  return row ?? null;
}

/**
 * Outcome of a discovery-initiated symbol removal. `removed` is the only
 * success case; the rest tell the caller WHY the row was left in place so the
 * discovery cron can log and skip without re-deriving the reason.
 */
export type DiscoveryRemoveOutcome = 'removed' | 'not-found' | 'not-auto' | 'held';

/**
 * Remove an auto-discovered symbol only when it is safe to abandon: the row
 * must be discovery-owned (`source='auto'`) AND flat, meaning zero held
 * quantity and no open orders. Discovery never force-exits a position: a held
 * symbol stays subscribed until the strategy's own exit flattens it, and a
 * later cycle reaps it. A manual symbol, a missing row, or one still carrying a
 * position / resting order is left untouched.
 *
 * The flatness check rides inside the DELETE predicate, so the guard and the
 * delete are one atomic statement. There is no window for a concurrent fill or
 * order write (the executor runs in the same process) to slip a position in
 * after a flatness read but before the delete. A no-op delete then needs a
 * single read to name the reason, which gates nothing and so carries no race.
 *
 * A reap that fires takes the symbol's per-symbol state with it, in the same
 * transaction: `condition_states`, `symbol_states`, `avg_entry_prices` and the
 * pending `override_actions`. That is load-bearing here rather than incidental,
 * because the guard SELECTS FOR leaked state. A symbol is flat precisely when
 * something blocked it from entering, and that blocker is an open condition row
 * which nothing but its own tick can ever close. Every refusing outcome leaves
 * all four surfaces untouched: the symbol is still bound and still ticking.
 *
 * What does NOT ride along: the profile's Redis keys and the dashboard
 * aggregate cache. Both stay with the api's DELETE route. The reap cron is a
 * leaf that imports only `@app/db` types, and the Redis wipe lives in the api,
 * so pulling either of them down here reintroduces a boot-context cycle. The
 * reaped symbol's cached keys expire on their own TTL.
 */
export async function removeAutoIfFlat(
  scope: ProfileScope,
  symbol: string,
): Promise<DiscoveryRemoveOutcome> {
  return scope.db.transaction(async (tx) => {
    const txScope = withTx(scope, tx);
    const deleted = await tx
      .delete(profileSymbols)
      .where(
        and(
          eq(profileSymbols.profileId, scope.profileId),
          eq(profileSymbols.symbol, symbol),
          eq(profileSymbols.source, 'auto'),
          notExists(openOrderSubquery(txScope, symbol)),
          notExists(heldQuantitySubquery(txScope, symbol)),
        ),
      )
      .returning({ symbol: profileSymbols.symbol });
    if (deleted.length > 0) {
      // Guarded on the DELETE having fired, so a refusal cannot wipe the state
      // of a symbol that is still bound.
      await tearDownSymbolState(txScope, symbol);
      return 'removed';
    }
    // Nothing deleted: classify why for the caller's log.
    const row = await findForSymbol(txScope, symbol);
    if (!row) return 'not-found';
    if (row.source !== 'auto') return 'not-auto';
    return 'held';
  });
}

/**
 * Correlated subquery for a strictly-positive held quantity. Compared in SQL
 * (`quantity > 0`) so the decimal-string quantity never round-trips through a
 * JS number. Used inside the `removeAutoIfFlat` DELETE predicate.
 */
const heldQuantitySubquery = (scope: ProfileScope, symbol: string) =>
  scope.db
    .select({ one: sql`1` })
    .from(avgEntryPrices)
    .where(
      and(
        eq(avgEntryPrices.profileId, scope.profileId),
        eq(avgEntryPrices.symbol, symbol),
        gt(avgEntryPrices.quantity, '0'),
      ),
    );

/** Correlated subquery for an open order (`closed_at is null`) on the symbol. */
const openOrderSubquery = (scope: ProfileScope, symbol: string) =>
  scope.db
    .select({ one: sql`1` })
    .from(orders)
    .where(
      and(
        eq(orders.profileId, scope.profileId),
        eq(orders.symbol, symbol),
        isNull(orders.closedAt),
      ),
    );
