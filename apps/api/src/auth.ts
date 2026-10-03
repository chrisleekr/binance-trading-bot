import type { Database } from '@app/db';
import { repo, schema } from '@app/db';
import { cimd } from '@better-auth/cimd';
import { mcp } from '@better-auth/mcp';
import { betterAuth } from 'better-auth';
import type { Auth as BetterAuthInstance, BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth, jwt } from 'better-auth/plugins';
import { decodeJwt } from 'jose';
import type { SignInMethod, UserId } from '@app/contracts';
import { clientIpFromHeaders } from './auth/client-address.js';
import { currentAuthRequestContext } from './auth/request-context.js';
import type { SecurityEventRecorder } from './auth/security-events.js';
import type { SingleSignOnConfig } from './auth/single-sign-on.js';
import { fetchClientMetadataResource } from './lib/cimd-transport.js';
import { MCP_SCOPES } from './mcp/scopes.js';

/**
 * Structural shape Better Auth needs from a logger. Kept as a local interface
 * so this module doesn't hard-depend on the concrete pino type.
 */
interface AuthLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
  error?(obj: Record<string, unknown>, msg?: string): void;
}

/** Better Auth's stored session lifetime and cookie Max-Age: the maximum absolute session lifetime the security settings allow. */
export const BETTER_AUTH_SESSION_TTL_SECONDS: number = 168 * 60 * 60;

/** Provider id of the single sign-on identity provider; appears in the callback path `/api/auth/callback/oidc` the identity provider must allow. */
export const SINGLE_SIGN_ON_PROVIDER_ID = 'oidc';

// Better Auth instance, backed by the drizzle adapter.
//
// Decisions:
//   - email + password (switchable) and optional OpenID Connect single sign-on; no SMTP, no in-app second factor
//   - scrypt password hashing (Better Auth 1.7 default)
//   - cookie: Secure in production, HttpOnly, SameSite=Strict, Max-Age BETTER_AUTH_SESSION_TTL_SECONDS (168h, the ceiling; the session resolver enforces the operator's shorter idle and absolute limits); the OAuth state cookie alone is Lax (see below)
//   - Better Auth's in-memory rate limiter is off: the Redis limiter in auth/sign-in-protection.ts replaces it for every exposed path
//   - at most one user, enforced here, in the routes, and by a database index
export interface AuthOptions {
  db: Database;
  webOrigins: string[];
  authSecret: string;
  isProduction: boolean;
  /** Best-effort logger for hooks and Better Auth's own messages. Optional so tests can omit. */
  logger?: AuthLogger;
  /**
   * Canonical MCP resource identifier, present only when the operator enabled the control plane. Undefined leaves the OAuth authorization server entirely unregistered rather than registered-but-idle: an operator who never opted in has no `/api/auth/oauth2/*` surface, no client table reachable from the network, and nothing to misconfigure.
   */
  mcpResource?: string;
  /** Whether Better Auth accepts email + password at all. Defaults to true. */
  passwordSignIn?: boolean;
  /** The single sign-on provider, present only when it is enabled AND its discovery document passed the boot check. */
  singleSignOn?: SingleSignOnConfig & { readonly discoveryUrl: string };
  /** The public origin, from PUBLIC_BASE_URL. Takes precedence over the MCP-derived origin. */
  publicBaseUrl?: string;
  /** The current security epoch, stamped on each new session. Defaults to 0 for callers that never bump it. */
  securityEpoch?: () => Promise<number>;
  /** Records sign-ins and onboarding. Optional so tests can omit. */
  events?: SecurityEventRecorder;
}

/**
 * Better Auth plugin set for the MCP control plane, or an empty list when the operator has not enabled it.
 *
 * `jwt()` is not optional decoration: `mcp()` signs access tokens with the key it manages and `requireMcpAuth` verifies them against the `/jwks` endpoint it publishes, so omitting it leaves the resource server with nothing to verify against. `cimd()` is how clients register at all, since dynamic client registration stays off by design, and its transport is supplied by this repo because Bun cannot use the package's Node-only one.
 *
 * @param resource - Canonical resource identifier tokens are audience-bound to, or undefined to register no OAuth surface.
 * @returns The plugin list to spread into the Better Auth options.
 */
const mcpPlugins = (resource: string | undefined): NonNullable<BetterAuthOptions['plugins']> => {
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
    // The session JWT header would otherwise be signed on every session read, and every API request reads the session.
    jwt({ disableSettingJwtHeader: true }),
    oauthProvider as unknown as NonNullable<BetterAuthOptions['plugins']>[number],
    cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
  ];
};

