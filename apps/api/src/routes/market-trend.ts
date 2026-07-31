// GET /market-trend.
//
// Serves the worker's market-trend snapshot (BTC/ETH daily regime + USDT
// universe breadth) to the dashboard. The `market-trend` cron writes one
// global Redis key; this route reads it. A missing key — cold start before
// the first successful cycle, or a malformed snapshot caught by the parse
// guard below — returns `trend: null` so the SPA renders a warming state
// rather than a fetch error. The key has no TTL, so once written it persists.
// Global market data, but still behind
// `requireUser` — the whole app is single-operator and authenticated.

import { ErrorEnvelope, MarketTrendSchema, MarketTrendResponseSchema } from '@app/contracts';
import { createRoute } from '@hono/zod-openapi';
import type { Logger } from 'pino';

import type { DI } from 'di.js';
import { requireUser } from 'middleware/require-user.js';
import { createApiHono, type ApiHono } from 'types.js';

const route = createRoute({
  method: 'get',
  path: '/market-trend',
  tags: ['market-trend'],
  responses: {
    200: {
      description: 'BTC/ETH daily regime + universe breadth, or null while warming',
      content: { 'application/json': { schema: MarketTrendResponseSchema } },
    },
    500: {
      description: 'INTERNAL',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

export const marketTrendRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/market-trend', requireUser());

  app.openapi(route, async (c) => {
    const logger: Logger = di.logger;
    const raw = await di.redis.forGlobal().get('marketTrend');
    if (raw === null) return c.json({ trend: null }, 200);
    try {
      // Parse before returning so a malformed/older-shape snapshot degrades to
      // warming instead of failing the SPA's response schema validation.
      const trend = MarketTrendSchema.parse(JSON.parse(raw));
      return c.json({ trend }, 200);
    } catch (err) {
      logger.warn({ err: err }, 'market-trend: malformed snapshot; serving null');
      return c.json({ trend: null }, 200);
    }
  });

  return app;
};
