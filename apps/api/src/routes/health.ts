import { Hono } from 'hono';
import type { Context } from 'hono';
import type { DI } from 'di.js';
import type { Env } from 'types.js';

export interface HealthRouter {
  /** Full surface — /healthz + /readyz + /metrics. Mounted ONLY on the loopback
   * admin server; /readyz probes pg/redis and /metrics leaks internal series, so
   * neither may face the public ingress. */
  router: Hono<Env>;
  /** Liveness only (/healthz). Safe to mount on the public app: it reveals just
   * up/shutting-down, no internal state. */
  publicRouter: Hono<Env>;
  markShutdown: () => void;
}

export const healthRouter = (di: DI): HealthRouter => {
  const app = new Hono<Env>();
  let shuttingDown = false;
  const liveness = (c: Context<Env>): Response =>
    shuttingDown ? c.text('shutting_down', 503) : c.text('ok', 200);
  app.get('/healthz', liveness);
  app.get('/readyz', async (c) => {
    try {
      await di.pool.query('select 1');
      const pong = await di.redis.raw().ping();
      if (pong !== 'PONG') throw new Error('redis ping failed');
      const client = await di.queue.client;
      const queueOk = await client.ping();
      if (queueOk !== 'PONG') throw new Error('queue ping failed');
      return c.text('ready', 200);
    } catch (err) {
      di.logger.warn({ err }, 'readyz_failed');
      return c.text('not_ready', 503);
    }
  });
  // Prometheus exposition for the API service: default process/runtime
  // metrics plus the http_* series the metrics middleware records. The
  // scrape duration is recorded in `finally` so a failed exposition is
  // still timed — a slow/erroring registry must not vanish from the
  // scrape-latency series.
  app.get('/metrics', async (c) => {
    const start = performance.now();
    try {
      const body = await di.metrics.metrics();
      return c.text(body, 200, { 'content-type': di.metrics.contentType });
    } finally {
      di.metrics.observeScrapeDuration((performance.now() - start) / 1000);
    }
  });
  // Liveness only, for the public ingress. /readyz + /metrics stay on `app`
  // (admin server, loopback) — the api is now the internet-facing process, so
  // exposing them here would leak metrics and offer an unauthenticated pg/redis
  // probe. Shares the one `shuttingDown` flag via `liveness`.
  const publicApp = new Hono<Env>();
  publicApp.get('/healthz', liveness);

  return {
    router: app,
    publicRouter: publicApp,
    markShutdown: (): void => {
      shuttingDown = true;
    },
  };
};
