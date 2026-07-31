// GET/PATCH /account/ops-notify — the account-global ops notification toggles
// (which operational events, like a dead-lettered job, send a notification).
// Singleton config, not profile-scoped, so it reads the db directly rather than
// a ProfileScope. The worker reads ops_notify_config when an ops event fires, so
// a change takes effect with no restart.

import { ErrorEnvelope, OpsNotifyConfig } from '@app/contracts';
import { repo } from '@app/db';
import { createRoute } from '@hono/zod-openapi';

import type { DI } from 'di.js';
import { requireUser } from 'middleware/require-user.js';
import { requireNotDemo } from 'middleware/require-not-demo.js';
import { createApiHono, type ApiHono } from 'types.js';

const getRoute = createRoute({
  method: 'get',
  path: '/account/ops-notify',
  tags: ['account'],
  responses: {
    200: {
      description: 'account ops notification toggles',
      content: { 'application/json': { schema: OpsNotifyConfig } },
    },
    500: { description: 'INTERNAL', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/account/ops-notify',
  tags: ['account'],
  request: {
    body: { content: { 'application/json': { schema: OpsNotifyConfig } } },
  },
  responses: {
    200: {
      description: 'updated',
      content: { 'application/json': { schema: OpsNotifyConfig } },
    },
    500: { description: 'INTERNAL', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

export const opsNotifyRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/account/ops-notify', requireUser());
  // Visitors must not redirect the operator's notifications — off in demo.
  app.use('/account/ops-notify', requireNotDemo(di));

  app.openapi(getRoute, async (c) => {
    const row = await repo.opsNotifyConfig.get(di.db);
    // Empty/partial column → the contract defaults (every ops category on).
    return c.json(OpsNotifyConfig.parse(row.events ?? {}), 200);
  });

  app.openapi(patchRoute, async (c) => {
    const body = c.req.valid('json');
    const updated = await repo.opsNotifyConfig.setEvents(di.db, body);
    c.set('auditEvent', { event: 'set-ops-notify-config', payload: {} });
    return c.json(OpsNotifyConfig.parse(updated.events ?? {}), 200);
  });

  return app;
};
