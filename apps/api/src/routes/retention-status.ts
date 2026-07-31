// GET /retention-status.
//
// Surfaces the worker's action-log-prune + audit-prune cron outcomes to
// the operator UI. The workers write `retention:receipt:<kind>` on every
// run; this route does two `GET`s, validates each, and returns both.
// Missing keys mean the cron has not yet committed since the worker last
// started — the SPA renders that as "never run" rather than failing.

import {
  ErrorEnvelope,
  RetentionReceiptSchema,
  RetentionStatusResponseSchema,
} from '@app/contracts';
import { GLOBAL_KEYS } from '@app/db';
import { createRoute } from '@hono/zod-openapi';
import type { Logger } from 'pino';

import type { DI } from 'di.js';
import { requireUser } from 'middleware/require-user.js';
import { createApiHono, type ApiHono } from 'types.js';

const route = createRoute({
  method: 'get',
  path: '/retention-status',
  tags: ['retention'],
  responses: {
    200: {
      description: 'most recent prune receipt for each retention cron',
      content: { 'application/json': { schema: RetentionStatusResponseSchema } },
    },
    500: {
      description: 'INTERNAL',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

/**
 * Parse one receipt value from Redis. Validation failures degrade to
 * `null` with a warn log so a malformed entry from an older worker build
 * never 500s the dashboard; the operator sees "never run" until the
 * next cron tick rewrites the key.
 */
const parseReceipt = (
  value: string | null,
  logger: Logger,
  kind: string,
): ReturnType<typeof RetentionReceiptSchema.parse> | null => {
  if (value === null) return null;
  try {
    return RetentionReceiptSchema.parse(JSON.parse(value));
  } catch (err) {
    logger.warn({ kind, err: err }, 'retention-status: malformed receipt');
    return null;
  }
};

export const retentionStatusRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/retention-status', requireUser());

  app.openapi(route, async (c) => {
    const logger: Logger = di.logger;
    // `ScopedRedis` does not expose unwrapped `mget`; `.raw()` is the
    // documented escape hatch for global cross-key reads like this one.
    const raw = di.redis.raw();
    // `ioredis.mget` returns `(string|null|undefined)[]` — each slot can
    // be absent. The `?? null` collapses the absent variant onto our null
    // contract so the parser renders both states as "never run".
    const [actionRaw, auditRaw] = await raw.mget(
      GLOBAL_KEYS.retentionReceipt('action-log-prune'),
      GLOBAL_KEYS.retentionReceipt('audit-prune'),
    );
    return c.json(
      {
        actionLogPrune: parseReceipt(actionRaw ?? null, logger, 'action-log-prune'),
        auditPrune: parseReceipt(auditRaw ?? null, logger, 'audit-prune'),
      },
      200,
    );
  });

  return app;
};
