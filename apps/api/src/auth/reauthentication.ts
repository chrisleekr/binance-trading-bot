import type { Reauthentication } from '@app/contracts';
import { repo, type Database } from '@app/db';
import { isAPIError } from 'better-auth/api';
import type { Auth } from '../auth.js';
import { HttpError } from '../middleware/error.js';
import { PasswordCheckOverloadedError } from './password-check-gate.js';
import type { SecurityServices } from './security.js';
import type { Attempt, Refusal } from './sign-in-protection.js';

/** How recent a single sign-on login must be to count as proof the operator is present. */
export const SINGLE_SIGN_ON_REAUTHENTICATION_WINDOW_MS: number = 5 * 60_000;

/** Thrown when a limit refused the re-authentication attempt; the route answers 429 with the retry time. */
export class ReauthenticationLimitedError extends Error {
  constructor(public readonly refusal: Refusal) {
    super('re-authentication rate limited');
    this.name = 'ReauthenticationLimitedError';
  }
}

/**
 * Recognises Better Auth's refusal of a wrong password from `verifyPassword`, which throws a BAD_REQUEST API error carrying the `INVALID_PASSWORD` code rather than resolving with a false status.
 *
 * @param err - Whatever `verifyPassword` threw.
 * @returns True only for the wrong-password refusal.
 */
const isWrongPassword = (err: unknown): boolean =>
  isAPIError(err) && (err as { body?: { code?: unknown } }).body?.code === 'INVALID_PASSWORD';

/**
 * Requires fresh proof that the person making a sensitive change is the operator, not someone holding a stolen or unattended session.
 *
 * - `password`: refused while password sign-in is turned off; otherwise checked against the stored hash, under the same per-address and per-email limits and the same hashing capacity as sign-in, so this route cannot become an unthrottled password oracle.
 * - `singleSignOn`: the current session must have been created by a single sign-on login whose identity provider `auth_time` is within the last five minutes. A provider that silently reused its own session reports an old `auth_time`, so only a real, interactive sign-in qualifies; the start route asks the provider for exactly that (`prompt=login`, `max_age=0`).
 *
 * @param db - Database handle.
 * @param auth - Better Auth.
 * @param security - The sign-in services.
 * @param headers - The request's headers, which carry the session cookie.
 * @param proof - What the operator supplied.
 * @param attempt - Who is asking, for limits and the audit trail.
 * @param now - Clock, injectable for tests.
 * @returns Nothing; throws {@link ReauthenticationLimitedError} or an HttpError the client can act on when the proof is refused.
 */
export const requireReauthentication = async (
  db: Database,
  auth: Auth,
  security: SecurityServices,
  headers: Headers,
  proof: Reauthentication,
  attempt: Attempt,
  now: number = Date.now(),
): Promise<void> => {
  const refuse = async (
    reason: 'invalid_credentials' | 'session_refused' | 'method_disabled',
  ): Promise<never> => {
    await security.events.record({
      event: 'reauthentication-failed',
      actor: 'user',
      method: proof.method,
      reason,
      ipAddress: attempt.ipAddress,
      userAgent: attempt.userAgent,
    });
    if (reason === 'method_disabled')
      throw new HttpError(
        'REAUTHENTICATION_REQUIRED',
        'Password sign-in is turned off, so confirm by signing in again with single sign-on.',
      );
    if (proof.method === 'password')
      throw new HttpError('INVALID_PASSWORD', 'The password is not correct.');
    throw new HttpError(
      'REAUTHENTICATION_REQUIRED',
      'Sign in again with single sign-on, then repeat this change within five minutes.',
    );
  };

  if (proof.method === 'singleSignOn') {
    const current = await auth.api.getSession({ headers });
    const session = current?.session as
      | { signInMethod?: string | null; interactiveAuthenticatedAt?: Date | string | null }
      | undefined;
    const at = session?.interactiveAuthenticatedAt
      ? new Date(session.interactiveAuthenticatedAt).getTime()
      : Number.NaN;
    const fresh =
      session?.signInMethod === 'singleSignOn' &&
      Number.isFinite(at) &&
      now - at <= SINGLE_SIGN_ON_REAUTHENTICATION_WINDOW_MS;
    if (!fresh) await refuse('session_refused');
    return;
  }

  // Better Auth's password check ignores whether password sign-in is enabled. An operator who turned it off relies on the provider (and its multi-factor step) alone, so a stored password must not still approve sensitive changes.
  if (!security.passwordSignIn) await refuse('method_disabled');
  const operator = await repo.authIdentity.findSoleUser(db);
  const email = operator?.email ?? '';
  const refusal = await security.protection.checkPasswordAttempt(attempt, email);
  if (refusal !== null) throw new ReauthenticationLimitedError(refusal);
  let valid = false;
  try {
    const result = await security.passwordChecks.run(() =>
      auth.api.verifyPassword({ body: { password: proof.password }, headers }),
    );
    valid = (result as { status?: boolean } | null)?.status === true;
  } catch (err) {
    if (err instanceof PasswordCheckOverloadedError) {
      await security.events.record({
        event: 'password-check-overloaded',
        ipAddress: attempt.ipAddress,
        userAgent: attempt.userAgent,
      });
      throw new ReauthenticationLimitedError({
        limit: 'password_check_capacity',
        reason: 'other',
        retryAfterMs: 5000,
      });
    }
    // Only Better Auth's wrong-password answer is a failed guess; it also gives that answer when no password is stored, which is a wrong proof too. Anything else (the database down, the session gone) is not the operator's mistake, so it must not count toward the lockout or be reported as a wrong password; it reaches the error handler, which logs it.
    if (!isWrongPassword(err)) throw err;
  }
  if (!valid) {
    await security.protection.recordPasswordFailure(attempt, email);
    await refuse('invalid_credentials');
  }
};
