// Operator-settable log retention and deep capture.
//
// This is the ONLY place these horizons are configured. They were env vars, and
// `action_logs` additionally had a TimescaleDB retention policy on a different
// schedule; the two disagreed, the policy won, and the dashboard reported the
// env var — so the table was swept at 7 days while the UI said 30. One owner,
// read by the prune crons on every run.

import {
  ErrorEnvelope,
  RetentionConfigPatch,
  RetentionConfigResponse,
  type RetentionConfigResponse as RetentionConfigResponseType,
} from '@app/contracts';
import { repo } from '@app/db';
import { createRoute } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { requireUser } from 'middleware/require-user.js';
import { requireNotDemo } from 'middleware/require-not-demo.js';
import { createApiHono, type ApiHono } from 'types.js';

const MINUTE_MS = 60_000;

/**
 * Project the stored row for the wire. An armed capture whose deadline has
 * passed is reported as null rather than as an expired window: the worker treats
 * it as off, and a UI that still showed it armed would be lying about what is
 * being written.
 */
const toResponse = (
  row: Awaited<ReturnType<typeof repo.retentionConfig.get>>,
): RetentionConfigResponseType => {
  const { debugCaptureProfileId: profileId, debugCaptureUntil: until } = row;
  const armed = profileId !== null && until !== null && until.getTime() > Date.now();
  return {
    actionLogDays: row.actionLogDays,
    actionLogMaxRows: row.actionLogMaxRows,
    auditLogDays: row.auditLogDays,
    auditStreamMaxlen: row.auditStreamMaxlen,
    debugCapture: armed ? { profileId, until: until.toISOString() } : null,
    updatedAt: row.updatedAt.toISOString(),
  };
};

const getRoute = createRoute({
  method: 'get',
  path: '/retention-config',
  tags: ['retention'],
  responses: {
    200: {
      description: 'current retention settings',
      content: { 'application/json': { schema: RetentionConfigResponse } },
    },
  },
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/retention-config',
  tags: ['retention'],
  request: { body: { content: { 'application/json': { schema: RetentionConfigPatch } } } },
  responses: {
    200: {
      description: 'updated retention settings',
      content: { 'application/json': { schema: RetentionConfigResponse } },
    },
    422: {
      description: 'VALIDATION_FAILED',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

export const retentionConfigRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/retention-config', requireUser());
  // Lowering a horizon deletes rows on the next sweep and cannot be undone, so
  // the write stays off in the public demo. The read is harmless and stays on.
  app.on('PATCH', '/retention-config', requireNotDemo(di));

  app.openapi(getRoute, async (c) =>
    c.json(toResponse(await repo.retentionConfig.get(di.db)), 200),
  );

  // No worker resync: the prune crons read this row on every run and the audit
  // shipper/drainer re-read it on a short TTL, so a change applies without a
  // restart.
  app.openapi(patchRoute, async (c) => {
    const body = c.req.valid('json');
    // The client sends a duration, never a deadline: the server owning the clock
    // is what guarantees an armed capture actually lapses, whatever the
    // browser's clock says.
    const capture =
      body.debugCapture === undefined
        ? {}
        : body.debugCapture === null
          ? { debugCaptureProfileId: null, debugCaptureUntil: null }
          : {
              debugCaptureProfileId: body.debugCapture.profileId,
              debugCaptureUntil: new Date(Date.now() + body.debugCapture.minutes * MINUTE_MS),
            };
    const row = await repo.retentionConfig.update(di.db, {
      ...(body.actionLogDays !== undefined ? { actionLogDays: body.actionLogDays } : {}),
      ...(body.actionLogMaxRows !== undefined ? { actionLogMaxRows: body.actionLogMaxRows } : {}),
      ...(body.auditLogDays !== undefined ? { auditLogDays: body.auditLogDays } : {}),
      ...(body.auditStreamMaxlen !== undefined
        ? { auditStreamMaxlen: body.auditStreamMaxlen }
        : {}),
      ...capture,
    });
    c.set('auditEvent', {
      event: 'set-retention-config',
      payload: {
        actionLogDays: row.actionLogDays,
        actionLogMaxRows: row.actionLogMaxRows,
        auditLogDays: row.auditLogDays,
        auditStreamMaxlen: row.auditStreamMaxlen,
        debugCaptureProfileId: row.debugCaptureProfileId,
      },
    });
    return c.json(toResponse(row), 200);
  });

  return app;
};
