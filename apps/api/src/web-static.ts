import { serveStatic } from 'hono/bun';
import type { MiddlewareHandler } from 'hono';

import { cacheControlFor } from './web-dist.js';
import type { Env } from './types.js';

const ONE_YEAR_IMMUTABLE = 'public, max-age=31536000, immutable';

// Immutable-cached handler for the high-volume /assets/* bundles. Mounted BEFORE
// sessionResolver so an asset fetch never triggers a Better Auth session lookup.
export const assetsHandler = (root: string): MiddlewareHandler<Env> =>
  serveStatic<Env>({
    root,
    onFound: (_path, c) => c.header('Cache-Control', ONE_YEAR_IMMUTABLE),
  });

// Catch-all for the remaining root files (favicon, manifest, sw.js, workbox-*).
// Falls through to next() when no file matches, so the SPA notFound fallback and
// the /api JSON-404 both still fire.
export const rootStaticHandler = (root: string): MiddlewareHandler<Env> =>
  serveStatic<Env>({
    root,
    onFound: (_path, c) => c.header('Cache-Control', cacheControlFor(c.req.path)),
  });
