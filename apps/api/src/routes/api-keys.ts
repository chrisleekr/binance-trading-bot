import {
  ApiKeyPut,
  ApiKeyResponse,
  type ApiKeyVerificationStatus,
  ErrorEnvelope,
} from '@app/contracts';
import { createRoute } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { HttpError } from 'middleware/error.js';
import { requireUser } from 'middleware/require-user.js';
import { requireNotDemo } from 'middleware/require-not-demo.js';
import { accountScopeOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

// The API key pair belongs to the account (one key pair = one Binance account =
// one environment), so key management is account-scoped: every profile under the
// account shares it. Mounted under `/accounts/:accountId`, so paths are relative
// to the account.

const getRoute = createRoute({
  method: 'get',
  path: '/api-key',
  tags: ['api-keys'],
  responses: {
    200: {
      description: 'redacted api key',
      content: { 'application/json': { schema: ApiKeyResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const putRoute = createRoute({
  method: 'put',
  path: '/api-key',
  tags: ['api-keys'],
  request: { body: { content: { 'application/json': { schema: ApiKeyPut } } } },
  responses: {
    200: { description: 'stored', content: { 'application/json': { schema: ApiKeyResponse } } },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/api-key',
  tags: ['api-keys'],
  responses: {
    204: { description: 'deleted' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

export const apiKeysRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/api-key', requireUser());
  app.use('/api-key', requireNotDemo(di));

  app.openapi(getRoute, async (c) => {
    const a = await accountScopeOf(c, di);
    const row = await a.apiKeys.findForAccount();
    if (!row) throw new HttpError('NOT_FOUND', 'api-key');
    return c.json(
      {
        label: row.label,
        last4: row.last4,
        createdAt: row.createdAt.toISOString(),
        verificationStatus: row.verificationStatus as ApiKeyVerificationStatus,
        verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
        verificationError: row.verificationError,
      },
      200,
    );
  });

  app.openapi(putRoute, async (c) => {
    const a = await accountScopeOf(c, di);
    const { accountId } = a.scope;
    const { operatorId } = a.scope;
    const body = c.req.valid('json');
    const existing = await a.apiKeys.findForAccount();
    const last4 = body.secret.slice(-4);
    const row = await a.apiKeys.upsert({
      key: body.key,
      secret: body.secret,
      last4,
      label: body.label ?? null,
    });
    // Unique jobId per save: a static id collides with the prior run still sitting
    // in BullMQ's retained completed set, so a second key rotation would dedup to a
    // no-op and the row would stay 'pending' forever. The timestamp suffix matches
    // the other re-verify enqueues.
    await di.queue.add(
      'verify-key',
      { userId: operatorId, accountId },
      { jobId: `verify-key:${accountId}:${Date.now()}` },
    );
    // No cache eviction needed: the worker resolves Binance credentials per tick
    // (memoised only within a tick, not across), so a running profile picks up
    // the rotated key on its very next tick. The context cache holds only the
    // account's (unchanged) binanceMode + symbol/technicals, not credentials.
    c.set('auditEvent', {
      event: existing ? 'replace-api-key' : 'add-api-key',
      payload: { accountId },
    });
    return c.json(
      {
        label: row.label,
        last4: row.last4,
        createdAt: row.createdAt.toISOString(),
        // Just saved: the upsert reset verification to 'pending'; the enqueued
        // verify-key job fills in the outcome shortly.
        verificationStatus: row.verificationStatus as ApiKeyVerificationStatus,
        verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
        verificationError: row.verificationError,
      },
      200,
    );
  });

  app.openapi(deleteRoute, async (c) => {
    const a = await accountScopeOf(c, di);
    const { accountId } = a.scope;
    const ok = await a.apiKeys.removeForAccount();
    if (!ok) throw new HttpError('NOT_FOUND', 'api-key');
    // No enqueue needed: credentials are resolved per tick, so the next tick
    // finds no key and the profile stops executing on its own (it cannot resolve
    // a Binance client), the correct outcome for a removed key.
    c.set('auditEvent', { event: 'delete-api-key', payload: { accountId } });
    return new Response(null, { status: 204 });
  });

  return app;
};
