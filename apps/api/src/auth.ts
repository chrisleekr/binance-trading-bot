import type { Database } from '@app/db';
import { repo, schema } from '@app/db';
import { cimd } from '@better-auth/cimd';
import { mcp } from '@better-auth/mcp';
import { betterAuth } from 'better-auth';
import type { Auth as BetterAuthInstance, BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { jwt } from 'better-auth/plugins';
import type { UserId } from '@app/contracts';
import { fetchClientMetadataResource } from './lib/cimd-transport.js';
import { MCP_SCOPES } from './mcp/scopes.js';

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
  /**
   * Canonical MCP resource identifier, present only when the operator enabled the control plane. Undefined leaves the OAuth authorization server entirely unregistered rather than registered-but-idle: an operator who never opted in has no `/api/auth/oauth2/*` surface, no client table reachable from the network, and nothing to misconfigure.
   */
  mcpResource?: string;
}

/**
 * Better Auth plugin set for the MCP control plane, or an empty list when the operator has not enabled it.
 *
 * `jwt()` is not optional decoration: `mcp()` signs access tokens with the key it manages and `requireMcpAuth` verifies them against the `/jwks` endpoint it publishes, so omitting it leaves the resource server with nothing to verify against. `cimd()` is how clients register at all, since dynamic client registration stays off by design, and its transport is supplied by this repo because Bun cannot use the package's Node-only one.
 *
 * @param resource - Canonical resource identifier tokens are audience-bound to, or undefined to register no OAuth surface.
 * @returns The plugin list to spread into the Better Auth options.
 */
const mcpPlugins = (resource: string | undefined): BetterAuthOptions['plugins'] => {
  if (resource === undefined) return [];
  const oauthProvider = mcp({
    loginPage: '/login',
    consentPage: '/consent',
    resource,
    scopes: [...MCP_SCOPES],
    // Dynamic client registration stays off: an open `POST /oauth2/register` on a host holding plaintext Binance keys is a registration surface nobody is watching, and the MCP revision this targets deprecates it in favour of the metadata documents cimd() reads.
    allowDynamicClientRegistration: false,
    allowUnauthenticatedClientRegistration: false,
  });
  // The only cast in this file, and it buys nothing behavioural. `mcp()` returns a plugin whose OpenAPI documentation metadata spells an optional `items` as `items?: undefined`, which `exactOptionalPropertyTypes` refuses to widen into the published `OpenAPIParameter`. The disagreement is entirely inside the generated API-docs blob; every field Better Auth actually executes against typechecks, and narrowing the cast to this one value keeps the rest of the plugin list checked.
  return [
    jwt(),
    oauthProvider as unknown as NonNullable<BetterAuthOptions['plugins']>[number],
    cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
  ];
};

/**
 * Origin the authorization server publishes itself at, derived from the MCP resource identifier.
 *
 * Better Auth otherwise derives its origin from whatever host each request arrives with. For cookie auth that is harmless; for an OAuth authorization server it is not, because the issuer, the JWKS URL and every endpoint in the discovery documents are built from it. Behind a proxy that means a token minted under one derived issuer and verified against another, which fails as an unexplained 401. The resource identifier is the one public URL the operator has already had to get right, so its origin is the honest source for this.
 *
 * @param resource - The configured MCP resource identifier, or undefined when the control plane is off.
 * @returns The `baseURL` option carrying that origin, or an empty object to leave Better Auth's existing per-request derivation alone.
 */
const authBaseUrlOption = (resource: string | undefined): { baseURL?: string } => {
  if (resource === undefined) return {};
  try {
    return { baseURL: new URL(resource).origin };
  } catch {
    // Unreachable while the env schema validates the URL, and an unparseable value here must not take down cookie auth for a misconfigured MCP flag.
    return {};
  }
};

const authOptions = (opts: AuthOptions): BetterAuthOptions => ({
  secret: opts.authSecret,
  ...authBaseUrlOption(opts.mcpResource),
  database: drizzleAdapter(opts.db, {
    provider: 'pg',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      // OAuth provider tables from migration 0095. The adapter resolves a model by the KEY here, so a plugin whose model is missing throws "model not found" at the first authorization rather than at boot.
      jwks: schema.jwks,
      oauthClient: schema.oauthClient,
      oauthResource: schema.oauthResource,
      oauthClientResource: schema.oauthClientResource,
      oauthRefreshToken: schema.oauthRefreshToken,
      oauthAccessToken: schema.oauthAccessToken,
      oauthConsent: schema.oauthConsent,
      oauthClientAssertion: schema.oauthClientAssertion,
    },
  }),
  plugins: mcpPlugins(opts.mcpResource),
  emailAndPassword: { enabled: true, requireEmailVerification: false },
  // `enabled` is stated rather than left to default: Better Auth otherwise
  // derives it from its own read of process.env.NODE_ENV, which is a second,
  // invisible source of truth for a security control. Same value, one owner.
  rateLimit: { enabled: opts.isProduction, window: 60, max: 5 },
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

// `Auth` is parameterised on the exact options object it was built from, and
// the parameter is invariant. Annotating `authOptions` as the base
// `BetterAuthOptions` pins the instance to `Auth<BetterAuthOptions>` so the
// exported type stays nameable — `--isolatedDeclarations` rejects an inferred
// one, and a bare `ReturnType<typeof betterAuth>` no longer matches the call.
export type Auth = BetterAuthInstance;

export const createAuth = (opts: AuthOptions): Auth => betterAuth(authOptions(opts));
