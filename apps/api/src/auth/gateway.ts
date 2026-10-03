import type { SecurityEventReason } from '@app/contracts';
import { repo } from '@app/db';
import type { Context } from 'hono';
import { SINGLE_SIGN_ON_PROVIDER_ID } from '../auth.js';
import type { DI } from '../di.js';
import { errorResponse } from '../middleware/error.js';
import type { Env } from '../types.js';
import { clientIpFromHeaders } from './client-address.js';
import { rateLimitedResponse } from './http.js';
import { issueKnownDevice, knownDeviceSetCookie } from './known-device.js';
import { runWithAuthRequestContext, type AuthRequestContext } from './request-context.js';
import type { AddressLimit, Attempt } from './sign-in-protection.js';

/** One Better Auth HTTP endpoint the browser or an agent may reach directly. */
export interface Passthrough {
  readonly method: 'GET' | 'POST';
  /** Path under `/api/auth`, exactly as Better Auth registers it. */
  readonly path: string;
  /** Whether this deployment exposes it. */
  readonly enabled: (di: DI) => boolean;
  /** Which limit it counts against, or null for the key-discovery endpoint agents must always reach. */
  readonly limit: AddressLimit | null;
  /** A top-level browser navigation: a refusal redirects to the sign-in page instead of answering JSON the browser would display raw. */
  readonly navigation: boolean;
}

/**
 * Whether single sign-on is configured and its identity provider passed the boot check.
 *
 * @param di - The container.
 * @returns True when single sign-on can be offered.
 */
export const singleSignOnReady = (di: DI): boolean =>
  di.security.singleSignOn !== null && di.security.singleSignOnAvailable;
const agentsEnabled = (di: DI): boolean =>
  di.env.MCP_ENABLED && di.env.MCP_RESOURCE_URL !== undefined;

/**
 * The complete list of Better Auth endpoints reachable over HTTP. Everything else Better Auth registers (about thirty endpoints, including a password oracle, email change, token listing and client administration) answers 404. Sign-in, sign-up, sign-out, password and session management go through this app's own routes, which call Better Auth server-side with strict bodies, limits and audit; only the endpoints a third party must call directly are passed through. A test enumerates every endpoint Better Auth registers and fails when one is neither here nor in the denied list, so an upgrade that adds an endpoint cannot expose it silently.
 */
export const AUTH_PASSTHROUGH: readonly Passthrough[] = [
  // The identity provider redirects the browser here with the authorization code.
  {
    method: 'GET',
    path: `/callback/${SINGLE_SIGN_ON_PROVIDER_ID}`,
    enabled: singleSignOnReady,
    limit: 'other_auth_requests',
    navigation: true,
  },
  // The agent authorization server: the browser is sent to authorize and consent; the agent calls token and revoke; the resource server verifies against jwks.
  {
    method: 'GET',
    path: '/oauth2/authorize',
    enabled: agentsEnabled,
    limit: 'agent_authorize',
    navigation: true,
  },
  {
    method: 'POST',
    path: '/oauth2/consent',
    enabled: agentsEnabled,
    limit: 'other_auth_requests',
    navigation: false,
  },
  {
    method: 'POST',
    path: '/oauth2/token',
    enabled: agentsEnabled,
    limit: 'agent_token',
    navigation: false,
  },
  {
    method: 'POST',
    path: '/oauth2/revoke',
    enabled: agentsEnabled,
    limit: 'other_auth_requests',
    navigation: false,
  },
  { method: 'GET', path: '/jwks', enabled: agentsEnabled, limit: null, navigation: false },
];

/**
 * Maps an OAuth callback `error` value onto the closed reason set. Whoever started the flow controls that value, so passing it through would let a stranger grow metric labels and audit reasons without bound; anything unrecognised becomes `other`. Better Auth spells some codes with spaces and others with underscores, so both are accepted.
 *
 * @param code - The `error` query parameter of Better Auth's redirect, or null when it carried none.
 * @returns The reason recorded on the failed sign-in.
 */
export const callbackReason = (code: string | null): SecurityEventReason => {
  switch (code) {
    case 'state_mismatch':
    case 'state_not_found':
    case 'invalid_callback_request':
      return 'state_mismatch';
    case 'access_denied':
      return 'access_denied';
    case 'invalid_code':
    case 'no_code':
      return 'invalid_code';
    case 'account not linked':
    case 'account_not_linked':
      return 'account_not_linked';
    case 'signup disabled':
    case 'signup_disabled':
    case 'unable_to_create_user':
      return 'sign_up_refused';
    case 'issuer_mismatch':
      return 'issuer_mismatch';
    case 'email_not_verified':
      return 'email_not_verified';
    case 'unable_to_create_session':
      return 'session_refused';
    default:
      return 'other';
  }
};

/**
 * Reads the client identifier an agent sends to the token endpoint, so the limit counts per agent as well as per address. Form-encoded per RFC 6749; a missing value counts against the address alone.
 *
 * @param request - The token request; its body is read from a clone.
 * @returns The client id, capped in length, or undefined.
 */
const tokenClientId = async (request: Request): Promise<string | undefined> => {
  try {
    const form = new URLSearchParams(await request.clone().text());
    return form.get('client_id')?.slice(0, 512) ?? undefined;
  } catch {
    return undefined;
  }
};

/**
 * Serves every `/api/auth/*` path no explicit route claimed: forwards the allow-listed ones to Better Auth under their limits and records what happened; answers 404 for the rest.
 *
 * @param di - The container.
 * @returns The Hono handler mounted as the auth router's last route.
 */
