// A cap on the request body every `/api` route is willing to read.
//
// Two properties, and the second is the one that bites. The cap must refuse an oversized body in the project envelope — and it must not, in doing so, hand an unauthenticated caller a larger allocation budget than it took away. `bodyLimit` decides a `Content-Length` request from the header alone, but a chunked one has no header, so it READS the stream and buffers every chunk until the total crosses `maxSize`. A per-path ceiling at the global layer, which sits above `sessionResolver`, would therefore let an anonymous `POST /api/restore` make the process buffer gigabytes. The exempt path is skipped globally and capped inside the backup router instead, behind that router's own guards.

import { describe, expect, it, vi } from 'vitest';
import { createMetricsRegistry } from '@app/observability';
import type { DI } from '../../src/di.js';

// `hono/bun` destructures `Bun.write` at module scope, and vitest runs this suite under Node. Two modules `createApp` pulls in import it — the WS router and the static-asset server — so the global is stubbed rather than either module mocked: stubbing keeps the real `createApp` and the real middleware chain, which is the whole point of this file. `mount.ts` excludes the WS router from the shared mount list for the same underlying reason.
vi.stubGlobal('Bun', { write: async () => undefined });

const { createApp } = await import('../../src/app.js');
import {
  DEFAULT_MAX_BODY_BYTES,
  LARGE_BODY_ROUTES,
  RESTORE_MAX_BODY_BYTES,
  requestBodyLimit,
  restoreBodyLimit,
} from '../../src/middleware/body-limit.js';
import { errorHandler } from '../../src/middleware/error.js';
import { mountApiRouters } from '../../src/routes/mount.js';
import { createApiHono, type ApiHono } from '../../src/types.js';

/** A bare app carrying only the global cap and two echo endpoints, so the assertions read the middleware and nothing else. */
const cappedApp = (): ApiHono => {
  const app = createApiHono();
  app.use('*', requestBodyLimit());
  app.post('/api/echo', async (c) => c.json({ length: (await c.req.text()).length }));
  app.post('/api/restore', async (c) => c.json({ length: (await c.req.text()).length }));
  return app;
};

/** The restore cap as the backup router mounts it: after the guards, on that path only. */
const restoreCappedApp = (): ApiHono => {
  const app = createApiHono();
  app.use('/api/restore', restoreBodyLimit());
  app.post('/api/restore', async (c) => c.json({ length: (await c.req.text()).length }));
  return app;
};

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child(): unknown {
    return this;
  },
} as unknown as Parameters<typeof errorHandler>[0];

/** The production mount list under the production error handler, so a guard's refusal surfaces as the envelope it really produces rather than as a bare trap. */
const realApp = (): ApiHono => {
  const app = createApiHono();
  mountApiRouters(app, { env: { LIVE_DEMO: false } } as DI);
  app.onError(errorHandler(silentLogger));
  return app;
};

const body = (bytes: number): string => 'x'.repeat(bytes);

/** A body with no `Content-Length`, which is the branch that buffers rather than reading a header. */
const chunked = (bytes: number): RequestInit => {
  const chunk = new TextEncoder().encode('x'.repeat(1024));
  let sent = 0;
  return {
    method: 'POST',
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= bytes) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        sent += chunk.length;
      },
    }),
    // Required by the fetch spec for a streaming request body; without it `new Request` throws.
    duplex: 'half',
  } as RequestInit;
};