/**
 * Verified claims read from the identity provider's ID token.
 *
 * By the time Better Auth calls this, it has already verified the ID token's signature, audience and nonce against the provider's published keys, but only if an ID token was returned: without one it would fall back to the userinfo endpoint, which carries no nonce and no issuer binding. So a missing ID token is refused here, as is a foreign issuer. Each refusal is noted on the request context so the callback can say why.
 *
 * @param config - The configured provider.
 * @param tokens - Tokens from the code exchange.
 * @returns The profile Better Auth maps to a user, or null to refuse the login.
 */
const singleSignOnUserInfo = (
  config: SingleSignOnConfig,
  tokens: { idToken?: string | undefined },
) => {
  const context = currentAuthRequestContext();
  if (!tokens.idToken) {
    if (context) context.refusalReason = 'missing_id_token';
    return null;
  }
  const claims = decodeJwt(tokens.idToken);
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const email = typeof claims['email'] === 'string' ? claims['email'] : '';
  // Better Auth's own ID-token verification already refuses a foreign issuer (the single sign-on suite cannot make this line fire on its own). It is re-checked because the stored identity key is built from this claim, so a future change in that verification must not silently widen who can sign in.
  if (claims.iss !== config.issuer || sub === '' || email === '') {
    if (context) context.refusalReason = 'issuer_mismatch';
    return null;
  }
  const authTime = typeof claims['auth_time'] === 'number' ? claims['auth_time'] * 1000 : null;
  if (context) context.singleSignOn = { authenticatedAtMs: authTime, email };
  return {
    id: sub,
    sub,
    iss: config.issuer,
    email,
    emailVerified: claims['email_verified'] === true,
    name: typeof claims['name'] === 'string' ? claims['name'] : email,
  };
};

/**
 * The single sign-on plugin, or nothing when single sign-on is off or its provider failed the boot check.
 *
 * @param config - The provider, with the discovery URL that passed the boot check.
 * @param publicBaseUrl - The public origin the callback is registered at.
 * @returns The plugin list to spread into the Better Auth options.
 */
const singleSignOnPlugins = (
  config: AuthOptions['singleSignOn'],
  publicBaseUrl: string | undefined,
): NonNullable<BetterAuthOptions['plugins']> => {
  if (config === undefined || publicBaseUrl === undefined) return [];
  return [
    genericOAuth({
      config: [
        {
          providerId: SINGLE_SIGN_ON_PROVIDER_ID,
          name: config.buttonLabel,
          discoveryUrl: config.discoveryUrl,
          requireIdTokenVerification: true,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          scopes: ['openid', 'email', 'profile'],
          // Built from the configured public origin, never from the request, so a spoofed Host header cannot redirect the code exchange.
          redirectURI: `${publicBaseUrl}/api/auth/callback/${SINGLE_SIGN_ON_PROVIDER_ID}`,
          // New identities are refused unless the start request explicitly asked to create the operator, which the start route does only while no operator exists.
          disableImplicitSignUp: true,
          disableProviderLogout: true,
          allowIdpInitiated: false,
          getUserInfo: async (tokens) => singleSignOnUserInfo(config, tokens),
          // Identity is issuer plus subject. `sub` is unique only within one issuer; without the issuer, re-pointing the app at another tenant would let whoever holds the same `sub` there sign in as the operator.
          accountSubject: ({ profile }) =>
            `${String(profile['iss'])}|${String(profile.sub ?? profile.id)}`,
        },
      ],
    }),
  ];
};

/**
 * Origin the auth server publishes itself at.
 *
 * Better Auth otherwise derives its origin from whatever host each request arrives with. For cookie auth that is harmless; for an OAuth authorization server and an OAuth client it is not, because the issuer, the JWKS URL, every discovery endpoint and the single sign-on redirect address are built from it. PUBLIC_BASE_URL is authoritative; the MCP resource identifier's origin is the fallback, since it is a public URL the operator has already had to get right.
 *
 * @param publicBaseUrl - PUBLIC_BASE_URL, when set.
 * @param resource - The configured MCP resource identifier, when the control plane is on.
 * @returns The `baseURL` option, or an empty object to keep Better Auth's per-request derivation.
 */
const authBaseUrlOption = (
  publicBaseUrl: string | undefined,
  resource: string | undefined,
): { baseURL?: string } => {
  if (publicBaseUrl !== undefined) return { baseURL: publicBaseUrl };
  if (resource === undefined) return {};
  try {
    return { baseURL: new URL(resource).origin };
  } catch {
    // Unreachable while the env schema validates the URL, and an unparseable value here must not take down cookie auth for a misconfigured MCP flag.
    return {};
  }
};

