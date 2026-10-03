import type { MiddlewareHandler } from 'hono';
import { clientIpFromHeaders } from '../auth/client-address.js';
import type { DI } from '../di.js';
import { errorResponse } from './error.js';
import type { Env } from '../types.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Called by non-browser clients by design (an AI agent exchanging a code, the MCP endpoint with a bearer token), so a browser Origin is neither expected nor meaningful there. */
const EXEMPT_PATHS = new Set(['/api/mcp', '/api/auth/oauth2/token', '/api/auth/oauth2/revoke']);

/**
 * Refuses state-changing requests that a browser sent on behalf of another website.
 *
 * The session cookie is SameSite=Strict, but that only stops cross-site requests: a page on a sibling subdomain is same-site and would still carry it. Better Auth's own origin check covers only its HTTP endpoints, not this app's routes. So every non-GET API request is checked here: an `Origin` that is not one of the app's own origins is refused, as is `Sec-Fetch-Site: cross-site`. A client that sends neither (curl, an agent, a test harness) is not a browser and cannot be the victim of a cross-site request, so it passes.
 *
 * @param di - The container.
 * @returns The middleware.
 */
export const crossSiteRequestGuard =
  (di: DI): MiddlewareHandler<Env> =>
  async (c, next) => {
    if (SAFE_METHODS.has(c.req.method) || EXEMPT_PATHS.has(c.req.path)) return next();
    const origin = c.req.header('origin');
    const fetchSite = c.req.header('sec-fetch-site');
    const allowed = new Set(di.env.WEB_ORIGIN);
    if (di.env.PUBLIC_BASE_URL !== undefined) allowed.add(di.env.PUBLIC_BASE_URL);
    // An opaque `null` origin (a sandboxed frame, a redirect chain) is refused even if the configuration listed it.
    const foreignOrigin = origin === 'null' || (origin !== undefined && !allowed.has(origin));
    if (foreignOrigin || fetchSite === 'cross-site') {
      await di.security.events.record({
        event: 'cross-site-request-blocked',
        reason: 'origin',
        ipAddress: clientIpFromHeaders(c.req.raw.headers),
        userAgent: c.req.header('user-agent') ?? null,
        detail: { path: c.req.path.slice(0, 64) },
      });
      return errorResponse(
        'FORBIDDEN',
        'This request came from another website and was refused.',
        undefined,
      );
    }
    await next();
  };
