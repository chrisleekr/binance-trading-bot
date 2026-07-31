import type { MiddlewareHandler } from 'hono';
import type { Env } from 'types.js';

// CSP for serving the SPA same-origin (the api absorbed the nginx `web` edge).
// Ported verbatim from the retired apps/web/nginx.conf so folding web into the
// api does not silently weaken or break the policy:
//   - font-src 'self' data:   Vite can inline small fonts as data: URIs; without
//                             this they would fall to default-src and be blocked.
//   - connect-src 'self' ws: wss:   same-origin WebSocket. Safari 13-15 (WebKit
//                             201591) and older Firefox do not match the WS
//                             scheme against 'self', so ws:/wss: are required to
//                             avoid silent live-stream failure. The cost is those
//                             scheme-only sources allow a WS to any host; accepted
//                             over a broken event stream, other primitives stay
//                             same-origin.
//   - frame-ancestors 'none' (CSP-level clickjacking guard beside X-Frame-Options),
//     base-uri 'self', form-action 'self'   general hardening the nginx edge set.
const HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

export const securityHeaders = (): MiddlewareHandler<Env> => async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(HEADERS)) c.header(k, v);
};