/**
 * Maps Better Auth's endpoint path to how the session it creates was obtained. A fallback for sessions created outside any route that sets the method on the request context, so the session row and the sign-in event still name a method.
 *
 * @param path - Better Auth's matched endpoint path, as its hook context reports it; undefined outside an endpoint.
 * @returns The sign-in method, or null for a path that does not sign anyone in.
 */
const methodFromPath = (path: string | undefined): SignInMethod | null => {
  if (path === '/sign-in/email') return 'password';
  if (path === '/sign-up/email') return 'onboarding';
  if (path === '/callback/:id') return 'singleSignOn';
  return null;
};

/**
 * Strips identity-provider tokens from an account write. Nothing in this app calls the provider's API, so keeping its access, refresh and ID tokens would only add live credentials to the database and to every backup.
 *
 * @param data - The account fields Better Auth is about to create or update.
 * @returns The hook result Better Auth merges into the write, with every provider token nulled.
 */
const withoutProviderTokens = <T extends Record<string, unknown>>(data: T): { data: T } => ({
  data: { ...data, accessToken: null, refreshToken: null, idToken: null },
});

/**
 * Names the identity provider account on a security event, so the activity list and the notification say which account signed in or was linked rather than only that one did.
 *
 * @param context - The request context, holding the verified ID token's claims when this request came back from the identity provider.
 * @returns A `detail` carrying the provider's email, or nothing for a request that did not come from single sign-on.
 */
const singleSignOnAccountDetail = (
  context: ReturnType<typeof currentAuthRequestContext>,
): { detail?: { account: string } } =>
  context?.singleSignOn ? { detail: { account: context.singleSignOn.email } } : {};

