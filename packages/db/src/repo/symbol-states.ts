import { and, eq, inArray } from 'drizzle-orm';
import {
  symbolStates,
  type SymbolStateInsert,
  type SymbolStateRow,
} from '../schema/symbol-states.js';
import type { ProfileScope } from './_scoped.js';

/**
 * Result of {@link casUpsert}: the persisted row on success, or `null` when the
 * optimistic-concurrency check failed (another writer advanced `version`
 * between the caller's read and this write). A `null` is not an error — the
 * caller decides whether to retry (re-read, re-apply) or skip.
 */
export type CasUpsertResult = SymbolStateRow | null;

export async function findBySymbol(
  scope: ProfileScope,
  symbol: string,
): Promise<SymbolStateRow | null> {
  const rows = await scope.db
    .select()
    .from(symbolStates)
    .where(and(eq(symbolStates.profileId, scope.profileId), eq(symbolStates.symbol, symbol)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Batched {@link findBySymbol}: the state rows for `symbols` under the profile,
 * in one query. At most one row per symbol (the table is unique on
 * `(profileId, symbol)`); a symbol with no row is simply absent from the result,
 * so callers build a per-symbol map. Empty `symbols` → `[]`.
 */
export async function findBySymbols(
  scope: ProfileScope,
  symbols: readonly string[],
): Promise<SymbolStateRow[]> {
  if (symbols.length === 0) return [];
  return scope.db
    .select()
    .from(symbolStates)
    .where(
      and(eq(symbolStates.profileId, scope.profileId), inArray(symbolStates.symbol, [...symbols])),
    );
}

export async function listForProfile(scope: ProfileScope): Promise<SymbolStateRow[]> {
  return scope.db.select().from(symbolStates).where(eq(symbolStates.profileId, scope.profileId));
}

/**
 * Atomic two-column upsert. Writes `state` and `strategy_version` together so
 * the schema-version stamp and the state body cannot drift — the lockstep
 * contract that `profiles.state` / `profiles.strategy_version` enforced
 * before this refactor, now scoped per (profile, symbol).
 */
export async function upsert(
  scope: ProfileScope,
  symbol: string,
  input: Omit<SymbolStateInsert, 'profileId' | 'symbol'>,
): Promise<SymbolStateRow> {
  const [row] = await scope.db
    .insert(symbolStates)
    .values({ ...input, profileId: scope.profileId, symbol })
    .onConflictDoUpdate({
      target: [symbolStates.profileId, symbolStates.symbol],
      set: {
        state: input['state'],
        strategyVersion: input['strategyVersion'],
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error('symbol-states.upsert: insert returned no rows');
  return row;
}

/**
 * Optimistic-concurrency upsert of one (profile, symbol) slice.
 *
 * `expectedVersion` is the `version` the caller read (or `null` when it read no
 * row and is seeding a fresh slice):
 *   - `null` → `INSERT ... ON CONFLICT DO NOTHING`. Succeeds only if no row
 *     exists yet (version starts at 0); a row that appeared concurrently makes
 *     it a miss.
 *   - `N` → `UPDATE ... SET version = N + 1 WHERE version = N`. Succeeds only if
 *     `version` is still `N`; a concurrent writer that already bumped it makes
 *     it a miss.
 *
 * Returns the written row on success or `null` on a CAS miss. This is the sole
 * cross-pod-safe write of `symbol_states`; the blind {@link upsert} is retained
 * only for callers with no concurrent writer (tests, one-shot migrations).
 */
export async function casUpsert(
  scope: ProfileScope,
  symbol: string,
  input: Omit<SymbolStateInsert, 'profileId' | 'symbol' | 'version'>,
  expectedVersion: number | null,
): Promise<CasUpsertResult> {
  if (expectedVersion === null) {
    const [row] = await scope.db
      .insert(symbolStates)
      .values({ ...input, profileId: scope.profileId, symbol, version: 0 })
      .onConflictDoNothing({ target: [symbolStates.profileId, symbolStates.symbol] })
      .returning();
    return row ?? null;
  }
  const [row] = await scope.db
    .update(symbolStates)
    .set({
      state: input['state'],
      strategyVersion: input['strategyVersion'],
      version: expectedVersion + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(symbolStates.profileId, scope.profileId),
        eq(symbolStates.symbol, symbol),
        eq(symbolStates.version, expectedVersion),
      ),
    )
    .returning();
  return row ?? null;
}

export async function remove(scope: ProfileScope, symbol: string): Promise<void> {
  await scope.db
    .delete(symbolStates)
    .where(and(eq(symbolStates.profileId, scope.profileId), eq(symbolStates.symbol, symbol)));
}

/**
 * Delete every symbol's state row for the profile. Used by `switchStrategy`
 * to drop runtime state when the operator swaps a profile's strategy plugin;
 * the next tick per symbol re-materialises a fresh slice from
 * `strategy.initialState(config)`.
 */
export async function removeAllForProfile(scope: ProfileScope): Promise<void> {
  await scope.db.delete(symbolStates).where(eq(symbolStates.profileId, scope.profileId));
}
