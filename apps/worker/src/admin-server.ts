// Worker-side admin HTTP surface. Bound to 127.0.0.1:9100 inside the
// container so the public network never sees it; the operator's compose
// HEALTHCHECK targets this server, never the worker's main process.
//
// /healthz: liveness, flips to `shutting_down` when graceful drain begins.
// /readyz:  pings the pg pool and the redis client; 503 on either failure
//           (including a per-probe timeout so a stalled backend can't hang
//           the readiness check indefinitely).
// /metrics: prom-client exposition when a registry is injected, otherwise
//           a valid empty exposition body so Prometheus scrapers can bind
//           to the path before the registry is wired. Exposition errors
//           are caught and surfaced as a 503 so observability never
//           disappears silently on a collector hiccup.

import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import type { MetricsRegistry } from '@app/observability';

/**
 * Lifecycle + dependencies for the admin server. The dependencies are
 * passed in by the worker entrypoint so /readyz can probe the same
 * pool and redis client the rest of the worker uses (no separate
 * connection budget).
 */
export interface AdminServerDeps {
  logger: Logger;
  pool: Pool;
  redis: Redis;
  /** Optional. When provided, /metrics serves the registry's exposition body. Otherwise serves an empty placeholder. */
  metrics?: MetricsRegistry;
}

/**
 * Lifecycle handle returned by `startAdminServer`. Calling `markShutdown`
 * flips /healthz to 503 so the docker healthcheck fails before the
 * orchestrator yanks the container; calling `stop` tears the listener
 * down at the end of graceful shutdown.
 */
export interface AdminServer {
  markShutdown: () => void;
  stop: () => Promise<void>;
}

/**
 * Empty Prometheus exposition body. Comments only — a Prometheus
 * scraper accepts this without parse errors and reports zero series
 * until a registry is injected.
 */
const EMPTY_PROM_EXPOSITION =
  '# HELP worker_metrics_placeholder /metrics has no registry attached yet; this body is intentionally empty.\n' +
  '# TYPE worker_metrics_placeholder gauge\n';

const PROM_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * Boots the admin server. Returns a handle the worker entrypoint uses
 * during shutdown so /healthz reports `shutting_down` for the duration
 * of the drain window. /readyz pings the injected pool + redis on every
 * request — fast and synchronous, no caching, so a transient blip
 * surfaces immediately.
 */
export const startAdminServer = (
  deps: AdminServerDeps,
  port = 9100,
  hostname = '127.0.0.1',
): AdminServer => {
  const { logger, pool, redis, metrics } = deps;
  let shuttingDown = false;

  // Bound each backend probe so a stalled pool or Redis can't hang the
  // readiness response indefinitely. 2s is generous for an in-cluster
  // ping but short enough that the orchestrator's readiness loop sees
  // a real-time signal.
  const READYZ_PROBE_TIMEOUT_MS = 2_000;

  const withTimeout = async <T>(
    p: Promise<T>,
    timeoutMs: number,
    timeoutReason: string,
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(timeoutReason)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const probeReady = async (): Promise<{ ok: boolean; reason?: string }> => {
    try {
      const pg = await withTimeout(
        pool.query('select 1'),
        READYZ_PROBE_TIMEOUT_MS,
        'pg_ping_timeout',
      );
      if (pg.rowCount !== 1) return { ok: false, reason: 'pg_ping_failed' };
    } catch (err) {
      const reason =
        err instanceof Error && err.message === 'pg_ping_timeout'
          ? 'pg_ping_timeout'
          : 'pg_ping_failed';
      logger.warn({ err, reason }, 'readyz_pg_ping_failed');
      return { ok: false, reason };
    }
    try {
      const pong = await withTimeout(redis.ping(), READYZ_PROBE_TIMEOUT_MS, 'redis_ping_timeout');
      if (pong !== 'PONG') return { ok: false, reason: 'redis_ping_failed' };
    } catch (err) {
      const reason =
        err instanceof Error && err.message === 'redis_ping_timeout'
          ? 'redis_ping_timeout'
          : 'redis_ping_failed';
      logger.warn({ err, reason }, 'readyz_redis_ping_failed');
      return { ok: false, reason };
    }
    return { ok: true };
  };

  const server = Bun.serve({
    port,
    // Defaults to loopback: /healthz, /readyz, /metrics are unauthenticated, so
    // under compose they must never be reachable from the LAN (scrapers use
    // localhost / in-container DNS). k8s overrides to 0.0.0.0 because the
    // kubelet probes the pod IP, not loopback. Restrict the exposed port with a
    // default-deny ingress NetworkPolicy (admit only kubelet/monitoring): a
    // Service is not a firewall, and pod IPs are reachable cluster-wide by
    // default.
    hostname,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/healthz') {
        return shuttingDown
          ? new Response('shutting_down', { status: 503 })
          : new Response('ok', { status: 200 });
      }
      if (url.pathname === '/readyz') {
        if (shuttingDown) return new Response('shutting_down', { status: 503 });
        const r = await probeReady();
        return r.ok
          ? new Response('ready', { status: 200 })
          : new Response(r.reason ?? 'not_ready', { status: 503 });
      }
      if (url.pathname === '/metrics') {
        if (metrics) {
          const start = performance.now();
          try {
            const body = await metrics.metrics();
            metrics.observeScrapeDuration((performance.now() - start) / 1000);
            return new Response(body, {
              status: 200,
              headers: { 'content-type': metrics.contentType },
            });
          } catch (err) {
            // Exposition-generation can fail (e.g. a custom collector
            // throws). Surface as 503 so the scrape sees a real error
            // instead of a hang, and log so the regression is visible.
            logger.warn({ err }, 'metrics_exposition_failed');
            return new Response('metrics_unavailable', { status: 503 });
          }
        }
        return new Response(EMPTY_PROM_EXPOSITION, {
          status: 200,
          headers: { 'content-type': PROM_CONTENT_TYPE },
        });
      }
      return new Response('not_found', { status: 404 });
    },
  });
  logger.info({ port, hostname }, 'admin_server_listening');
  return {
    markShutdown: (): void => {
      shuttingDown = true;
    },
    stop: async (): Promise<void> => {
      server.stop();
    },
  };
};
