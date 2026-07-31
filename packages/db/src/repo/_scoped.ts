import type { AccountId, ProfileId, UserId } from '@app/contracts';
import { and, eq } from 'drizzle-orm';
import { accounts } from '../schema/accounts.js';
import { profiles } from '../schema/profiles.js';
import type { Database } from './_db.js';

/**
 * Thrown when an account is not owned by the operator. Distinct class so the
 * API maps it to a 404 (not a 500) without string-matching the message.
 */
export class AccountNotOwnedError extends Error {
  constructor(
    public readonly operatorId: UserId,
    public readonly accountId: AccountId,
  ) {
    super(`account ${accountId} is not owned by operator ${operatorId}`);
    this.name = 'AccountNotOwnedError';
  }
}

/**
 * Thrown when a profile is not reachable from the operator via the named
 * account (operator owns account, account owns profile). Distinct class so
 * callers can map ownership failures to a 404 without string-matching.
 */
export class ProfileNotOwnedError extends Error {
  constructor(
    public readonly operatorId: UserId,
    public readonly accountId: AccountId,
    public readonly profileId: ProfileId,
  ) {
    super(
      `profile ${profileId} is not reachable via account ${accountId} for operator ${operatorId}`,
    );
    this.name = 'ProfileNotOwnedError';
  }
}

/**
 * Shared supertype for the two cross-profile base-asset exclusivity conflicts.
 * Both carry the conflicting profile's display name, but under different field
 * names (`ownerName` vs `siblingName`); `conflictProfileName` unifies them so a
 * consumer that only needs the name skips the `instanceof` branch. The
 * subclasses stay distinct so callers that DO care which conflict it is keep
 * their specific type.
 */
export abstract class BaseAssetConflictError extends Error {
  abstract get conflictProfileName(): string;
}

/**
 * Thrown when a base asset would be managed by a second profile under the same
 * account. The base asset is the shared wallet line — two profiles drawing on
 * one BTC balance (whether via BTCUSDT or BTCFDUSD) cannot size sells or arm
 * protective stops safely — so a base asset is managed by at most one profile
 * per account. Distinct class so the API maps it to a 409 without
 * string-matching the message.
 *
 * `symbol` carries the BASE ASSET (the clashing wallet line), kept under the
 * field name the API error-mapper and tests already duck-type on.
 */
export class SymbolOwnershipConflictError extends BaseAssetConflictError {
  constructor(
    public readonly symbol: string,
    public readonly ownerProfileId: string,
    public readonly ownerName: string,
    // 'self' when the clash is the binding profile's OWN settlement asset, not a
    // sibling's. Only selects the message — naming the operator's own profile as
    // the "owner" of a base it does not trade would be false. Fields stay identical.
    kind: 'sibling' | 'self' = 'sibling',
  ) {
    super(
      kind === 'self'
        ? `base asset ${symbol} is this profile's own settlement asset; a profile cannot ` +
            `also trade it as a base — its sells and stops would draw on the same balance it ` +
            `spends on buys`
        : `base asset ${symbol} is already managed by profile "${ownerName}" on this account; ` +
            `one base asset can be traded by only one profile per account`,
    );
    this.name = 'SymbolOwnershipConflictError';
  }

  get conflictProfileName(): string {
    return this.ownerName;
  }
}

/**
 * Thrown when a base asset a profile wants to trade is the SETTLEMENT (quote)
 * asset of another profile under the same account. That sibling funds every buy
 * out of the shared quote balance, so a profile holding the same asset as a
 * tradable base would size sells and arm stops against a balance the sibling
 * silently spends. This is the mirror image of {@link SymbolOwnershipConflictError}
 * (which blocks two profiles trading one base): together they keep a single
 * shared-wallet line owned by at most one profile, whether it is spent as a base
 * or as a quote. Distinct class so the API maps it to a 409 without
 * string-matching the message.
 *
 * `symbol` carries the BASE ASSET (the clashing wallet line), kept under the
 * field name the API error-mapper and tests already duck-type on.
 */
export class SiblingQuoteConflictError extends BaseAssetConflictError {
  constructor(
    public readonly symbol: string,
    public readonly siblingProfileId: string,
    public readonly siblingName: string,
  ) {
    super(
      `base asset ${symbol} is the settlement asset of profile "${siblingName}" on this account; ` +
        `trading it would draw on that profile's shared wallet, so it cannot be added here`,
    );
    this.name = 'SiblingQuoteConflictError';
  }

  get conflictProfileName(): string {
    return this.siblingName;
  }
}

/**
 * Module-private brands making the scopes nominal. Each is a real runtime
 * `Symbol` (not a `declare const unique symbol` — that variant is type-only and
 * crashes at runtime when used as a computed property key) and intentionally
 * not exported, so no consumer can synthesise a value with the brand set: a
 * hand-rolled literal is not assignable to the scope type, and a cast fails too
 * because the symbol key is not nameable outside this module. The only way to
 * land a `true` for a brand key is to receive a value from the matching
 * `scope*` constructor.
 */
const accountScopeBrand: unique symbol = Symbol('AccountScope');
const profileScopeBrand: unique symbol = Symbol('ProfileScope');

