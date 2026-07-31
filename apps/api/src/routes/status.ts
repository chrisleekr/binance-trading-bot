// GET /status.
//
// Public build-and-liveness snapshot for the operator status bar: the api's
// own SHA + boot time, the worker's last-written heartbeat (sha + boot time),
// and the latest applied DB migration timestamp. Leaks only SHAs and
// timestamps, so it carries no `requireUser` — the operator needs it before a
// session is established (e.g. after a deploy mismatch).

import { ErrorEnvelope, StatusResponse } from '@app/contracts';
import { FLEET_COUNT_KEY, parseFleetCount } from '@app/db';
import { createRoute } from '@hono/zod-openapi';

import type { DI } from 'di.js';
import { createApiHono, type ApiHono } from 'types.js';

// Bare ioredis keys the worker writes its heartbeats under (no scope prefix).
// The worker sets the identical literals so the api reads the same bytes. The
// live and study workers write separate keys.
const WORKER_STATUS_KEY = 'worker:status';
const WORKER_STUDY_STATUS_KEY = 'worker:study-status';

const route = createRoute({
  method: 'get',
  path: '/status',
  tags: ['status'],
  responses: {
    200: {
      description: 'build SHAs + boot times for api/worker and the latest migration timestamp',
      content: { 'application/json': { schema: StatusResponse } },
    },
    500: {
      description: 'INTERNAL',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

/**
 * Parse a worker heartbeat value (the live or study key — identical shape). An
 * absent key (worker down / not yet written) or a malformed payload both degrade
 * to `null` so the panel renders "down" rather than 500ing the whole status
 * surface. Exported so the degrade-to-null contract is unit-testable without
 * standing up Redis (the route suite itself is infra-gated).
 */
export const parseHeartbeat = (value: string | null): StatusResponse['worker'] => {
  if (value === null) return null;
  try {
    return StatusResponse.shape.worker.parse(JSON.parse(value));
  } catch {
    return null;
  }
};

export const statusRouter = (di: DI): ApiHono => {
  const app = createApiHono();

  app.openapi(route, async (c) => {
    const raw = di.redis.raw();
    // The worker publishes the fleet count on its heartbeat; read it O(1) rather
    // than SCANning the keyspace on this unauthenticated route.
    const [workerRaw, studyRaw, fleetRaw] = await Promise.all([
      raw.get(WORKER_STATUS_KEY),
      raw.get(WORKER_STUDY_STATUS_KEY),
      raw.get(FLEET_COUNT_KEY),
    ]);

    // `_app_migrations.applied_at` is set per applied migration; the max is the
    // latest schema change this DB has seen. Null when the table is empty.
    const migrationRes = await di.pool.query<{ t: Date | null }>(
      'select max(applied_at) as t from _app_migrations',
    );
    const latest = migrationRes.rows[0]?.t ?? null;

    const body: StatusResponse = {
      api: { sha: di.gitSha, bootedAt: di.bootedAt },
      worker: parseHeartbeat(workerRaw),
      study: parseHeartbeat(studyRaw),
      db: { latestMigrationAppliedAt: latest ? latest.toISOString() : null },
      fleet: parseFleetCount(fleetRaw),
    };
    return c.json(StatusResponse.parse(body), 200);
  });

  return app;
};
