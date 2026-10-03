import { asUserId, type UserId } from '@app/contracts';
import { repo, type Database } from '@app/db';
import type { MiddlewareHandler } from 'hono';
import { BETTER_AUTH_SESSION_TTL_SECONDS, type Auth } from 'auth.js';
import { clientIpFromHeaders } from 'auth/client-address.js';
import type { SecurityEventRecorder } from 'auth/security-events.js';
import type { SecuritySettingsStore, SecuritySnapshot } from 'auth/security-settings.js';
import type { Env } from 'types.js';

/** What the resolver needs to enforce session lifetimes and the security epoch. Optional so narrow test harnesses can omit it. */
export interface SessionPolicy {
  readonly db: Database;
  readonly settings: SecuritySettingsStore;
  readonly events: SecurityEventRecorder;
  /** Clock, injectable for tests. */
  readonly now?: () => number;
}

const HOUR_MS = 3_600_000;
/** How stale `updatedAt` may get before it is rewritten; the idle timeout is measured to this precision. Matches Better Auth's `updateAge`. */
const SESSION_TOUCH_INTERVAL_MS = 15 * 60_000;
/** Better Auth's own session lifetime, the ceiling above the operator's limits. */
const BETTER_AUTH_SESSION_TTL_MS = BETTER_AUTH_SESSION_TTL_SECONDS * 1000;

/** The limits and epoch a session is checked against. */
export interface SessionLimits {
  readonly absoluteHours: number;
  readonly idleHours: number;
  readonly securityEpoch: number;
}

/** Why a still-stored session is refused. */
type SessionExpiry = 'session-expired-absolute' | 'session-expired-idle' | 'session-invalidated';

/**
 * Decides whether a session Better Auth still holds has outlived the operator's policy.
 *
 * @param session - The stored session.
 * @param policy - Current limits and epoch.
 * @param now - Current time, ms.
 * @returns The reason it must end, or null when it is still valid.
 */
export const sessionExpiry = (
  session: { createdAt: Date | string; updatedAt: Date | string; securityEpoch?: number | null },
  policy: SessionLimits,
  now: number,
): SessionExpiry | null => {
  if ((session.securityEpoch ?? 0) < policy.securityEpoch) return 'session-invalidated';
  if (now - new Date(session.createdAt).getTime() > policy.absoluteHours * HOUR_MS)
    return 'session-expired-absolute';
  if (now - new Date(session.updatedAt).getTime() > policy.idleHours * HOUR_MS)
    return 'session-expired-idle';
  return null;
};

/**
 * The limits a session is checked against for this snapshot. On a degraded snapshot the lifetime and idle limits are lifted, because the fallback settings are stricter than what the operator may have chosen and enforcing them would permanently delete valid sessions after one failed read; the epoch check stays, since the epoch is the last one actually read.
 *
 * @param snapshot - The current security settings snapshot.
 * @returns The policy to pass to {@link sessionExpiry}.
 */
export const sessionLimits = (snapshot: SecuritySnapshot): SessionLimits => ({
  absoluteHours: snapshot.degraded
    ? Number.POSITIVE_INFINITY
    : snapshot.settings.sessionAbsoluteLifetimeHours,
  idleHours: snapshot.degraded
    ? Number.POSITIVE_INFINITY
    : snapshot.settings.sessionIdleTimeoutHours,
  securityEpoch: snapshot.securityEpoch,
});

// Resolves Better Auth session → c.set('userId', …). Does NOT 401; the
// require-user middleware enforces that on account-scoped routes.
//
// `demo` is the boot-resolved sole operator, non-null only under LIVE_DEMO. When
// a real session is absent it is injected so every requireUser() mount,
// userIdOf(), and the WS upgrade resolve an identity and the login screen never
// appears. A real Better Auth session always wins over the demo injection.
//
// With a policy, a session past its absolute lifetime, idle for longer than the idle timeout, or issued before the last sign-out-everywhere is deleted and treated as absent. Better Auth's own expiry only slides forward on activity, so without this an active session would never end.
export const sessionResolver =
  (
    auth: Auth,
    demo: { userId: UserId } | null = null,
    policy: SessionPolicy | null = null,
  ): MiddlewareHandler<Env> =>
  async (c, next) => {
    // With a policy the session is read without Better Auth's sliding refresh, which rewrites `updatedAt` before returning and would hide how long the session was idle. The refresh is done below, only after the session passed every check.
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
      ...(policy !== null ? { query: { disableRefresh: true } } : {}),
    });
    let userId = session?.user.id ?? null;
    if (session !== null && userId !== null && policy !== null) {
      const expiry = sessionExpiry(
        session.session as { createdAt: Date; updatedAt: Date; securityEpoch?: number | null },
        sessionLimits(await policy.settings.get()),
        (policy.now ?? Date.now)(),
      );
      if (expiry !== null) {
        await repo.authIdentity.deleteSession(policy.db, userId, session.session.id);
        await policy.events.record({
          event: expiry,
          actor: 'system',
          reason:
            expiry === 'session-invalidated'
              ? 'epoch'
              : expiry === 'session-expired-idle'
                ? 'idle'
                : 'lifetime',
          ipAddress: clientIpFromHeaders(c.req.raw.headers),
          userAgent: c.req.header('user-agent') ?? null,
        });
        userId = null;
      } else {
        const now = (policy.now ?? Date.now)();
        if (now - new Date(session.session.updatedAt).getTime() > SESSION_TOUCH_INTERVAL_MS) {
          await repo.authIdentity.touchSession(
            policy.db,
            userId,
            session.session.id,
            new Date(now),
            new Date(now + BETTER_AUTH_SESSION_TTL_MS),
          );
        }
      }
    }
    if (userId !== null && session !== null) {
      c.set('userId', asUserId(userId));
      c.set('sessionId', session.session.id);
    } else if (demo) c.set('userId', demo.userId);
    await next();
  };