// A scope MUST NOT be serialised: `JSON.stringify` drops symbol-keyed
// properties, so a JSON-round-tripped scope would lose its brand at runtime and
// consumers would see a structural literal that compiles against the type but
// lacks the ownership proof. Treat scopes as per-request cache tokens only —
// never put one on a BullMQ payload or any other wire format. `structuredClone`
// preserves symbol keys and is fine if cloning is genuinely required.

/**
 * Account-scoped query context: the resolved `(db, operatorId, accountId)`
 * after a single ownership check (`accounts.owner_id = operatorId`). Guards
 * account-level operations that have no profile — account CRUD, api-key
 * management, profile create/list.
 *
 * Nominal via `[accountScopeBrand]: true`: a structural literal cannot satisfy
 * the type because the brand key is a module-private `unique symbol`. The only
 * constructor is {@link scopeAccount}.
 */
export interface AccountScope {
  readonly db: Database;
  readonly operatorId: UserId;
  readonly accountId: AccountId;
  readonly [accountScopeBrand]: true;
}

/**
 * Profile-scoped query context: the resolved `(db, operatorId, accountId,
 * profileId)` after a single chain check (operator owns account, account owns
 * profile). Every scoped repo function reads `scope.db` / `scope.accountId` /
 * `scope.profileId` (and `scope.operatorId` for the operator-keyed audit reads)
 * without re-threading at every callsite.
 *
 * Nominal via `[profileScopeBrand]: true`; the only constructor is
 * {@link scopeProfile}. That makes "forgot the ownership check" a compile-time
 * error at every account-scoped boundary.
 */
export interface ProfileScope {
  readonly db: Database;
  readonly operatorId: UserId;
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
  readonly [profileScopeBrand]: true;
}

/**
 * Rebinds a {@link ProfileScope} to a transactional connection. The ownership
 * check already ran on the parent scope, so this never re-checks — it swaps the
 * `db` handle for the caller's tx so scoped repo calls inside
 * `db.transaction(...)` join the same tx. Use only inside a transaction
 * callback; the returned scope shares the parent's brand.
 */
export function withTx(scope: ProfileScope, tx: Database): ProfileScope {
  return {
    db: tx,
    operatorId: scope.operatorId,
    accountId: scope.accountId,
    profileId: scope.profileId,
    [profileScopeBrand]: true,
  };
}

/**
 * Widens a {@link ProfileScope} to the {@link AccountScope} it already contains.
 * `scopeProfile` proved the whole chain (operator owns account, account owns
 * profile), so the account tier of that proof is free — no second query. This is
 * the only place the account brand may be minted from a profile proof; keeping it
 * here is what stops a caller synthesising an account scope it never earned.
 *
 * The worker needs it because order reconciliation is account-domain (a Binance
 * order id is unique per account) while the tick that drives it holds a profile
 * scope.
 */
export function toAccountScope(scope: ProfileScope): AccountScope {
  return {
    db: scope.db,
    operatorId: scope.operatorId,
    accountId: scope.accountId,
    [accountScopeBrand]: true,
  };
}

/** {@link withTx} for an {@link AccountScope}. */
export function withAccountTx(scope: AccountScope, tx: Database): AccountScope {
  return {
    db: tx,
    operatorId: scope.operatorId,
    accountId: scope.accountId,
    [accountScopeBrand]: true,
  };
}

/**
 * Resolves an {@link AccountScope} after a single `accounts` row check
 * (`accounts.id = accountId AND accounts.owner_id = operatorId`). Throws
 * {@link AccountNotOwnedError} when the operator does not own the account.
 */
export async function scopeAccount(
  db: Database,
  operatorId: UserId,
  accountId: AccountId,
): Promise<AccountScope> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.ownerId, operatorId)))
    .limit(1);
  if (rows.length === 0) {
    throw new AccountNotOwnedError(operatorId, accountId);
  }
  return { db, operatorId, accountId, [accountScopeBrand]: true };
}

/**
 * Resolves a {@link ProfileScope} after a single `accounts ⋈ profiles` join:
 * `profiles.id = profileId AND profiles.account_id = accountId AND
 * accounts.owner_id = operatorId`. This is the one and only account-ownership
 * assertion on the profile path: every scoped repo function trusts the scope it
 * receives and never re-checks, so a route or worker closure pays exactly one
 * ownership query per scope.
 *
 * Throws {@link ProfileNotOwnedError} when the chain does not hold. The returned
 * scope is a per-request cache token — pass the same scope into every scoped
 * repo call for the rest of the request; do not retain it across requests.
 */
export async function scopeProfile(
  db: Database,
  operatorId: UserId,
  accountId: AccountId,
  profileId: ProfileId,
): Promise<ProfileScope> {
  const rows = await db
    .select({ id: profiles.id })
    .from(profiles)
    .innerJoin(accounts, eq(accounts.id, profiles.accountId))
    .where(
      and(
        eq(profiles.id, profileId),
        eq(profiles.accountId, accountId),
        eq(accounts.ownerId, operatorId),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new ProfileNotOwnedError(operatorId, accountId, profileId);
  }
  // The brand key is set here, inside the module that owns the unique symbol.
  // No other file can produce a literal with this key, so this line is the
  // type-system's anchor for "ownership has been checked".
  return { db, operatorId, accountId, profileId, [profileScopeBrand]: true };
}