const authOptions = (opts: AuthOptions): BetterAuthOptions => ({
  secret: opts.authSecret,
  ...authBaseUrlOption(opts.publicBaseUrl, opts.mcpResource),
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
  plugins: [
    ...mcpPlugins(opts.mcpResource),
    ...singleSignOnPlugins(opts.singleSignOn, opts.publicBaseUrl),
  ],
  // Length bounds match SignUpRequest / ChangePasswordRequest; Better Auth's own defaults (8..128) would reject a valid 200-character password and accept an 8-character one.
  emailAndPassword: {
    enabled: opts.passwordSignIn ?? true,
    requireEmailVerification: false,
    minPasswordLength: 12,
    maxPasswordLength: 256,
  },
  // Off, and replaced by the Redis limiter in auth/sign-in-protection.ts: Better Auth's limiter keeps its counts in process memory, reads the client address from a different header rule than the rest of the app, and answers in a different error shape. Turning it off also turns off the OAuth provider's own token and authorize limits, which the gateway re-applies.
  rateLimit: { enabled: false },
  session: {
    // The ceiling, not the operator's limit: it is also the session cookie's Max-Age, which Better Auth sets once at sign-in, so it must cover the longest absolute lifetime the settings allow (168 hours). The session resolver enforces the operator's shorter absolute and idle limits on every request.
    expiresIn: BETTER_AUTH_SESSION_TTL_SECONDS,
    // The resolver reads sessions without Better Auth's refresh and touches them itself, every 15 minutes.
    updateAge: 15 * 60,
    cookieCache: { enabled: false, maxAge: 0 },
    additionalFields: {
      securityEpoch: { type: 'number', required: false, defaultValue: 0, input: false },
      signInMethod: { type: 'string', required: false, input: false },
      interactiveAuthenticatedAt: { type: 'date', required: false, input: false },
    },
  },
  account: {
    accountLinking: {
      // A single sign-on identity attaches to the operator only through an explicit, re-authenticated link while signed in. Implicit linking by matching email is off: any other identity at the provider carrying the operator's verified email could otherwise attach itself.
      disableImplicitLinking: true,
      trustedProviders: [SINGLE_SIGN_ON_PROVIDER_ID],
      allowDifferentEmails: true,
    },
    updateAccountOnSignIn: false,
    additionalFields: {
      providerEmail: { type: 'string', required: false, input: false },
    },
  },
  onAPIError: { errorURL: '/login' },
  logger: {
    level: 'warn',
    log: (level, message, ...args) => {
      // Better Auth's warnings and errors go to the operator's log stream instead of its console. Arguments pass through the same logger, whose redaction and error serialiser apply.
      const entry = { betterAuth: true, detail: args.length > 0 ? args : undefined };
      if (level === 'error')
        (opts.logger?.error ?? opts.logger?.warn)?.call(opts.logger, entry, message);
      else opts.logger?.warn(entry, message);
    },
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
    cookies: {
      // The only cookie relaxed to Lax. It is set when single sign-on starts and must come back on the identity provider's redirect, which is a cross-site navigation that never carries a Strict cookie; with Strict every single sign-on login fails as a state mismatch. It holds a signed random value, not a credential, and lives five minutes.
      state: { attributes: { sameSite: 'lax' } },
    },
  },
  trustedOrigins: opts.webOrigins,
  databaseHooks: {
    user: {
      create: {
        // The single-operator gate every path shares: password sign-up, single sign-on sign-up, and anything a future plugin adds. Route checks miss paths they do not know about; the unique index in migration 0097 is the last line. Returning false makes Better Auth report a failed create, which single sign-on turns into an error redirect rather than a raw 500.
        before: async () => {
          const existing = await repo.authIdentity.countUsers(opts.db);
          return existing === 0 ? undefined : false;
        },
        // Atomically materialise the domain `users` row + a default account once Better Auth has written its own user row. The hook is fire-and-forget from Better Auth's perspective; a failure here logs at WARN but does NOT roll back the auth user (Better Auth has already committed it). The reset-password command repairs a missing domain row.
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
            });
            const context = currentAuthRequestContext();
            if (context) context.onboardedUserId = user.id;
            await opts.events?.record({
              event: 'onboarding-complete',
              actor: 'user',
              method: context?.method === 'singleSignOn' ? 'singleSignOn' : 'onboarding',
              ipAddress: context?.ipAddress ?? null,
              userAgent: context?.userAgent ?? null,
              ...singleSignOnAccountDetail(context),
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
    account: {
      create: {
        before: async (account) =>
          withoutProviderTokens(
            account.providerId === SINGLE_SIGN_ON_PROVIDER_ID
              ? {
                  ...account,
                  providerEmail: currentAuthRequestContext()?.singleSignOn?.email ?? null,
                }
              : account,
          ),
        // A single sign-on identity attached outside onboarding is a new way into the operator account, so it is always reported.
        after: async (account) => {
          if (account.providerId !== SINGLE_SIGN_ON_PROVIDER_ID) return;
          const context = currentAuthRequestContext();
          if (context?.onboardedUserId === account.userId) return;
          if (context) context.linkedUserId = account.userId;
          await opts.events?.record({
            event: 'single-sign-on-linked',
            actor: 'user',
            method: 'singleSignOn',
            ipAddress: context?.ipAddress ?? null,
            userAgent: context?.userAgent ?? null,
            ...singleSignOnAccountDetail(context),
          });
        },
      },
      update: { before: async (account) => withoutProviderTokens(account) },
    },
    session: {
      create: {
        before: async (session, ctx) => {
          const context = currentAuthRequestContext();
          const method = context?.method ?? methodFromPath(ctx?.path) ?? null;
          const headers = ctx?.request?.headers ?? ctx?.headers;
          const ssoAuthenticatedAt = context?.singleSignOn?.authenticatedAtMs;
          return {
            data: {
              ...session,
              // One answer to "which address" per request: the same trusted-proxy rule the rest of the app uses, not Better Auth's own header reading.
              ipAddress: context?.ipAddress ?? (headers ? clientIpFromHeaders(headers) : null),
              securityEpoch: (await opts.securityEpoch?.()) ?? 0,
              signInMethod: method,
              interactiveAuthenticatedAt:
                method === 'singleSignOn'
                  ? ssoAuthenticatedAt
                    ? new Date(ssoAuthenticatedAt)
                    : null
                  : new Date(),
            },
          };
        },
        after: async (session, ctx) => {
          try {
            const context = currentAuthRequestContext();
            if (context) context.createdSession = { userId: session.userId, sessionId: session.id };
            const method = context?.method ?? methodFromPath(ctx?.path);
            if (method !== 'password' && method !== 'singleSignOn' && method !== 'onboarding')
              return;
            await opts.events?.record({
              event: 'sign-in-succeeded',
              actor: 'user',
              method,
              ipAddress:
                context?.ipAddress ?? (session.ipAddress as string | null | undefined) ?? null,
              userAgent:
                context?.userAgent ?? (session.userAgent as string | null | undefined) ?? null,
              ...singleSignOnAccountDetail(context),
            });
          } catch (err) {
            // Recording must never fail a sign-in whose session already exists.
            opts.logger?.warn({ err }, 'sign_in_record_failed');
          }
          // Better Auth does not rewrite an existing identity on sign-in, so an address changed at the provider, or an identity linked before the address was recorded, is picked up here. After the event, so a failure here cannot cost the sign-in its record.
          const providerEmail = currentAuthRequestContext()?.singleSignOn?.email;
          if (providerEmail === undefined) return;
          try {
            await repo.authIdentity.recordSingleSignOnEmail(opts.db, session.userId, providerEmail);
          } catch (err) {
            opts.logger?.warn({ err }, 'single_sign_on_email_record_failed');
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
