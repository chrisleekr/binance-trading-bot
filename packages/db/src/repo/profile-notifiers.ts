import type { AccountId, ProfileNotifierId } from '@app/contracts';
import { and, eq } from 'drizzle-orm';
import { accounts } from '../schema/accounts.js';
import {
  profileNotifiers,
  type ProfileNotifierInsert,
  type ProfileNotifierRow,
} from '../schema/profile-notifiers.js';
import { profiles } from '../schema/profiles.js';
import type { ProfileScope } from './_scoped.js';
import type { Database } from './_db.js';

export async function listForProfile(scope: ProfileScope): Promise<ProfileNotifierRow[]> {
  return scope.db
    .select()
    .from(profileNotifiers)
    .where(eq(profileNotifiers.profileId, scope.profileId));
}

/**
 * Every enabled notifier row across all profiles. Account-level ops alerts (a
 * dead-lettered job, an untracked order) have no owning profile, so they fan out
 * to the union of whatever the operator configured anywhere. GLOBAL (db-first,
 * cross-tenant) by design — single-account today; the caller dedups.
 */
export async function listAllEnabled(db: Database): Promise<ProfileNotifierRow[]> {
  return db.select().from(profileNotifiers).where(eq(profileNotifiers.enabled, true));
}

/**
 * Every enabled notifier belonging to ONE account, across its profiles. An ops
 * event that concerns a single account (an untracked order sits on exactly one
 * order book, owned by exactly one key pair) must reach that account's channels
 * and no others: a second account's Slack learning about the first's orders is
 * the cross-account bleed the whole isolation model exists to prevent.
 *
 * Environment narrowing falls out of this for free — an account has exactly one
 * `binance_mode` — so keying on the account is strictly stronger than keying on
 * the mode, which would still bleed between two accounts on the same env.
 *
 * Account-id-scoped, not global: the `accountId` arrives from an already-proven
 * scope (the orphan's owning account), so it bounds the read to one tenant.
 */
export async function listEnabledForAccount(
  db: Database,
  accountId: AccountId,
): Promise<ProfileNotifierRow[]> {
  const rows = await db
    .select({ notifier: profileNotifiers })
    .from(profileNotifiers)
    .innerJoin(profiles, eq(profileNotifiers.profileId, profiles.id))
    .innerJoin(accounts, eq(profiles.accountId, accounts.id))
    .where(and(eq(profileNotifiers.enabled, true), eq(accounts.id, accountId)));
  return rows.map((r) => r.notifier);
}

/**
 * Single-row lookup for the (profile, provider) pair. Backed by the
 * `profile_notifiers_profile_provider_uq` unique index, so the underlying
 * query is an index seek rather than the full table scan that
 * `listForProfile` + in-memory `.find()` would do. Returns `null` when no
 * config has been saved for that provider yet so callers can map to a 404
 * without distinguishing it from an SQL-level error.
 */
export async function findByProvider(
  scope: ProfileScope,
  provider: string,
): Promise<ProfileNotifierRow | null> {
  const rows = await scope.db
    .select()
    .from(profileNotifiers)
    .where(
      and(eq(profileNotifiers.profileId, scope.profileId), eq(profileNotifiers.provider, provider)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function insert(
  scope: ProfileScope,
  input: Omit<ProfileNotifierInsert, 'profileId'>,
): Promise<ProfileNotifierRow> {
  const [row] = await scope.db
    .insert(profileNotifiers)
    .values({ ...input, profileId: scope.profileId })
    .returning();
  if (!row) throw new Error('profile-notifiers.insert: insert returned no rows');
  return row;
}

export async function setEnabled(
  scope: ProfileScope,
  notifierId: ProfileNotifierId,
  enabled: boolean,
): Promise<void> {
  await scope.db
    .update(profileNotifiers)
    .set({ enabled })
    .where(
      and(eq(profileNotifiers.id, notifierId), eq(profileNotifiers.profileId, scope.profileId)),
    );
}

/**
 * Save the (profile, provider) config: insert on first save, replace in place
 * on subsequent saves. The `profile_notifiers_profile_provider_uq` unique
 * index lets this run as a single atomic `INSERT ... ON CONFLICT DO UPDATE`
 * — two concurrent saves on the same (profile, provider) collapse onto one
 * row instead of racing into duplicates. Secrets are stored in a separate
 * column so projection rules in `apps/api` can drop them before serialising
 * the row to the wire.
 */
export async function upsertByProvider(
  scope: ProfileScope,
  provider: string,
  input: { config: unknown; secrets: Readonly<Record<string, unknown>>; enabled: boolean },
): Promise<ProfileNotifierRow> {
  const [row] = await scope.db
    .insert(profileNotifiers)
    .values({
      profileId: scope.profileId,
      provider,
      config: input.config,
      secrets: input.secrets,
      enabled: input.enabled,
    })
    .onConflictDoUpdate({
      target: [profileNotifiers.profileId, profileNotifiers.provider],
      set: {
        config: input.config,
        secrets: input.secrets,
        enabled: input.enabled,
      },
    })
    .returning();
  if (!row) throw new Error('profile-notifiers.upsertByProvider: upsert returned no rows');
  return row;
}
