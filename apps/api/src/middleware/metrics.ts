import type { MiddlewareHandler } from 'hono';
import { Counter, Histogram, type Registry } from '@app/observability';
import type { Env } from 'types.js';

/**
 * HTTP request metrics for the API. The `route` label is the matched
 * route pattern (e.g. `/api/profiles/:id`), never the raw URL, so path
 * parameters cannot explode series cardinality. The `status` label
 * carries the error signal: `http_requests_total{status=~"5.."}` is the
 * 5xx rate, so no separate error counter is needed.
 *
 * `app.onError` converts a thrown handler error into a response before
 * `next()` resolves, so `c.res.status` is always the final status the
 * client sees — including for errored requests.
 */
export const httpMetrics = (registry: Registry): MiddlewareHandler<Env> => {
  const requests = new Counter({
    name: 'http_requests_total',
    help: 'Total API HTTP requests, labelled by method, matched route and status code.',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'API HTTP request latency in seconds, labelled by method, matched route and status code.',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  return async (c, next) => {
    const start = performance.now();
    try {
      await next();
    } finally {
      const labels = {
        method: c.req.method,
        route: c.req.routePath,
        status: String(c.res.status),
      };
      requests.inc(labels);
      duration.observe(labels, (performance.now() - start) / 1000);
    }
  };
};
