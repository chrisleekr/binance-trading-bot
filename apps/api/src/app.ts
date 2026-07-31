import type { DI } from './di.js';
import { sessionResolver } from './middleware/auth.js';
import { audit } from './middleware/audit.js';
import { bustDashboardCache } from './middleware/bust-dashboard-cache.js';
import { corsAllowlist } from './middleware/cors.js';
import { errorHandler } from './middleware/error.js';
import { requestLogger } from './middleware/logger.js';
import { httpMetrics } from './middleware/metrics.js';
import { loginRateLimit } from './middleware/login-rate-limit.js';
import { securityHeaders } from './middleware/security-headers.js';
import { healthRouter, type HealthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { mountApiRouters, ACCOUNT_BASE } from './routes/mount.js';
import { createWsRouter } from './routes/ws.js';
import { mountDocs } from './routes/docs.js';
import { resolveWebDist, spaNotFound } from './web-dist.js';
import { assetsHandler, rootStaticHandler } from './web-static.js';
import { createApiHono, type ApiHono } from './types.js';

export interface AppHandle {
  app: ApiHono;
  health: HealthRouter;
  websocket: ReturnType<typeof createWsRouter>['websocket'];
}

export const createApp = (di: DI): AppHandle => {
  const app = createApiHono();
  const health = healthRouter(di);
  // The built SPA the api serves same-origin (absorbing the retired nginx `web`
  // service). null in dev / tests / behind-a-CDN, where the api serves no SPA.
  const web = resolveWebDist(di.env.WEB_DIST_DIR);

  // Public ingress carries liveness only (/healthz). /readyz + /metrics live on
  // the loopback admin server (see index.ts) — the api is internet-facing now,
  // so a public /metrics would leak internal series and a public /readyz would
  // be an unauthenticated pg/redis probe.
  app.route('/', health.publicRouter);

  // Outermost of the request-pipeline middleware so the latency timer
  // spans the whole chain, including onError-mapped error responses.
  // /healthz is mounted earlier (above), so liveness traffic is excluded
  // from the per-route series; /readyz and /metrics are admin-only.
  app.use('*', httpMetrics(di.metrics.registry));
  app.use('*', requestLogger(di.logger));
  app.use('*', corsAllowlist(di.env.WEB_ORIGIN));
  app.use('*', securityHeaders());
  // High-volume hashed bundles are served here, BEFORE sessionResolver, so an
  // asset fetch never pays a Better Auth session lookup. Security headers (above)
  // still wrap the response; /api and SPA routes don't match this prefix.
  if (web) app.get('/assets/*', assetsHandler(web.root));
  // Under LIVE_DEMO the boot-resolved sole operator is injected for anonymous
  // requests; off-demo (or before onboarding) demoOperatorId is null → no-op.
  app.use(
    '*',
    sessionResolver(
      di.auth,
      di.env.LIVE_DEMO && di.demoOperatorId ? { userId: di.demoOperatorId } : null,
    ),
  );
  app.use('*', audit(di));
  // Placed after sessionResolver so c.get('userId') is populated; wraps every
  // router so any successful write busts the dashboard read-through caches.
  app.use('*', bustDashboardCache(di.redis));
  app.onError(errorHandler(di.logger));

  // Login throttle is mounted ONLY on the sign-in paths. Better Auth's
  // catch-all exposes /sign-in/email (and could expose /sign-in/social
  // in future); a wildcard matches both so a path addition can't
  // silently bypass the throttle.
  app.use('/api/auth/sign-in/*', loginRateLimit(di.redis));

  // /api/auth/*
  app.route('/api/auth', authRouter(di));

  // Every /api router, shared with the integration-test harness so the two can
  // never drift. Public status, operator-global routers, then the account-scoped
  // routers under `/accounts/:accountId`.
  mountApiRouters(app, di);

  const ws = createWsRouter(di);
  app.route(ACCOUNT_BASE, ws.router);

  // OpenAPI document + Swagger UI. Mounted last so it picks up every route
  // already attached. The WS upgrade route is registered via plain `.get()`
  // (not `.openapi()`) so it does NOT appear in the spec.
  mountDocs(app);

  // SPA serving, mounted after every /api router so it can never shadow one.
  // rootStaticHandler serves the remaining static files (favicon, manifest,
  // sw.js, workbox-*) and otherwise falls through. notFound then splits: an
  // unmatched /api path returns the JSON error envelope (never the HTML shell,
  // which the client would JSON-parse), everything else renders index.html for
  // client-side routing on deep-links.
  if (web) {
    app.use('*', rootStaticHandler(web.root));
    app.notFound(spaNotFound(web.indexHtml));
  }

  return { app, health, websocket: ws.websocket };
};
