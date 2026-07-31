import { swaggerUI } from '@hono/swagger-ui';
import type { ApiHono } from 'types.js';

export const OPENAPI_DOC = {
  openapi: '3.1.0' as const,
  info: {
    title: 'binance-trading-bot API',
    version: '1.0.0',
    description:
      'HTTP + WebSocket API for the binance-trading-bot platform. The WebSocket route /api/profiles/{profileId}/ws is intentionally excluded from this spec; its envelope and per-topic payload schemas live in @app/contracts/src/ws-events.ts.',
  },
};

export const mountDocs = (app: ApiHono): void => {
  app.doc('/openapi.json', OPENAPI_DOC);
  app.get('/docs', swaggerUI({ url: '/openapi.json' }));
};
