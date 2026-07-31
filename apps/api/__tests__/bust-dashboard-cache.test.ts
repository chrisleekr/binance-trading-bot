import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createRoute, z } from '@hono/zod-openapi';
import { dashboardAggregateCacheKey, profileKey, type ScopedRedis } from '@app/db';
import type { AccountId, UserId, ProfileId } from '@app/contracts';

import { bustDashboardCache } from '../src/middleware/bust-dashboard-cache.js';
import { createApiHono } from '../src/types.js';
import type { Env } from '../src/types.js';

// Flatten a vi spy's recorded call into the set of redis keys passed, whether
// the helper invokes `del(k1, k2)` (variadic) or `del([k1, k2])` (array). The
// production helper owns the exact arg form; the test pins the keys, not the
// calling convention.
const keysFromCall = (call: unknown[]): string[] => call.flat() as string[];

describe('bustDashboardCache middleware', () => {
  const userId = 'user-1' as UserId;
  // Dashboard caches are keyed by account; only account-scoped routes carry
  // `:accountId`, so every route below is mounted under it.
  const accountId = 'acc-1' as AccountId;

  const buildApp = (opts: { authed: boolean; delImpl?: () => Promise<number> }) => {
    const del = vi.fn(opts.delImpl ?? (async () => 1));
    const fakeRedis = { raw: () => ({ del }) } as unknown as ScopedRedis;

    const app = new Hono<Env>();
    app.use('*', async (c, next) => {
      if (opts.authed) c.set('userId', userId);
      await next();
    });
    app.use('*', bustDashboardCache(fakeRedis));

    app.post('/accounts/:accountId/profiles/:profileId/symbols/:symbol', (c) =>
      c.json({ ok: true }),
    );
    app.post('/accounts/:accountId/kill-switch', (c) => c.json({ ok: true }));
    app.post('/accounts/:accountId/created', (c) => c.json({ ok: true }, 201));
    app.post('/accounts/:accountId/no-content', (c) => c.body(null, 204));
    app.get('/accounts/:accountId/profiles/:profileId/dashboard', (c) => c.json({ ok: true }));
    app.post('/accounts/:accountId/profiles/:profileId/conflict', (c) =>
      c.json({ err: true }, 409),
    );
    // Operator-global route: no `:accountId`, so no dashboard cache to bust.
    app.post('/strategies', (c) => c.json({ ok: true }));
    app.post('/accounts/:accountId/boom', () => {
      throw new Error('boom');
    });
    app.onError((_e, c) => c.json({ error: true }, 500));

    return { app, del };
  };

  it('C1: authed 2xx non-GET with no profileId busts only the per-account aggregate key', async () => {
    const { app, del } = buildApp({ authed: true });
    const res = await app.request(`/accounts/${accountId}/kill-switch`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(del).toHaveBeenCalledTimes(1);
    expect(keysFromCall(del.mock.calls[0] ?? [])).toEqual([dashboardAggregateCacheKey(accountId)]);
  });

  it('C1b: a 201 Created (e.g. add-symbol) still busts the cache', async () => {
    const { app, del } = buildApp({ authed: true });
    const res = await app.request(`/accounts/${accountId}/created`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('C1c: a 204 No Content (the start/stop status) still busts the cache', async () => {
    const { app, del } = buildApp({ authed: true });
    const res = await app.request(`/accounts/${accountId}/no-content`, { method: 'POST' });
    expect(res.status).toBe(204);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('C2: authed 2xx non-GET with a profileId busts the aggregate and per-profile keys', async () => {
    const { app, del } = buildApp({ authed: true });
    const res = await app.request(`/accounts/${accountId}/profiles/p1/symbols/BTCUSDT`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(del).toHaveBeenCalledTimes(1);
    const keys = keysFromCall(del.mock.calls[0] ?? []);
    expect(keys).toContain(dashboardAggregateCacheKey(accountId));
    expect(keys).toContain(
      profileKey({ accountId, profileId: 'p1' as ProfileId }, 'dashboardCache'),
    );
  });

  it('C3: a GET request never busts the cache', async () => {
    const { app, del } = buildApp({ authed: true });
    const res = await app.request(`/accounts/${accountId}/profiles/p1/dashboard`, {
      method: 'GET',
    });
    expect(res.status).toBe(200);
    expect(del).not.toHaveBeenCalled();
  });

  it('C4a: a non-2xx (409) response never busts the cache', async () => {
    const { app, del } = buildApp({ authed: true });
    const res = await app.request(`/accounts/${accountId}/profiles/p1/conflict`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    expect(del).not.toHaveBeenCalled();
  });

  it('C4b: a thrown handler (mapped to 500) never busts the cache', async () => {
    const { app, del } = buildApp({ authed: true });
    const res = await app.request(`/accounts/${accountId}/boom`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(del).not.toHaveBeenCalled();
  });

  it('C4c: an operator-global route with no :accountId never busts the cache', async () => {
    const { app, del } = buildApp({ authed: true });
    const res = await app.request('/strategies', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(del).not.toHaveBeenCalled();
  });

  it('C5: an unauthenticated request never busts the cache and still succeeds', async () => {
    const { app, del } = buildApp({ authed: false });
    const res = await app.request(`/accounts/${accountId}/kill-switch`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(del).not.toHaveBeenCalled();
  });

  it('C6: a redis failure is swallowed and never turns a 2xx into a 5xx', async () => {
    const { app, del } = buildApp({
      authed: true,
      delImpl: async () => {
        throw new Error('redis down');
      },
    });
    const res = await app.request(`/accounts/${accountId}/kill-switch`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(del).toHaveBeenCalledTimes(1);
  });

  // Production fidelity: the unit cases above use plain Hono. Production mounts
  // on OpenAPIHono (createApiHono) with routes on a child router joined via
  // app.route('/api/accounts/:accountId', child) and declared with {profileId}
  // brace syntax. This proves the wildcard middleware still resolves
  // c.req.param('accountId'/'profileId') post-next under that exact topology, so
  // the per-profile key is busted in the real app — guards against a Hono
  // upgrade silently breaking C2.
  it('C2-prod: busts both keys under the real OpenAPIHono + app.route topology', async () => {
    const del = vi.fn(async () => 1);
    const fakeRedis = { raw: () => ({ del }) } as unknown as ScopedRedis;

    const app = createApiHono();
    app.use('*', async (c, next) => {
      c.set('userId', userId);
      await next();
    });
    app.use('*', bustDashboardCache(fakeRedis));

    const child = createApiHono();
    child.openapi(
      createRoute({
        method: 'post',
        path: '/profiles/{profileId}/symbols/{symbol}',
        request: { params: z.object({ profileId: z.string(), symbol: z.string() }) },
        responses: { 200: { description: 'ok' } },
      }),
      (c) => c.json({ ok: true }),
    );
    app.route('/api/accounts/:accountId', child);

    const res = await app.request(`/api/accounts/${accountId}/profiles/p1/symbols/BTCUSDT`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const keys = keysFromCall(del.mock.calls[0] ?? []);
    expect(keys).toContain(dashboardAggregateCacheKey(accountId));
    expect(keys).toContain(
      profileKey({ accountId, profileId: 'p1' as ProfileId }, 'dashboardCache'),
    );
  });
});
