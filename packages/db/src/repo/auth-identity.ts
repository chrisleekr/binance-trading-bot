import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { account, session, user, verification } from '../schema/better-auth.js';
import { oauthAccessToken, oauthConsent, oauthRefreshToken } from '../schema/better-auth-oauth.js';
import { authSecuritySettings } from '../schema/auth-security-settings.js';
import type { Database } from './_db.js';

// The only sanctioned direct access to Better Auth's tables. Better Auth owns their writes during sign-in; these functions cover what it offers no API for: counting the single operator, recovery from the command line, and revoking everything at once. Each is operator-wide because the deployment has exactly one operator.

/**
 * Counts sign-in users. The single-operator gates read this rather than the domain `users` table, because the Better Auth row is the one that can sign in; the two can diverge when the post-create hook fails.
 *
 * @param db - Database handle.
 * @returns The number of rows in Better Auth's user table (0 or 1 under migration 0097).
 */
export async function countUsers(db: Database): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(user);
  return row?.n ?? 0;
}

/**
 * The sole sign-in user, when one exists.
 *
 * @param db - Database handle.
 * @returns Its id, email and display name, or null before onboarding.
 */
export async function findSoleUser(
  db: Database,
): Promise<{ id: string; email: string; name: string | null } | null> {
  const rows = await db
    .select({ id: user.id, email: user.email, name: user.name })
    .from(user)
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The provider ids linked to a user (`credential` for a password, `oidc` for single sign-on).
 *
 * @param db - Database handle.
 * @param userId - Better Auth user id.
 * @returns Distinct provider ids; a credential row without a stored hash is excluded because it cannot sign in.
 */
export async function listSignInProviders(db: Database, userId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ providerId: account.providerId })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        sql`(${account.providerId} <> 'credential' or ${account.password} is not null)`,
      ),
    );
  return rows.map((r) => r.providerId);
}

/**
 * Sets or creates the password credential for a user, mirroring Better Auth's own set-password path: the credential identity is `(credential, userId)`, which is what password sign-in looks up.
 *
 * @param db - Database handle, typically a transaction.
 * @param userId - Better Auth user id.
 * @param passwordHash - Hash produced by Better Auth's `hashPassword`.
 * @returns True when a new credential row was created, false when an existing one was updated.
 */
export async function upsertPasswordCredential(
  db: Database,
  userId: string,
  passwordHash: string,
): Promise<boolean> {
  const updated = await db
    .update(account)
    .set({ password: passwordHash, updatedAt: sql`now()` })
    .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')))
    .returning({ id: account.id });
  if (updated.length > 0) return false;
  await db.insert(account).values({
    id: crypto.randomUUID(),
    userId,
    providerId: 'credential',
    accountId: userId,
    password: passwordHash,
  });
  return true;
}

/**
 * The email the identity provider last reported for a user's single sign-on identity, so the operator can see which provider account is linked.
 *
 * @param db - Database handle.
 * @param userId - Better Auth user id.
 * @returns The email, or null when no identity is linked or it was linked before the email was recorded.
 */
export async function findSingleSignOnEmail(db: Database, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ providerEmail: account.providerEmail })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'oidc')))
    .limit(1);
  return row?.providerEmail ?? null;
}

/**
 * Records the email the identity provider reported at a single sign-on sign-in. Better Auth does not rewrite an existing identity on sign-in, so without this an address changed at the provider, or an identity linked before the column existed, would show stale or nothing.
 *
 * @param db - Database handle.
 * @param userId - Better Auth user id.
 * @param providerEmail - The `email` claim of the verified ID token.
 * @returns Nothing; a user with no single sign-on identity is left unchanged.
 */
export async function recordSingleSignOnEmail(
  db: Database,
  userId: string,
  providerEmail: string,
): Promise<void> {
  await db
    .update(account)
    .set({ providerEmail, updatedAt: sql`now()` })
    .where(and(eq(account.userId, userId), eq(account.providerId, 'oidc')));
}

/**
 * Removes every single sign-on identity from a user, for recovery when the identity provider changed and the old link can no longer sign in.
 *
 * @param db - Database handle.
 * @param userId - Better Auth user id.
 * @returns How many identities were removed.
 */
export async function deleteSingleSignOnIdentities(db: Database, userId: string): Promise<number> {
  const rows = await db
    .delete(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'oidc')))
    .returning({ id: account.id });
  return rows.length;
}

/**
 * Deletes every session of a user.
 *
 * @param db - Database handle.
 * @param userId - Better Auth user id.
 * @returns How many sessions were deleted.
 */
export async function deleteAllSessions(db: Database, userId: string): Promise<number> {
  const rows = await db
    .delete(session)
    .where(eq(session.userId, userId))
    .returning({ id: session.id });
  return rows.length;
}

/**
 * Deletes one session, scoped to its owner so an id from another user can never match.
 *
 * @param db - Database handle.
 * @param userId - Better Auth user id that must own the session.
 * @param sessionId - Session row id (not its token).
 * @returns True when a session was deleted.
 */
export async function deleteSession(
  db: Database,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const rows = await db
    .delete(session)
    .where(and(eq(session.userId, userId), eq(session.id, sessionId)))
    .returning({ id: session.id });
  return rows.length > 0;
}