describe('request body limit', () => {
  it('answers 413 in the repo error envelope when the body exceeds the cap', async () => {
    // The envelope matters as much as the status. The SPA switches on `error.code`, so a bare Hono 413 with a text body is an error it cannot render and a code it cannot branch on.
    const res = await cappedApp().request('/api/echo', {
      method: 'POST',
      body: body(DEFAULT_MAX_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      error: { code: 'PAYLOAD_TOO_LARGE', message: expect.any(String) },
    });
  });

  it('answers 413 for an oversized body that carries no content-length', async () => {
    // The branch every other case here misses: a string body always sets `Content-Length`, so the header shortcut decides it and the streaming counter never runs. A chunked body is the shape that makes the cap allocate, and it is the shape an attacker picks.
    const res = await cappedApp().request('/api/echo', chunked(DEFAULT_MAX_BODY_BYTES + 4096));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  });

  it('passes a body within the cap through untouched', async () => {
    // The discriminating half. A cap that rejected everything would satisfy the test above and break every write route in the product.
    const res = await cappedApp().request('/api/echo', { method: 'POST', body: body(1024) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ length: 1024 });
  });

  it('lets a body at exactly the cap through', async () => {
    // Pins which side of the comparison the boundary sits on; an off-by-one here rejects a body the documented limit allows.
    const res = await cappedApp().request('/api/echo', {
      method: 'POST',
      body: body(DEFAULT_MAX_BODY_BYTES),
    });
    expect(res.status).toBe(200);
  });

  it('stands aside for the restore path instead of granting it a larger ceiling', async () => {
    // The security property. `bodyLimit` reads a chunked body to count it, so a 2 GiB ceiling HERE — above `sessionResolver` — would be a 2 GiB pre-auth allocation budget. Standing aside reads nothing at this layer and leaves the refusal to the backup router's own guards.
    const oversized = DEFAULT_MAX_BODY_BYTES + 1;
    const res = await cappedApp().request('/api/restore', {
      method: 'POST',
      body: body(oversized),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ length: oversized });
  });

  it('caps the restore upload at the archive ceiling once its own middleware runs', async () => {
    // The other half of the split: skipping globally is only safe because the route really is capped somewhere. This is the mounting the backup router performs after `requireUser` and `requireNotDemo`.
    expect(RESTORE_MAX_BODY_BYTES).toBeGreaterThan(DEFAULT_MAX_BODY_BYTES);
    const app = restoreCappedApp();
    const under = await app.request('/api/restore', {
      method: 'POST',
      body: body(DEFAULT_MAX_BODY_BYTES + 1),
    });
    expect(under.status).toBe(200);
    const over = await app.request('/api/restore', {
      method: 'POST',
      headers: { 'content-length': String(RESTORE_MAX_BODY_BYTES + 1) },
      body: body(1024),
    });
    expect(over.status).toBe(413);
  });

  it('refuses an anonymous restore upload before any of it is read', async () => {
    // The defect this split exists to close. `requireUser` sits ahead of the restore cap inside the backup router, so an anonymous caller is answered 401 and the streaming counter never touches the body. `bodyUsed` false is the proof: had a cap run first, counting a chunked body would have consumed the stream.
    const app = realApp();
    const init = chunked(DEFAULT_MAX_BODY_BYTES * 4);
    const request = new Request('http://local.test/api/restore', init);
    const res = await app.fetch(request);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(request.bodyUsed).toBe(false);
  });

  it('keys every exemption on a concrete path the production mount list actually serves', () => {
    // Two failure modes, and the second is the one a route-table check alone would miss. The middleware matches `c.req.path`, a CONCRETE path, so a pattern spelling like `/api/accounts/:accountId/restore` would be found in the route table, pass a membership check, and never match a single real request — a silently dead exemption.
    const mounted = new Set(realApp().routes.map((route) => route.path));
    expect(LARGE_BODY_ROUTES.size).toBeGreaterThan(0);
    for (const path of LARGE_BODY_ROUTES) {
      expect([...mounted]).toContain(path);
      expect(path).not.toMatch(/[:*]/);
    }
  });

  it('reaches a real handler at POST /api/restore rather than a 404', async () => {
    // Route-table membership is not the same as the router matching the path — a mount prefix mismatch produces an entry that no request ever reaches. A 404 here is what a wrong exemption path looks like from the outside; anything else means the router matched and the chain ran.
    const res = await realApp().request('/api/restore', { method: 'POST' });
    expect(res.status).not.toBe(404);
  });
});

describe('the cap is mounted on the app the server actually serves', () => {
  // Every other case here builds its own harness, and `_helpers.ts` rebuilds the router list rather than calling `createApp`. Deleting the `app.use('*', requestBodyLimit())` line would therefore leave the whole repo green while the control vanished from the running server. This is the one test that drives `createApp` itself.
  const stubDi = (): DI =>
    ({
      env: { WEB_ORIGIN: 'http://local.test', WEB_DIST_DIR: null, LIVE_DEMO: false },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
        child() {
          return this;
        },
      },
      metrics: createMetricsRegistry({ service: 'api-test' }),
      redis: {},
      db: {},
      auth: { handler: async () => new Response(null, { status: 404 }), api: {} },
      demoOperatorId: null,
    }) as unknown as DI;

  it('answers 413 from createApp itself', async () => {
    const { app } = createApp(stubDi());
    const res = await app.request('/api/echo-not-a-route', {
      method: 'POST',
      body: body(DEFAULT_MAX_BODY_BYTES + 1),
    });
    // 413, not the 404 the unmatched path would otherwise produce: the cap runs as global middleware, ahead of routing.
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  });
});
