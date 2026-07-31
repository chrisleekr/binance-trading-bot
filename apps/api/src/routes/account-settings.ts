// GET/PATCH /account/settings — the operator's account-global display
// preferences. Today just the display timezone, which the web app applies to
// every rendered timestamp. User-scoped (the master Better Auth row), not
// profile-scoped, so it reads c.var.userId directly rather than a ProfileScope.

import { AccountSettingsResponse, ErrorEnvelope, UpdateTimezoneRequest } from '@app/contracts';
import { repo } from '@app/db';
import { createRoute } from '@hono/zod-openapi';

import type { DI } from 'di.js';
import { HttpError } from 'middleware/error.js';
import { requireUser } from 'middleware/require-user.js';
import { userIdOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

const getRoute = createRoute({
  method: 'get',
  path: '/account/settings',
  tags: ['account'],
  responses: {
    200: {
      description: 'account display settings',
      content: { 'application/json': { schema: AccountSettingsResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/account/settings',
  tags: ['account'],
  request: {
    body: { content: { 'application/json': { schema: UpdateTimezoneRequest } } },
  },
  responses: {
    200: {
      description: 'updated',
      content: { 'application/json': { schema: AccountSettingsResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

export const accountSettingsRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/account/settings', requireUser());

  app.openapi(getRoute, async (c) => {
    const userId = userIdOf(c);
    const user = await repo.users.findById(di.db, userId);
    if (!user) throw new HttpError('NOT_FOUND', 'user');
    return c.json({ timezone: user.timezone }, 200);
  });

  app.openapi(patchRoute, async (c) => {
    const userId = userIdOf(c);
    const { timezone } = c.req.valid('json');
    const updated = await repo.users.update(di.db, userId, { timezone });
    c.set('auditEvent', { event: 'set-account-timezone', payload: { timezone } });
    return c.json({ timezone: updated.timezone }, 200);
  });

  return app;
};
