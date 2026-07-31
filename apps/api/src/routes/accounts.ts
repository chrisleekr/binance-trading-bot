import {
  AccountCreate,
  AccountList,
  AccountPatch,
  AccountResponse,
  asAccountId,
  asProfileId,
  ErrorEnvelope,
} from '@app/contracts';
import { projections, repo, type schema } from '@app/db';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { HttpError } from 'middleware/error.js';
import { requireUser } from 'middleware/require-user.js';
import { requireNotDemo } from 'middleware/require-not-demo.js';
import { teardownProfileRuntime } from 'profile-teardown.js';
import { accountScopeOf, userIdOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

const AccountIdParam = z.object({ accountId: z.uuid() });

const toResponse = (
  row: schema.AccountRow,
  apiKeyConfigured: boolean,
): z.infer<typeof AccountResponse> => ({
  id: row.id,
  name: row.name,
  binanceMode: row.binanceMode as 'test' | 'live',
  apiKeyConfigured,
  createdAt: row.createdAt.toISOString(),
});

const listRoute = createRoute({
  method: 'get',
  path: '/accounts',
  tags: ['accounts'],
  responses: {
    200: { description: 'accounts', content: { 'application/json': { schema: AccountList } } },
  },
});

const createRouteDef = createRoute({
  method: 'post',
  path: '/accounts',
  tags: ['accounts'],
  request: { body: { content: { 'application/json': { schema: AccountCreate } } } },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: AccountResponse } } },
    409: {
      description: 'CONFLICT — name taken',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/accounts/{accountId}',
  tags: ['accounts'],
  request: { params: AccountIdParam },
  responses: {
    200: { description: 'account', content: { 'application/json': { schema: AccountResponse } } },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}',
  tags: ['accounts'],
  request: {
    params: AccountIdParam,
    body: { content: { 'application/json': { schema: AccountPatch } } },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: AccountResponse } } },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}',
  tags: ['accounts'],
  request: {
    params: AccountIdParam,
  },
  responses: {
    204: { description: 'deleted' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
    409: {
      description: 'CONFLICT — open orders/positions across the account’s profiles',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

export const accountsRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/accounts', requireUser());
  app.use('/accounts/*', requireUser());
  // Creating an account could add a live-mode key pair to a demo box — off in
  // demo. Only the create verb is locked; reads stay open (the sandbox).
  app.on('POST', '/accounts', requireNotDemo(di));

  app.openapi(listRoute, async (c) => {
    const operatorId = userIdOf(c);
    const [rows, configured] = await Promise.all([
      repo.accounts.listForOwner(di.db, operatorId),
      repo.apiKeys.accountIdsWithKeyForOwner(di.db, operatorId),
    ]);
    const withKey = new Set(configured);
    return c.json(
      rows.map((r) => toResponse(r, withKey.has(asAccountId(r.id)))),
      200,
    );
  });

  app.openapi(createRouteDef, async (c) => {
    const operatorId = userIdOf(c);
    const body = c.req.valid('json');
    let row: schema.AccountRow;
    try {
      row = await repo.accounts.create(di.db, operatorId, {
        name: body.name,
        binanceMode: body.binanceMode,
      });
    } catch (err) {
      // The only expected failure is the (owner_id, name) unique index — surface
      // it as a clean 409 instead of a 500. Any other error rethrows.
      if (err instanceof Error && /accounts_owner_name_uniq/.test(err.message)) {
        throw new HttpError('CONFLICT', 'An account with that name already exists.');
      }
      throw err;
    }
    c.set('auditEvent', { event: 'add-account', payload: { accountId: row.id } });
    // A freshly created account has no key yet.
    return c.json(toResponse(row, false), 201);
  });

  app.openapi(getRoute, async (c) => {
    const a = await accountScopeOf(c, di);
    const [account, key] = await Promise.all([a.account.get(), a.apiKeys.findForAccount()]);
    if (!account) throw new HttpError('NOT_FOUND', 'account');
    return c.json(toResponse(account, key !== null), 200);
  });

  app.openapi(patchRoute, async (c) => {
    const a = await accountScopeOf(c, di);
    const body = c.req.valid('json');
    const patch: { name?: string } = {};
    if (body.name !== undefined) patch.name = body.name;
    const updated = await a.account.update(patch);
    if (!updated) throw new HttpError('NOT_FOUND', 'account');
    const key = await a.apiKeys.findForAccount();
    c.set('auditEvent', { event: 'update-account', payload: { accountId: updated.id } });
    return c.json(toResponse(updated, key !== null), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const a = await accountScopeOf(c, di);
    const { accountId, operatorId } = a.scope;
    // The cascade drops every child profile's orders and ledger rows, so live
    // exposure would be erased locally while it is still sitting on Binance —
    // exactly the abandonment the profile delete no longer allows. There is no
    // force here either: dispose of each profile first (which cancels or hands off
    // its orders against the exchange), then the account is free to go.
    const { openOrderCount, openPositionCount } = await projections.countAccountOpenExposure(
      a.scope,
    );
    if (openOrderCount > 0 || openPositionCount > 0) {
      throw new HttpError(
        'CONFLICT',
        'This account still holds coins or has live orders on the exchange. Delete each of its profiles first and choose what happens to their orders — then the account can be removed.',
        { openOrderCount, openPositionCount },
      );
    }

    // Enumerate BEFORE the delete: the cascade takes the profile rows with it,
    // and the cleanup below needs their ids.
    const profileIds = (await a.profiles.listForAccount()).map((p) => asProfileId(p.id));

    const ok = await a.account.deleteById();
    if (!ok) throw new HttpError('NOT_FOUND', 'account');

    // Cleanup runs AFTER the delete commits, and never throws: the destructive
    // write already succeeded, so a failed Redis wipe or enqueue must not report
    // a 500 the operator would read as "the account is still there". A missed
    // unsubscribe self-heals — the worker re-reads DB truth and a deleted row
    // maps to teardown.
    const results = await Promise.allSettled(
      profileIds.map((profileId) =>
        teardownProfileRuntime(di, { operatorId, accountId, profileId }),
      ),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        di.logger.warn(
          { accountId, err: r.reason instanceof Error ? r.reason.message : String(r.reason) },
          'delete-account: post-delete cleanup failed (worker reconcile will catch up)',
        );
      }
    }

    c.set('auditEvent', { event: 'delete-account', payload: { accountId } });
    return new Response(null, { status: 204 });
  });

  return app;
};
