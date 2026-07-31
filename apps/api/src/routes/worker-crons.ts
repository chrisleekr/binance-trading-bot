// GET /worker/crons — per-cron last-run health for the ops panel.
//
// Reads the `worker:cron-status` Redis hash the worker's cron-status recorder
// writes on every run (field = cron name, value = JSON record). The single-
// replica worker's self-rescheduling crons are otherwise invisible; this lets
// the operator see which last ran and whether they errored. Read-only.

import { CronStatusEntry, ErrorEnvelope, WorkerCronsResponse } from '@app/contracts';
import { GLOBAL_KEYS } from '@app/db';
import { createRoute } from '@hono/zod-openapi';

import type { DI } from 'di.js';
import { requireUser } from 'middleware/require-user.js';
import { createApiHono, type ApiHono } from 'types.js';

const route = createRoute({
  method: 'get',
  path: '/worker/crons',
  tags: ['worker'],
  responses: {
    200: {
      description: 'per-cron last-run status, newest run first',
      content: { 'application/json': { schema: WorkerCronsResponse } },
    },
    500: { description: 'INTERNAL', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

export const workerCronsRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/worker/crons', requireUser());

  app.openapi(route, async (c) => {
    const hash = await di.redis.raw().hgetall(GLOBAL_KEYS.cronStatus());
    const crons = Object.entries(hash ?? {})
      .map(([name, raw]) => {
        // A malformed field is skipped rather than 500ing the whole panel; the
        // next cron run rewrites it.
        try {
          return CronStatusEntry.parse({ name, ...(JSON.parse(raw) as Record<string, unknown>) });
        } catch {
          return null;
        }
      })
      .filter((e): e is CronStatusEntry => e !== null)
      .sort((a, b) => b.lastRunAtMs - a.lastRunAtMs);

    return c.json({ asOf: new Date().toISOString(), crons }, 200);
  });

  return app;
};
