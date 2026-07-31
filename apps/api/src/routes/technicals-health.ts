// GET /technicals/health.
//
// Surfaces the worker's per-interval `technicals-compute` outcome to the
// operator UI without scraping pino. The worker writes
// `technicals:fetch-status:<interval>` on every commit; this route
// enumerates the keys via `SCAN`, parses each, and returns the list.
// Missing keys mean the cron has not committed in the key TTL window
// (300s) — the dashboard renders the empty-list state as "technicals
// silent" rather than failing.

import {
  ErrorEnvelope,
  TechnicalsFetchStatusSchema,
  TechnicalsHealthResponseSchema,
} from '@app/contracts';
import { createRoute, z } from '@hono/zod-openapi';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { DI } from 'di.js';
import { requireUser } from 'middleware/require-user.js';
import { createApiHono, type ApiHono } from 'types.js';

const route = createRoute({
  method: 'get',
  path: '/technicals/health',
  tags: ['technicals'],
  responses: {
    200: {
      description: 'per-interval Technicals compute-job fetch status',
      content: { 'application/json': { schema: TechnicalsHealthResponseSchema } },
    },
    500: {
      description: 'INTERNAL',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

/**
 * Enumerates the global `technicals:fetch-status:*` keys via SCAN.
 * Avoids KEYS (blocking, banned on shared Redis) and bounds each
 * iteration at 100 so a future deployment with many intervals still
 * pages cleanly.
 */
/**
 * Fast-to-slow ordering of known TT candle intervals so the health
 * dashboard reads top-down by tick frequency. Anything outside the
 * known set ranks past the last known interval, then sorts
 * lexicographically (see the caller's secondary comparator).
 */
const INTERVAL_RANK: Readonly<Record<string, number>> = {
  '1m': 0,
  '5m': 1,
  '15m': 2,
  '30m': 3,
  '1h': 4,
  '4h': 5,
  '1d': 6,
};
const intervalRank = (raw: string): number => INTERVAL_RANK[raw] ?? Number.MAX_SAFE_INTEGER;

const scanFetchStatusKeys = async (redis: Redis): Promise<string[]> => {
  const out: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(
      cursor,
      'MATCH',
      'technicals:fetch-status:*',
      'COUNT',
      100,
    );
    out.push(...batch);
    cursor = next;
  } while (cursor !== '0');
  return out;
};

export const technicalsHealthRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/technicals/*', requireUser());

  app.openapi(route, async (c) => {
    const logger: Logger = di.logger;
    // `ScopedRedis` does not surface scan/mget through its typed catalogue
    // because those are aggregation primitives the scoped wrappers do not
    // model. `.raw()` is the documented escape hatch for surface-spanning
    // reads like this fetch-status enumeration.
    const raw = di.redis.raw();
    // SCAN errors propagate as a 500 via the global error handler so the
    // SPA can distinguish a real health-check failure from "no cron
    // commit recently" (empty intervals[]). Swallowing here would render
    // both states identically as "technicals silent" and hide a real fault.
    const keys = await scanFetchStatusKeys(raw);
    if (keys.length === 0) return c.json({ intervals: [] }, 200);

    // One MGET round-trip beats N round-trips. A null/empty value from
    // MGET is skipped, the matching key may have expired between SCAN
    // and MGET on a deeply-loaded Redis.
    const values = await raw.mget(...keys);
    const out: z.infer<typeof TechnicalsFetchStatusSchema>[] = [];
    for (const value of values) {
      if (!value) continue;
      try {
        const parsed = TechnicalsFetchStatusSchema.parse(JSON.parse(value));
        out.push(parsed);
      } catch (err) {
        logger.warn({ err: err }, 'technicals health: malformed fetch-status entry');
      }
    }
    // Interval-aware sort so the UI lists fast-to-slow rather than
    // lexicographic (which would render `15m, 1d, 1h, 1m, 30m, 4h, 5m`).
    // Unknown labels sort last lexicographically so a future strategy
    // adding an interval still renders deterministically.
    out.sort(
      (a, b) =>
        intervalRank(a.interval) - intervalRank(b.interval) || a.interval.localeCompare(b.interval),
    );
    return c.json({ intervals: out }, 200);
  });

  return app;
};
