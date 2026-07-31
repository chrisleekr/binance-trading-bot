import { asProfileId, ErrorEnvelope, SymbolDisableRequest } from '@app/contracts';
import { profileKey } from '@app/db';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { requireUser } from 'middleware/require-user.js';
import { scopeOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

const SymbolParam = z.object({
  profileId: z.uuid(),
  symbol: z.string().min(1).max(32),
});
const ProfileIdParam = z.object({ profileId: z.uuid() });

const symbolDisableRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/symbols/{symbol}/disable',
  tags: ['kill-switch'],
  request: {
    params: SymbolParam,
    body: { content: { 'application/json': { schema: SymbolDisableRequest } } },
  },
  responses: {
    204: { description: 'symbol disabled' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const symbolEnableRoute = createRoute({
  method: 'delete',
  path: '/profiles/{profileId}/symbols/{symbol}/disable',
  tags: ['kill-switch'],
  request: { params: SymbolParam },
  responses: {
    204: { description: 'symbol re-enabled' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const profileDisableRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/disable-all',
  tags: ['kill-switch'],
  request: { params: ProfileIdParam },
  responses: {
    204: { description: 'profile kill-switch on' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const profileEnableRoute = createRoute({
  method: 'delete',
  path: '/profiles/{profileId}/disable-all',
  tags: ['kill-switch'],
  request: { params: ProfileIdParam },
  responses: {
    204: { description: 'profile kill-switch off' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

export const killSwitchRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/profiles/*', requireUser());

  app.openapi(symbolDisableRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const profileId = asProfileId(profileIdRaw);
    const body = c.req.valid('json');
    const p = await scopeOf(c, di, profileId);
    const { accountId } = p.scope;
    await di.redis
      .raw()
      .set(
        profileKey({ accountId, profileId }, 'disableAction', symbol),
        JSON.stringify({ reason: body.reason, since: new Date().toISOString() }),
        'EX',
        body.ttlSeconds,
      );
    c.set('auditEvent', {
      event: 'disable-symbol',
      payload: { profileId, symbol, ttlSeconds: body.ttlSeconds },
    });
    return new Response(null, { status: 204 });
  });

  app.openapi(symbolEnableRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const profileId = asProfileId(profileIdRaw);
    const p = await scopeOf(c, di, profileId);
    const { accountId } = p.scope;
    await di.redis.raw().del(profileKey({ accountId, profileId }, 'disableAction', symbol));
    c.set('auditEvent', { event: 'enable-symbol', payload: { profileId, symbol } });
    return new Response(null, { status: 204 });
  });

  app.openapi(profileDisableRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const p = await scopeOf(c, di, profileId);
    const { accountId } = p.scope;
    await di.redis.raw().set(profileKey({ accountId, profileId }, 'killSwitch'), '1');
    c.set('auditEvent', { event: 'kill-switch-on', payload: { profileId } });
    return new Response(null, { status: 204 });
  });

  app.openapi(profileEnableRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const p = await scopeOf(c, di, profileId);
    const { accountId } = p.scope;
    await di.redis.raw().del(profileKey({ accountId, profileId }, 'killSwitch'));
    c.set('auditEvent', { event: 'kill-switch-off', payload: { profileId } });
    return new Response(null, { status: 204 });
  });

  return app;
};
