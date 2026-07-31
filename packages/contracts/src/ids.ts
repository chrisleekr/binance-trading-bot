// Branded UUID types. The brand exists only at the type level; the runtime
// value is a plain string. Construct via the helper to mark a UUID at the
// trust boundary; downstream code only ever sees the branded type.

declare const _brand: unique symbol;

type Brand<T extends string> = string & { readonly [_brand]: T };

/** Identifies the operator (the human/login identity; same UUID as the Better Auth user). Branded so it cannot be mixed with an `AccountId` or `ProfileId`. */
export type UserId = Brand<'UserId'>;
/** Identifies a Binance account under an operator (own keys, one user-data stream, one environment). Distinct from `UserId` so operator-keyed and account-keyed data cannot be confused. */
export type AccountId = Brand<'AccountId'>;
/** Identifies a strategy profile under an `AccountId`. Account-scoped repos require this brand to refuse cross-tenant access. */
export type ProfileId = Brand<'ProfileId'>;
/** Identifies a notifier binding for a profile (e.g. one Slack webhook). */
export type ProfileNotifierId = Brand<'ProfileNotifierId'>;

/**
 * Strip any branded id back to its raw `string` at a boundary (a log context,
 * an interpolated Redis/job key). The named, greppable inverse of the `as*Id`
 * constructors: it quarantines the single brand-defeating cast in one reviewed
 * place instead of every call site re-inventing `id as unknown as string`. The
 * `Brand<string>` parameter accepts any id brand but rejects a plain `string`,
 * so it cannot be misused to launder an unbranded value.
 */
export const unwrapId = (id: Brand<string>): string => id as unknown as string;

// Only the brands crossing a real trust boundary get a constructor. Every other
// brand is produced by Drizzle's `$inferSelect` at the row boundary, where the
// type is already correct and a hand-written cast would add nothing. Reintroduce
// an `as*Id` when a concrete call site needs to mark a raw string.

/** Marks a raw UUID string as a {@link UserId} at the trust boundary; no validation. Callers must have already checked shape. */
export const asUserId = (v: string): UserId => v as UserId;
/** Marks a raw UUID string as an {@link AccountId}. Same trust-boundary contract as {@link asUserId}. */
export const asAccountId = (v: string): AccountId => v as AccountId;
/** Marks a raw UUID string as a {@link ProfileId}. Same trust-boundary contract as {@link asUserId}. */
export const asProfileId = (v: string): ProfileId => v as ProfileId;
/** Marks a raw UUID string as a {@link ProfileNotifierId}. */
export const asProfileNotifierId = (v: string): ProfileNotifierId => v as ProfileNotifierId;