/**
 * Deletes every session of a user except the listed ones.
 *
 * @param db - Database handle.
 * @param userId - Better Auth user id.
 * @param keepSessionIds - Sessions to keep, normally the caller's own.
 * @returns How many sessions were deleted.
 */
export async function deleteSessionsExcept(
  db: Database,
  userId: string,
  keepSessionIds: readonly string[],
): Promise<number> {
  const all = await db.select({ id: session.id }).from(session).where(eq(session.userId, userId));
  const doomed = all.map((r) => r.id).filter((id) => !keepSessionIds.includes(id));
  if (doomed.length === 0) return 0;
  const rows = await db
    .delete(session)
    .where(and(eq(session.userId, userId), inArray(session.id, doomed)))
    .returning({ id: session.id });
  return rows.length;
}

/**
 * A user's live sessions, newest activity first, without their tokens.
 *
 * @param db - Database handle.
 * @param userId - Better Auth user id.
 * @returns Session metadata only; the token column is never selected.
 */
export async function listSessions(db: Database, userId: string) {
  return db
    .select({
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      securityEpoch: session.securityEpoch,
      signInMethod: session.signInMethod,
      interactiveAuthenticatedAt: session.interactiveAuthenticatedAt,
    })
    .from(session)
    .where(eq(session.userId, userId))
    .orderBy(sql`${session.updatedAt} desc`);
}

/**
 * Revokes every AI agent grant of a user. A password change alone leaves these valid, so an intruder who authorized an agent would keep trading authority without this.
 *
 * Deleting rows is not enough on its own: an agent's access token is a signed JWT that the agent endpoint checks by signature and expiry, and it is never stored, so one already issued stays valid until it expires. The cutoff stamped here is what ends those; the agent endpoint refuses any token issued before it. Both happen in this one call so no caller can do half.
 *
 * @param db - Database handle, typically a transaction.
 * @param userId - Better Auth user id.
 * @param at - The cutoff; tokens issued before it are refused.
 * @returns How many stored rows of each kind were removed. Already issued access tokens are not counted, because they have no row.
 */
export async function revokeAgentAccess(
  db: Database,
  userId: string,
  at: Date,
): Promise<{ accessTokens: number; refreshTokens: number; consents: number }> {
  await db
    .update(authSecuritySettings)
    .set({ agentAccessNotBefore: at, updatedAt: sql`now()` })
    .where(eq(authSecuritySettings.id, 1));
  const accessTokens = await db
    .delete(oauthAccessToken)
    .where(eq(oauthAccessToken.userId, userId))
    .returning({ id: oauthAccessToken.id });
  const refreshTokens = await db
    .delete(oauthRefreshToken)
    .where(eq(oauthRefreshToken.userId, userId))
    .returning({ id: oauthRefreshToken.id });
  const consents = await db
    .delete(oauthConsent)
    .where(eq(oauthConsent.userId, userId))
    .returning({ id: oauthConsent.id });
  return {
    accessTokens: accessTokens.length,
    refreshTokens: refreshTokens.length,
    consents: consents.length,
  };
}

/**
 * Removes expired single sign-on and verification state. Each single sign-on start writes one row and nothing else removes it.
 *
 * @param db - Database handle.
 * @param now - The cutoff; rows that expired before it are deleted.
 * @returns How many rows were deleted.
 */
export async function pruneExpiredVerifications(db: Database, now: Date): Promise<number> {
  const rows = await db
    .delete(verification)
    .where(lt(verification.expiresAt, now))
    .returning({ id: verification.id });
  return rows.length;
}

/**
 * Records activity on a session: moves its last-activity time and pushes its stored expiry forward. Done by the session resolver instead of Better Auth's own refresh so the idle timeout can be checked against the previous activity time first.
 *
 * @param db - Database handle.
 * @param userId - Better Auth user id that owns the session.
 * @param sessionId - Session row id.
 * @param now - The activity time.
 * @param expiresAt - The new stored expiry.
 * @returns Nothing.
 */
export async function touchSession(
  db: Database,
  userId: string,
  sessionId: string,
  now: Date,
  expiresAt: Date,
): Promise<void> {
  await db
    .update(session)
    .set({ updatedAt: now, expiresAt })
    .where(and(eq(session.userId, userId), eq(session.id, sessionId)));
}

/**
 * Moves one session onto a security epoch. A password change raises the epoch so every older session and known-device mark stops counting, but Better Auth has already issued the operator's own browser a replacement session under the old epoch; this re-stamps that one session so it survives. It is keyed by the session token Better Auth returned rather than by user, so a session someone else created in the same moment stays on the old epoch and is refused.
 *
 * @param db - Database handle, typically the transaction that raised the epoch.
 * @param userId - Better Auth user id that must own the session.
 * @param sessionToken - The session token Better Auth returned for the replacement session, which identifies exactly that row.
 * @param epoch - The security epoch the session is moved to.
 * @returns True when the session was found and re-stamped.
 */
export async function setSessionEpochByToken(
  db: Database,
  userId: string,
  sessionToken: string,
  epoch: number,
): Promise<boolean> {
  const rows = await db
    .update(session)
    .set({ securityEpoch: epoch })
    .where(and(eq(session.userId, userId), eq(session.token, sessionToken)))
    .returning({ id: session.id });
  return rows.length > 0;
}
