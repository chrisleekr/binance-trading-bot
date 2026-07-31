import { ActionLogErrorsResponse, asProfileId, ErrorEnvelope } from '@app/contracts';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { requireUser } from 'middleware/require-user.js';
import { scopeOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

const ProfileIdParam = z.object({ profileId: z.uuid() });

// Small default page size: the dashboard activity feed merges this tail with
// audit and discovery rows and only renders a dozen, so a large window is
// wasted work. Cap at 200 to match the audit reader's ceiling.
const ActionLogErrorsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

const route = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/action-logs',
  tags: ['action-logs'],
  request: { params: ProfileIdParam, query: ActionLogErrorsQuery },
  responses: {
    200: {
      description: 'recent warn+error action-log entries scoped to this profile',
      content: { 'application/json': { schema: ActionLogErrorsResponse } },
    },
    422: {
      description: 'VALIDATION_FAILED',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

/**
 * `GET /profiles/:id/action-logs` — profile-scoped warn+error reader.
 *
 * Surfaces the worker's recent failures (rejected orders, degraded reads) for
 * the dashboard activity feed's Errors chip. The 404-on-missing-profile check
 * matches every other profile-scoped route in this tree, so a deleted id is a
 * clear NOT_FOUND rather than a silently empty list.
 */
export const actionLogsRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/profiles/*/action-logs', requireUser());

  app.openapi(route, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const { limit } = c.req.valid('query');
    const p = await scopeOf(c, di, profileId);
    const rows = await p.actionLogs.listErrorsForProfile(limit);
    return c.json(
      {
        items: rows.map((r) => ({
          time: r.time.toISOString(),
          symbol: r.symbol,
          level: r.level,
          msg: r.msg,
          ctx: r.ctx,
        })),
      },
      200,
    );
  });

  return app;
};
