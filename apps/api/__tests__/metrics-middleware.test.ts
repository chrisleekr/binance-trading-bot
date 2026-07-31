import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createMetricsRegistry } from '@app/observability';

import { httpMetrics } from '../src/middleware/metrics.js';
import { healthRouter } from '../src/routes/health.js';
import type { DI } from '../src/di.js';
import type { Env } from '../src/types.js';

describe('httpMetrics middleware', () => {
  const buildApp = () => {
    const registry = createMetricsRegistry({ service: 'api-test' }).registry;
    const app = new Hono<Env>();
    app.use('*', httpMetrics(registry));
    app.get('/ok', (c) => c.text('ok'));
    app.get('/boom', () => {
      throw new Error('boom');
    });
    app.onError((_err, c) => c.text('handled', 500));
    return { app, registry };
  };

  it('records http_requests_total with method, route and status labels', async () => {
    const { app, registry } = buildApp();
    await app.request('/ok');
    const body = await registry.metrics();
    expect(body).toContain('http_requests_total');
    expect(body).toMatch(
      /http_requests_total\{[^}]*method="GET"[^}]*route="\/ok"[^}]*status="200"/,
    );
  });

  it('records a latency histogram for the request', async () => {
    const { app, registry } = buildApp();
    await app.request('/ok');
    const body = await registry.metrics();
    expect(body).toContain('http_request_duration_seconds');
    expect(body).toMatch(/http_request_duration_seconds_count\{[^}]*route="\/ok"/);
  });

  it('counts a thrown handler error with the onError-mapped status', async () => {
    const { app, registry } = buildApp();
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    const body = await registry.metrics();
    expect(body).toMatch(/http_requests_total\{[^}]*route="\/boom"[^}]*status="500"/);
  });

  it('labels a mounted sub-app param route with the bounded pattern', async () => {
    const registry = createMetricsRegistry({ service: 'api-test' }).registry;
    const app = new Hono<Env>();
    app.use('*', httpMetrics(registry));
    const sub = new Hono<Env>();
    sub.get('/profiles/:id', (c) => c.text(c.req.param('id')));
    app.route('/api', sub);
    await app.request('/api/profiles/abc-123-uuid');
    const body = await registry.metrics();
    // The route label must be the pattern, not the concrete id, or a
    // UUID path param would explode series cardinality.
    expect(body).not.toContain('abc-123-uuid');
    expect(body).toMatch(/http_requests_total\{[^}]*route="\/api\/profiles\/:id"/);
  });

  it('records an unmatched 404 request without throwing', async () => {
    const { app, registry } = buildApp();
    const res = await app.request('/no-such-path');
    expect(res.status).toBe(404);
    // Hono reports the wildcard middleware path for unmatched requests,
    // so the route label is a bounded string and prom-client never sees
    // an undefined label value.
    const body = await registry.metrics();
    expect(body).toMatch(/http_requests_total\{[^}]*route="\/\*"[^}]*status="404"/);
  });

  it('accumulates the counter across repeated requests', async () => {
    const { app, registry } = buildApp();
    await app.request('/ok');
    await app.request('/ok');
    const body = await registry.metrics();
    const line = body
      .split('\n')
      .find((l) => l.startsWith('http_requests_total{') && l.includes('route="/ok"'));
    expect(line?.trim().endsWith(' 2')).toBe(true);
  });
});

describe('GET /metrics', () => {
  const di = {
    metrics: createMetricsRegistry({ service: 'api' }),
  } as unknown as DI;

  it('serves the Prometheus exposition, not the old placeholder', async () => {
    const { router } = healthRouter(di);
    const res = await router.request('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).not.toContain('not yet wired');
    // A real prom-client exposition carries HELP lines and the default
    // process metrics registered by createMetricsRegistry.
    expect(body).toContain('# HELP');
    expect(body).toContain('process_cpu_seconds_total');
  });
});