export const authGateway =
  (di: DI) =>
  async (c: Context<Env>): Promise<Response> => {
    const suffix = c.req.path.replace(/^.*?\/api\/auth/, '') || '/';
    const entry = AUTH_PASSTHROUGH.find(
      (p) => p.path === suffix && p.method === c.req.method && p.enabled(di),
    );
    const headers = c.req.raw.headers;
    const attempt: Attempt = {
      ipAddress: clientIpFromHeaders(headers),
      userAgent: headers.get('user-agent'),
      knownDevice: false,
    };
    if (entry === undefined) {
      await di.security.events.record({
        event: 'auth-endpoint-denied',
        reason: 'not_exposed',
        ipAddress: attempt.ipAddress,
        userAgent: attempt.userAgent,
        detail: { path: suffix.slice(0, 64), method: c.req.method },
      });
      return errorResponse('NOT_FOUND', 'not found', undefined);
    }

    if (entry.limit !== null) {
      const subject = entry.limit === 'agent_token' ? await tokenClientId(c.req.raw) : undefined;
      const refusal = await di.security.protection.checkAddressLimit(entry.limit, attempt, subject);
      if (refusal !== null) {
        if (entry.navigation) return c.redirect('/login?error=rate_limited', 302);
        return rateLimitedResponse(refusal.retryAfterMs);
      }
    }

    if (entry.path === `/callback/${SINGLE_SIGN_ON_PROVIDER_ID}`)
      return singleSignOnCallback(di, c, attempt);

    const consent = entry.path === '/oauth2/consent' ? await readConsentChoice(c.req.raw) : null;
    const response = await di.auth.handler(c.req.raw);
    if (response.status < 400) {
      if (consent !== null) {
        await di.security.events.record({
          event: consent ? 'agent-consent-granted' : 'agent-consent-denied',
          actor: 'user',
          method: 'agent',
          ipAddress: attempt.ipAddress,
          userAgent: attempt.userAgent,
        });
      }
      if (entry.path === '/oauth2/token') {
        await di.security.events.record({
          event: 'agent-token-issued',
          method: 'agent',
          ipAddress: attempt.ipAddress,
        });
      }
    }
    return response;
  };

/**
 * Whether the operator accepted or declined on the consent screen. Read from a clone so Better Auth still receives the untouched body, and before forwarding because the choice is only in the request.
 *
 * @param request - The consent request, whose JSON body carries `accept`.
 * @returns True for accept, false for decline, or null when the body is unreadable or carries no boolean choice.
 */
const readConsentChoice = async (request: Request): Promise<boolean | null> => {
  try {
    const body = (await request.clone().json()) as { accept?: unknown };
    return typeof body.accept === 'boolean' ? body.accept : null;
  } catch {
    return null;
  }
};

/**
 * The known-device `Set-Cookie` value to add to a successful sign-in. Issued on every successful sign-in, including from a browser that already carries a valid mark, so the lifetime slides: a browser stays recognised while it signs in successfully at least once per lifetime, instead of expiring a fixed time after its first sign-in.
 *
 * @param di - The container, for the signing secret, the current security epoch and the configured lifetime.
 * @param userId - The user the sign-in just created a session for.
 * @returns The header value to append.
 */
export const knownDeviceCookieFor = async (di: DI, userId: string): Promise<string> => {
  const { securityEpoch, settings } = await di.security.settings.get();
  const lifetimeMs = settings.knownDeviceLifetimeDays * 86_400_000;
  return knownDeviceSetCookie(
    issueKnownDevice(di.env.AUTH_SECRET, userId, securityEpoch, lifetimeMs),
    lifetimeMs,
    di.env.NODE_ENV === 'production',
  );
};

/**
 * Completes a single sign-on login. Better Auth exchanges the code, verifies the ID token and creates the session inside the request context, so the hooks can report what they learned. Success adds a known-device mark; failure is recorded with a reason from the closed set.
 *
 * @param di - The container.
 * @param c - The callback request.
 * @param attempt - Who is completing it.
 * @returns Better Auth's redirect, with a known-device cookie appended on success.
 */
const singleSignOnCallback = async (
  di: DI,
  c: Context<Env>,
  attempt: Attempt,
): Promise<Response> => {
  const context: AuthRequestContext = {
    ipAddress: attempt.ipAddress,
    userAgent: attempt.userAgent,
    method: 'singleSignOn',
  };
  const response = await runWithAuthRequestContext(context, () => di.auth.handler(c.req.raw));
  const location = response.headers.get('location');
  const errorCode = location ? new URL(location, 'http://local').searchParams.get('error') : null;
  // A link attaches an identity to the signed-in operator and redirects without creating a session; it is recorded as linked by the account hook, not as a failed sign-in.
  if (errorCode === null && context.linkedUserId !== undefined) return response;
  if (errorCode !== null || context.createdSession === undefined) {
    const reason: SecurityEventReason = context.refusalReason ?? callbackReason(errorCode);
    const operator = await repo.authIdentity.findSoleUser(di.db);
    await di.security.events.record({
      event: 'sign-in-failed',
      method: 'singleSignOn',
      reason,
      ipAddress: attempt.ipAddress,
      userAgent: attempt.userAgent,
      emailMatched: false,
      ...(operator === null ? { detail: { beforeOnboarding: true } } : {}),
    });
    if (context.refusalReason !== undefined && location !== null) {
      // Better Auth reports these as a generic "unable to get user info"; the sign-in page can explain the real cause.
      const target = new URL(location, 'http://local');
      target.searchParams.set('error', context.refusalReason);
      const headers = new Headers(response.headers);
      headers.set('location', `${target.pathname}${target.search}`);
      return new Response(null, { status: response.status, headers });
    }
    return response;
  }
  const headers = new Headers(response.headers);
  headers.append('set-cookie', await knownDeviceCookieFor(di, context.createdSession.userId));
  return new Response(response.body, { status: response.status, headers });
};
