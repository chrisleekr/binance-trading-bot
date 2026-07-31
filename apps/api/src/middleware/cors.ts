import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from 'types.js';

export const corsAllowlist = (webOrigins: string[]): MiddlewareHandler<Env> =>
  cors({
    // Hono reflects the request's Origin when it is in this allowlist (and only
    // then), which is what credentialed CORS requires — a `*` wildcard is
    // rejected by browsers once `credentials: true` is set.
    origin: webOrigins,
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposeHeaders: ['X-Request-Id'],
    maxAge: 600,
  });

/**
 * Exact-match origin gate used by the WebSocket upgrade (the CORS middleware
 * above performs its own equivalent membership check on browser requests). The
 * request `Origin` must be one of the configured `WEB_ORIGIN` entries; a missing
 * `Origin` header is rejected.
 */
export const isAllowedOrigin = (
  origin: string | undefined,
  allowlist: readonly string[],
): boolean => origin !== undefined && allowlist.includes(origin);
