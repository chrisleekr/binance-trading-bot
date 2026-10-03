import type { UserId } from '@app/contracts';
import type { DI } from '../di.js';
import { audit } from '../middleware/audit.js';
import { bustDashboardCache } from '../middleware/bust-dashboard-cache.js';
import { errorHandler } from '../middleware/error.js';
import { mountApiRouters } from '../routes/mount.js';
import { createApiHono, type ApiHono } from '../types.js';

/**
 * The router set every MCP tool dispatches into: the SAME `mountApiRouters` production serves to the browser, mounted a second time in-process.
 *
 * Re-implementing the tool bodies against the repos would create a second code path with its own copy of every ownership check, every entry-halt guard and every strategy-schema validation, and the two would drift the first time one of them changed. Mounting the real routers means an agent's order goes through the identical `scopeAccount` proof, the identical `assertActionSupported`, and the identical config validation, with no second implementation to keep honest.
 *
 * Two things are deliberately different from the public app:
 *
 * - There is NO `sessionResolver`. The MCP access token is verified once, at the route, and the identity it resolved to is injected here. A bearer token therefore has no path into the cookie-authenticated REST API at all: a stolen one cannot be replayed against `GET /api/backup`, because that route only ever reads a session cookie.
 * - `audit` writes `actor='agent'`. Both paths are otherwise indistinguishable at the database, so this is the only thing that tells the operator an order was placed by a model rather than by their own click.
 */
export const createMcpInnerApp = (di: DI, operatorId: UserId): ApiHono => {
  const app = createApiHono();
  app.use('*', async (c, next) => {
    c.set('userId', operatorId);
    await next();
  });
  app.use('*', audit(di, 'agent'));
  // Same position the public app mounts it in, after the identity is set and wrapping every router, because the dashboard caches are shared with the operator's browser and a write whose blob is not dropped reads back for the rest of the TTL as if it never happened. An agent re-reads far inside that window, so it would see its own change missing and reissue it.
  app.use('*', bustDashboardCache(di.redis));
  // Registered as Hono's onError rather than a wrapping middleware, so an error thrown inside a zod-openapi validator still becomes the project error envelope instead of a bare 500 the tool layer would report as an opaque failure.
  app.onError(errorHandler(di.logger));
  mountApiRouters(app, di);
  return app;
};
