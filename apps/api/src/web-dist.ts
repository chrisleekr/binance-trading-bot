import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { NotFoundHandler } from 'hono';

// Pure SPA-serving helpers (no Bun runtime), so they load under the Node test
// environment. The hono/bun static handlers live in web-static.ts.

// Cache policy mirrors the retired apps/web/nginx.conf: content-hashed
// /assets/* bundles and media files are immutable for a year; the app shell,
// the service worker, and manifest.json must always revalidate so a deploy is
// picked up. sw.js / workbox-*.js deliberately fall in the no-store bucket
// (they are not under /assets/), matching nginx's default.
const ONE_YEAR_IMMUTABLE = 'public, max-age=31536000, immutable';
// Case-insensitive to match nginx's `~*` media match (an uppercase .PNG was
// immutable there too); the /assets/ prefix is lowercase-only by Vite convention.
const IMMUTABLE = /^\/assets\/|\.(?:woff2?|ico|png|jpe?g|svg|webp)$/i;

// Cache-Control for a served static request path, mirroring the nginx map.
export const cacheControlFor = (reqPath: string): string =>
  IMMUTABLE.test(reqPath) ? ONE_YEAR_IMMUTABLE : 'no-store';

export interface WebDist {
  root: string;
  indexHtml: string;
}

// Hono notFound handler splitting unmatched routes: an /api/* path returns the
// JSON error envelope (never the HTML shell, which the client would JSON-parse),
// everything else renders index.html (no-store) for client-side deep-links.
// Mounted after every /api router so it never shadows one. Type-only hono import
// keeps this module free of the Bun-only hono/bun handlers.
export const spaNotFound =
  (indexHtml: string): NotFoundHandler =>
  (c) =>
    c.req.path.startsWith('/api')
      ? c.json({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404)
      : c.html(indexHtml, 200, { 'Cache-Control': 'no-store' });

// Resolve the built SPA directory, or null when it is absent — dev (Vite serves
// the SPA on :5173), tests, or an api sitting behind a CDN. Presence of the
// build, not a feature flag, decides whether the api serves the SPA. index.html
// is read once at boot; it changes only on a deploy, which restarts the process.
export const resolveWebDist = (dir: string | undefined): WebDist | null => {
  if (!dir) return null;
  const root = resolve(dir);
  const index = resolve(root, 'index.html');
  if (!existsSync(index)) return null;
  return { root, indexHtml: readFileSync(index, 'utf8') };
};
