import type { StoredDiscoveryConfig, StoredRiskConfig, UserId } from '@app/contracts';
import { and, eq } from 'drizzle-orm';
import { accounts } from '../schema/accounts.js';
import { profiles, type ProfileInsert, type ProfileRow } from '../schema/profiles.js';
import type { Database } from './_db.js';
import {
  withTx,
  SymbolOwnershipConflictError,
  type AccountScope,
  type ProfileScope,
} from './_scoped.js';
import { findOwningSiblingByBase, profileManagesBase } from './profile-symbols.js';
import { removeAllForProfile } from './symbol-states.js';

export async function findById(scope: ProfileScope): Promise<ProfileRow | null> {
  const rows = await scope.db
    .select()
    .from(profiles)
    .where(and(eq(profiles.id, scope.profileId), eq(profiles.accountId, scope.accountId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Every profile under the account (account-scoped: ownership already proven). */
export async function listForAccount(scope: AccountScope): Promise<ProfileRow[]> {
  return scope.db.select().from(profiles).where(eq(profiles.accountId, scope.accountId));
}

/**
 * Every enabled profile across all accounts, each augmented with its
 * account's `operatorId` (accounts.owner_id). The single-replica worker
 * calls this once on boot to rehydrate its in-memory WS-subscription set:
 * crash-only recovery means a restart must re-subscribe every market
 * stream from durable state, not wait for an API-driven enable event
 * (which only fires on a profile mutation). Deliberately un-scoped — the
 * worker orchestrates all accounts and there is no caller-supplied scope;
 * `operatorId` + the row's `accountId` are what the worker threads into
 * `scopeProfile` to build each per-profile scope.
 */
export async function listAllEnabled(
  db: Database,
): Promise<Array<ProfileRow & { operatorId: UserId }>> {
  const rows = await db
    .select({ profile: profiles, operatorId: accounts.ownerId })
    .from(profiles)
    .innerJoin(accounts, eq(profiles.accountId, accounts.id))
    .where(eq(profiles.enabled, true));
  return rows.map((r) => ({ ...r.profile, operatorId: r.operatorId as UserId }));
}

/** Create a profile under the account (account-scoped: ownership already proven). */
export async function insert(
  scope: AccountScope,
  input: Omit<ProfileInsert, 'accountId'>,
): Promise<ProfileRow> {
  const [row] = await scope.db
    .insert(profiles)
    .values({ ...input, accountId: scope.accountId })
    .returning();
  if (!row) throw new Error('profiles.insert: insert returned no rows');
  return row;
}

export async function setEnabled(scope: ProfileScope, enabled: boolean): Promise<void> {
  await scope.db
    .update(profiles)
    .set({ enabled })
    .where(and(eq(profiles.id, scope.profileId), eq(profiles.accountId, scope.accountId)));
}

/**
 * Write the profile's `discovery_config` jsonb (the auto-discovery settings,
 * stored outside the strategy `config` per invariant #1). The discovery cron
 * reads this column directly each tick, so no worker resync is needed. Returns
 * the updated row, or null when the profile is gone.
 */
export async function setDiscoveryConfig(
  scope: ProfileScope,
  config: StoredDiscoveryConfig,
): Promise<ProfileRow | null> {
  const [row] = await scope.db
    .update(profiles)
    .set({ discoveryConfig: config })
    .where(and(eq(profiles.id, scope.profileId), eq(profiles.accountId, scope.accountId)))
    .returning();
  return row ?? null;
}

/**
 * Write the profile's `risk_config` jsonb (the worker-side risk controls, stored
 * outside the strategy `config` per invariant #1). The portfolio-risk cron reads
 * this column directly, so no worker resync is needed. Returns the updated row,
 * or null when the profile is gone.
 */
export async function setRiskConfig(
  scope: ProfileScope,
  config: StoredRiskConfig,
): Promise<ProfileRow | null> {
  const [row] = await scope.db
    .update(profiles)
    .set({ riskConfig: config })
    .where(and(eq(profiles.id, scope.profileId), eq(profiles.accountId, scope.accountId)))
    .returning();
  return row ?? null;
}

export async function update(
  scope: ProfileScope,
  patch: Partial<
    Pick<
      ProfileInsert,
      | 'name'
      | 'enabled'
      | 'config'
      | 'quoteAsset'
      | 'benchmarkMode'
      | 'baselineBacktestRunId'
      | 'enablementPolicy'
      | 'notifyEvents'
    >
  >,
): Promise<ProfileRow | null> {
  // Editing the settlement (quote) asset is another funnel into the base-asset
  // exclusivity invariant that `profileSymbols.upsert` guards on symbol-bind: a
  // base asset is the shared wallet line, so a profile settling in Q while a
  // sibling trades Q as a base (or while THIS profile trades Q) would size sells
  // and arm stops against a balance the other side spends. Only fire when Q
  // actually changes, so re-setting the same quote never spuriously 409s.
  // Normalize the quote to upper-case ONCE, so the guard compares and the row
  // persists the same value. A direct repo caller passing lower-case would
  // otherwise store the exact mixed-case state `findSiblingQuotingBase` has to
  // defend against on the sibling's next bind.
  const normalizedPatch =
    patch.quoteAsset !== undefined
      ? { ...patch, quoteAsset: patch.quoteAsset.toUpperCase() }
      : patch;
  if (normalizedPatch.quoteAsset !== undefined) {
    const q = normalizedPatch.quoteAsset;
    const current = await findById(scope);
    if (current && current.quoteAsset.toUpperCase() !== q) {
      // CROSS-PROFILE: a sibling already trades Q as its own base line.
      const sibling = await findOwningSiblingByBase(scope.db, scope.accountId, q, scope.profileId);
      if (sibling) throw new SymbolOwnershipConflictError(q, sibling.profileId, sibling.name);
      // SELF: this profile already trades Q as a base, so settling in Q too draws
      // on the same wallet line it trades.
      if (await profileManagesBase(scope, q)) {
        throw new SymbolOwnershipConflictError(q, scope.profileId, current.name);
      }
    }
  }
  const [row] = await scope.db
    .update(profiles)
    .set(normalizedPatch)
    .where(and(eq(profiles.id, scope.profileId), eq(profiles.accountId, scope.accountId)))
    .returning();
  return row ?? null;
}

/**
 * Atomic strategy swap. Replaces strategy name+version+config+state, drops
 * every per-symbol state slice, and forces `enabled = false` so the worker
 * pauses the profile through the transition. Persistent records (orders,
 * archive) live in their own tables and are intentionally untouched. Caller
 * is responsible for pre-validating `config` against the new strategy's
 * schema and computing the matching `state` via `plugin.initialState(config)`.
 *
 * The `symbol_states` purge is not optional. That table keys on
 * `(profile_id, symbol)` and stamps only `strategy_version`, never the
 * strategy NAME, so a surviving row is indistinguishable from one written by
 * the incoming strategy. The worker's reconcile spine would hand the outgoing
 * strategy's state body to the incoming strategy and ask it to migrate from a
 * version string it has never shipped. Deleting the rows makes the next tick
 * per symbol re-seed from `strategy.initialState(config)`; the reconcile spine
 * clears the matching Redis key on the same read, so no stale cache survives.
 *
 * Both writes share one transaction: a swap that updated the profile but left
 * the slices behind is the exact corruption this guards against.
 */
export async function switchStrategy(
  scope: ProfileScope,
  next: { strategyName: string; strategyVersion: string; config: unknown; state: unknown },
): Promise<ProfileRow | null> {
  return scope.db.transaction(async (tx) => {
    await removeAllForProfile(withTx(scope, tx));
    const [row] = await tx
      .update(profiles)
      .set({
        strategyName: next.strategyName,
        strategyVersion: next.strategyVersion,
        config: next.config,
        state: next.state,
        enabled: false,
      })
      .where(and(eq(profiles.id, scope.profileId), eq(profiles.accountId, scope.accountId)))
      .returning();
    return row ?? null;
  });
}

/**
 * Atomic two-column commit of a profile's strategy-state body and the
 * version it is stamped at. The boot held-quantity reconciler routes its
 * migrated-state write here so `state` and `strategy_version` land in one
 * UPDATE and never drift. Returns the number of rows updated so the caller
 * can warn on a mid-flight profile deletion (0 rows) without the repo
 * layer owning logging. Ownership is already proven by `scope`.
 */
export async function commitState(
  scope: ProfileScope,
  state: unknown,
  strategyVersion: string,
): Promise<number> {
  const rows = await scope.db
    .update(profiles)
    .set({ state, strategyVersion })
    .where(and(eq(profiles.id, scope.profileId), eq(profiles.accountId, scope.accountId)))
    .returning({ id: profiles.id });
  return rows.length;
}

export async function deleteById(scope: ProfileScope): Promise<boolean> {
  const rows = await scope.db
    .delete(profiles)
    .where(and(eq(profiles.id, scope.profileId), eq(profiles.accountId, scope.accountId)))
    .returning({ id: profiles.id });
  return rows.length > 0;
}
