import type { Database } from '@app/db';
import { repo, schema } from '@app/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { UserId } from '@app/contracts';

/**
 * Structural shape Better Auth needs from a logger. Kept as a local interface
 * so this module doesn't hard-depend on the concrete pino type.
 */
interface AuthLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

// Better Auth instance, backed by the drizzle adapter.
//
// Decisions:
//   - email + password only; requireEmailVerification: false (no SMTP)
//   - argon2id (Better Auth default)
//   - cookie: Secure, HttpOnly, SameSite=Strict, 24h length, sliding refresh < 1h idle
//   - twoFactor plugin NOT enabled
//   - login-only throttle (60s/5, mirrored at the Hono middleware layer)
export interface AuthOptions {
  db: Database;
  webOrigins: string[];
  authSecret: string;
  isProduction: boolean;
  /** Best-effort logger for the post-onboarding hook. Optional so tests can omit. */
  logger?: AuthLogger;
}

export type Auth = ReturnType<typeof betterAuth>;

export const createAuth = (opts: AuthOptions): Auth =>
  betterAuth({
    secret: opts.authSecret,
    database: drizzleAdapter(opts.db, {
      provider: 'pg',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    rateLimit: { window: 60, max: 5 },
    session: {
      expiresIn: 60 * 60 * 24,
      updateAge: 60 * 60,
      cookieCache: { enabled: false, maxAge: 0 },
    },
    advanced: {
      cookiePrefix: 'app',
      useSecureCookies: opts.isProduction,
      // Global id override (BA applies it to user/session/account/
      // verification). Motivated by the user model only: BA's `user.id` is
      // text and accepts any string, but the domain `users.id` mirror is
      // uuid and rejects BA's default 32-char alphanumeric nanoid. The
      // other BA models keep `text` columns so the wider UUID is harmless.
      database: {
        generateId: () => crypto.randomUUID(),
      },
      defaultCookieAttributes: {
        sameSite: 'strict',
        httpOnly: true,
        path: '/',
      },
    },
    trustedOrigins: opts.webOrigins,
    databaseHooks: {
      user: {
        create: {
          // Atomically materialise the domain `users` row + the
          // onboarding-complete audit_logs entry once Better Auth has written
          // its own user row. Both inserts share a single transaction so the
          // operator never sees a Better-Auth user with no domain shadow row.
          //
          // The hook is fire-and-forget from Better Auth's perspective; a
          // failure here logs at WARN but does NOT roll back the auth user
          // (Better Auth has already committed it). The next domain-side
          // request that needs the row will retry the insert via the same
          // hook on subsequent sign-ups, or surface a clear UNAUTHENTICATED
          // error that the operator can repair manually.
          after: async (user) => {
            try {
              await opts.db.transaction(async (tx) => {
                const operatorId = user.id as unknown as UserId;
                await repo.users.insert(tx, operatorId, {
                  email: user.email,
                  displayName: user.name ?? null,
                  emailVerifiedAt: user.emailVerified ? new Date() : null,
                  disabledAt: null,
                });
                // Bootstrap a default account so the operator lands on a real
                // account URL immediately (the web redirects `/` to it). Testnet
                // by default — no real money until the operator adds live keys to
                // a live account. Same transaction as the user row so an operator
                // never exists without at least one account to scope profiles to.
                await repo.accounts.create(tx, operatorId, {
                  name: 'Main',
                  binanceMode: 'test',
                });
                await repo.auditLogs.append(tx, operatorId, {
                  actor: 'system',
                  event: 'onboarding-complete',
                  ip: null,
                  userAgent: null,
                  payload: null,
                });
              });
            } catch (err) {
              // Omit the raw email — that's PII and this WARN path
              // fires on a hook failure, so a redacted log is enough
              // to correlate via betterAuthUserId.
              opts.logger?.warn({ err, betterAuthUserId: user.id }, 'post_onboarding_hook_failed');
            }
          },
        },
      },
    },
  });
