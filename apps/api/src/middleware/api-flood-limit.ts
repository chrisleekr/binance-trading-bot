import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { clientIpFromHeaders } from '../auth/client-address.js';
import { rateLimitedResponse, readCookie } from '../auth/http.js';
import type { DI } from '../di.js';
import type { Env } from '../types.js';

/** Session cookie names Better Auth uses with this app's prefix; the `__Secure-` form is used in production. */
const SESSION_COOKIES = ['__Secure-app.session_token', 'app.session_token'] as const;

/**
 * Whether a request carries a session cookie Better Auth itself signed. Decides only which flood budget applies, not whether the session is valid, so it must stay a local computation: a flood of forged cookies must not buy a database query each. The format mirrors Better Auth's cookie signing (HMAC-SHA256 of the token with AUTH_SECRET, base64, appended after a dot, URI-encoded).
 *
 * @param headers - Request headers.
 * @param secret - AUTH_SECRET.
 * @returns True only for an authentic signature; a forged cookie gets the anonymous budget.
 */
export const hasSignedSessionCookie = (headers: Headers, secret: string): boolean => {
  for (const name of SESSION_COOKIES) {
    const raw = readCookie(headers, name);
    if (raw === undefined) continue;
    let value: string;
    try {
      value = decodeURIComponent(raw);
    } catch {
      return false;
    }
    const dot = value.lastIndexOf('.');
    if (dot < 1) return false;
    const given = Buffer.from(value.slice(dot + 1), 'base64');
    const expected = createHmac('sha256', secret).update(value.slice(0, dot)).digest();
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
  return false;
};

/** The MCP route, which meters its own callers (see `mcpRouter`). */
const MCP_PATH = '/api/mcp';

/**
 * Per-address flood limit on every API request, mounted before the session lookup so an attacker pays no database work per request. A request with an authentic session cookie gets the larger budget the operator's own dashboard needs; anything else gets the small anonymous one. Liveness and the static SPA are mounted earlier and never counted.
 *
 * The MCP route is skipped. An agent authenticates with a bearer token, never a session cookie, so this limit would put every verified agent on the anonymous budget: it would cap agents below their own documented limit and let an agent's loop exhaust the budget the sign-in page needs from the same address. That route charges the anonymous budget itself to every caller who has not proved a token.
 *
 * @param di - The container.
 * @returns The middleware.
 */
export const apiFloodLimit =
  (di: DI): MiddlewareHandler<Env> =>
  async (c, next) => {
    // Only while the route is mounted. With MCP off the path is an ordinary 404, and skipping it would leave that one path unmetered.
    if (di.env.MCP_ENABLED && c.req.path === MCP_PATH) {
      await next();
      return;
    }
    const headers = c.req.raw.headers;
    const refusal = await di.security.protection.checkApiFlood(
      clientIpFromHeaders(headers),
      hasSignedSessionCookie(headers, di.env.AUTH_SECRET),
    );
    if (refusal !== null) return rateLimitedResponse(refusal.retryAfterMs);
    await next();
  };
