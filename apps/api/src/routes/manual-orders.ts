import {
  asProfileId,
  CancelOrderRequest,
  DiscoveryConfigSchema,
  ErrorEnvelope,
  AvgEntryPricePut,
  ForceEjectRequest,
  ManualOrderAllRequest,
  ManualOrderAllResponse,
  ManualOrderRequest,
  ManualOrderResponse,
  type ManualOverridePayload,
  TriggerResponse,
} from '@app/contracts';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import {
  assertActionSupported,
  assertEntryNotHalted,
  balanceQuantityForSymbol,
  enqueueApplyAvgEntryPrice,
  runOverrideOrRollbackDb,
  writeOverrideAndEnqueue,
} from 'lib/manual-orders.js';
import { requireUser } from 'middleware/require-user.js';
import { scopeOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

const ProfileIdParam = z.object({ profileId: z.uuid() });
const ProfileSymbolParam = z.object({
  profileId: z.uuid(),
  symbol: z.string().min(1).max(32),
});

const manualOrderRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/symbols/{symbol}/manual-order',
  tags: ['manual-orders'],
  request: {
    params: ProfileSymbolParam,
    body: { content: { 'application/json': { schema: ManualOrderRequest } } },
  },
  responses: {
    202: {
      description: 'scheduled',
      content: { 'application/json': { schema: ManualOrderResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
    409: { description: 'CONFLICT', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const cancelOrderRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/symbols/{symbol}/cancel-order',
  tags: ['manual-orders'],
  request: {
    params: ProfileSymbolParam,
    body: { content: { 'application/json': { schema: CancelOrderRequest } } },
  },
  responses: {
    202: { description: 'cancel scheduled' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const manualOrderAllRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/manual-order-all',
  tags: ['manual-orders'],
  request: {
    params: ProfileIdParam,
    body: { content: { 'application/json': { schema: ManualOrderAllRequest } } },
  },
  responses: {
    202: {
      description: 'fan-out scheduled',
      content: { 'application/json': { schema: ManualOrderAllResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
    409: { description: 'CONFLICT', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const triggerBuyRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/symbols/{symbol}/trigger-buy',
  tags: ['manual-orders'],
  request: { params: ProfileSymbolParam },
  responses: {
    202: {
      description: 'trigger scheduled',
      content: { 'application/json': { schema: TriggerResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
    409: { description: 'CONFLICT', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const triggerSellRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/symbols/{symbol}/trigger-sell',
  tags: ['manual-orders'],
  request: { params: ProfileSymbolParam },
  responses: {
    202: {
      description: 'trigger scheduled',
      content: { 'application/json': { schema: TriggerResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const forceEjectRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/symbols/{symbol}/force-eject',
  tags: ['manual-orders'],
  request: {
    params: ProfileSymbolParam,
    body: { content: { 'application/json': { schema: ForceEjectRequest } } },
  },
  responses: {
    202: {
      description: 'eject scheduled',
      content: { 'application/json': { schema: TriggerResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const lbpPutRoute = createRoute({
  method: 'put',
  path: '/profiles/{profileId}/symbols/{symbol}/avg-entry-price',
  tags: ['manual-orders'],
  request: {
    params: ProfileSymbolParam,
    body: { content: { 'application/json': { schema: AvgEntryPricePut } } },
  },
  responses: {
    204: { description: 'updated' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const lbpDeleteRoute = createRoute({
  method: 'delete',
  path: '/profiles/{profileId}/symbols/{symbol}/avg-entry-price',
  tags: ['manual-orders'],
  request: { params: ProfileSymbolParam },
  responses: {
    204: { description: 'deleted' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const archiveGridRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/symbols/{symbol}/archive-grid-trade',
  tags: ['manual-orders'],
  request: { params: ProfileSymbolParam },
  responses: {
    202: { description: 'archive scheduled' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const resetGridRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/symbols/{symbol}/reset-grid-trade',
  tags: ['manual-orders'],
  request: { params: ProfileSymbolParam },
  responses: {
    204: { description: 'reset' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const resetConfigRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/symbols/{symbol}/reset-config',
  tags: ['manual-orders'],
  request: { params: ProfileSymbolParam },
  responses: {
    204: { description: 'reset' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

/**
 * The 202 receipt every arm route hands back. Shared so the four of them cannot
 * drift: `createdAt` is the row's own server stamp and a client watching for the
 * outcome needs it from all of them, not from whichever one was edited last.
 */
const armReceipt = (action: {
  readonly id: string;
  readonly actionAt: Date;
  readonly createdAt: Date;
}): ManualOrderResponse => ({
  scheduledAt: action.actionAt.toISOString(),
  overrideActionId: action.id,
  createdAt: action.createdAt.toISOString(),
});

export const manualOrdersRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/profiles/*', requireUser());

  app.openapi(manualOrderRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const p = await scopeOf(c, di, asProfileId(profileIdRaw));
    await assertActionSupported(di, p, 'manual-order');
    const scope = p.scope;
    const body = c.req.valid('json');
    // Buys only: the breaker pauses new risk, it never blocks an exit.
    if (body.side === 'BUY') await assertEntryNotHalted(di, p);
    const action = await p.overrideActions.record({
      symbol,
      action: 'manual-order',
      actionAt: new Date(),
      payload: body,
      triggeredBy: 'user',
    });
    const overridePayload: ManualOverridePayload = {
      kind: 'manual-order',
      overrideActionId: action.id,
      payload: body,
    };
    await runOverrideOrRollbackDb(di, p, action.id, () =>
      writeOverrideAndEnqueue(di, p, symbol, overridePayload),
    );
    c.set('auditEvent', {
      event: 'manual-order',
      // Ship the body alongside profile/symbol so the audit page can
      // reconstruct what the operator scheduled without re-joining
      // override_actions; the previous shape ({profileId, symbol}) left
      // the row useless ("Symbol: BTCUSDT" with no side/qty/price/type).
      payload: {
        profileId: scope.profileId,
        symbol,
        side: body.side,
        type: body.type,
        ...(body.quantity !== undefined && { quantity: body.quantity }),
        ...(body.quoteAmount !== undefined && { quoteAmount: body.quoteAmount }),
        ...(body.price !== undefined && { price: body.price }),
      },
    });
    return c.json(armReceipt(action), 202);
  });

  app.openapi(cancelOrderRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const p = await scopeOf(c, di, asProfileId(profileIdRaw));
    const scope = p.scope;
    const body = c.req.valid('json');
    await di.queue.add(
      'cancel-order',
      {
        userId: scope.operatorId,
        accountId: scope.accountId,
        profileId: scope.profileId,
        symbol,
        orderId: body.orderId,
      },
      { jobId: `cancel:${body.orderId}` },
    );
    c.set('auditEvent', {
      event: 'cancel-order',
      payload: { profileId: scope.profileId, symbol, orderId: body.orderId },
    });
    return new Response(null, { status: 202 });
  });

  app.openapi(manualOrderAllRoute, async (c) => {
    const p = await scopeOf(c, di, asProfileId(c.req.valid('param').profileId));
    await assertActionSupported(di, p, 'manual-order');
    const scope = p.scope;
    const body = c.req.valid('json');
    if (body.side === 'buy') await assertEntryNotHalted(di, p);
    const allSymbols = await p.profileSymbols.listForProfile();
    const matching = allSymbols.filter((s) => s.symbol.endsWith(body.quote));
    if (matching.length === 0) {
      return c.json(
        {
          scheduled: 0,
          firstFireAt: new Date(0).toISOString(),
          lastFireAt: new Date(0).toISOString(),
        },
        202,
      );
    }
    // Map the bulk request to the per-symbol manual-order shape once. The
    // worker reads a `ManualOverridePayload.manual-order` whose `payload` is
    // a `ManualOrderRequest`; the bulk request renames `marketQuantity` ->
    // `quantity` and lowercases `side`. Bulk is MARKET-only (a single limit
    // price can't apply across symbols), and the contract refine guarantees
    // exactly one amount, so this always satisfies ManualOrderRequest.
    const perSymbolPayload: ManualOrderRequest = {
      side: body.side === 'buy' ? 'BUY' : 'SELL',
      type: 'MARKET',
      ...(body.marketQuantity !== undefined && { quantity: body.marketQuantity }),
      ...(body.quoteAmount !== undefined && { quoteAmount: body.quoteAmount }),
    };
    // Fan the bulk request out the same way a single manual order fires:
    // record an audit row, then writeOverrideAndEnqueue so a tick actually
    // places the order. The previous handler only recorded override_actions
    // rows that no order-placement path ever read, so the operator's
    // "sell everything" returned 202 while placing zero orders.
    //
    // One symbol's fan-out failure must not abort the rest: this is a panic
    // "sell everything" flow, so a Redis/queue blip on symbol k should not
    // strand symbols k+1..N. Catch per symbol, log loudly, and report the
    // count actually enqueued so the operator can see a partial outcome.
    const firstFireAt = new Date();
    let scheduled = 0;
    for (const sym of matching) {
      const action = await p.overrideActions.record({
        symbol: sym.symbol,
        action: 'manual-order',
        actionAt: firstFireAt,
        payload: body,
        triggeredBy: 'user',
      });
      const overridePayload: ManualOverridePayload = {
        kind: 'manual-order',
        overrideActionId: action.id,
        payload: perSymbolPayload,
      };
      try {
        await runOverrideOrRollbackDb(di, p, action.id, () =>
          writeOverrideAndEnqueue(di, p, sym.symbol, overridePayload),
        );
        scheduled += 1;
      } catch (err) {
        di.logger.error(
          { profileId: scope.profileId, symbol: sym.symbol, err: err },
          'manual-order-all: fan-out failed for one symbol; continuing with the rest',
        );
      }
    }
    c.set('auditEvent', {
      event: 'bulk-manual-order',
      payload: { profileId: scope.profileId, count: scheduled },
    });
    return c.json(
      {
        scheduled,
        firstFireAt: firstFireAt.toISOString(),
        lastFireAt: firstFireAt.toISOString(),
      },
      202,
    );
  });

  app.openapi(triggerBuyRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const p = await scopeOf(c, di, asProfileId(profileIdRaw));
    await assertActionSupported(di, p, 'trigger-buy');
    await assertEntryNotHalted(di, p);
    const scope = p.scope;
    const action = await p.overrideActions.record({
      symbol,
      action: 'buy',
      actionAt: new Date(),
      // checkTechnicals:false is load-bearing; fires regardless of TV recommendation.
      payload: { triggeredBy: 'user', notify: true, checkTechnicals: false },
      triggeredBy: 'user',
    });
    const overridePayload: ManualOverridePayload = {
      kind: 'trigger-buy',
      overrideActionId: action.id,
    };
    await runOverrideOrRollbackDb(di, p, action.id, () =>
      writeOverrideAndEnqueue(di, p, symbol, overridePayload),
    );
    c.set('auditEvent', { event: 'trigger-buy', payload: { profileId: scope.profileId, symbol } });
    return c.json(armReceipt(action), 202);
  });

  app.openapi(triggerSellRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const p = await scopeOf(c, di, asProfileId(profileIdRaw));
    await assertActionSupported(di, p, 'trigger-sell');
    const scope = p.scope;
    const action = await p.overrideActions.record({
      symbol,
      action: 'sell',
      actionAt: new Date(),
      payload: { triggeredBy: 'user', notify: true },
      triggeredBy: 'user',
    });
    const overridePayload: ManualOverridePayload = {
      kind: 'trigger-sell',
      overrideActionId: action.id,
    };
    await runOverrideOrRollbackDb(di, p, action.id, () =>
      writeOverrideAndEnqueue(di, p, symbol, overridePayload),
    );
    c.set('auditEvent', { event: 'trigger-sell', payload: { profileId: scope.profileId, symbol } });
    return c.json(armReceipt(action), 202);
  });

  // Force-eject: an operator's deliberate "get me out of this auto coin now".
  // Distinct from the automated defade-reap: it (1) flattens
  // the position via the same SELL override as trigger-sell, (2) stamps the
  // re-add cooldown immediately so discovery does not rotate it straight back
  // in before the sell settles, and (3) optionally blocklists it permanently.
  app.openapi(forceEjectRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const p = await scopeOf(c, di, asProfileId(profileIdRaw));
    await assertActionSupported(di, p, 'trigger-sell');
    const scope = p.scope;
    const { blocklist } = c.req.valid('json');
    const action = await p.overrideActions.record({
      symbol,
      action: 'sell',
      actionAt: new Date(),
      payload: { triggeredBy: 'user', notify: true },
      triggeredBy: 'user',
    });
    const overridePayload: ManualOverridePayload = {
      kind: 'trigger-sell',
      overrideActionId: action.id,
    };
    await runOverrideOrRollbackDb(di, p, action.id, () =>
      writeOverrideAndEnqueue(di, p, symbol, overridePayload),
    );
    await p.profileSymbols.recordFlatten(symbol, action.actionAt);
    if (blocklist) {
      const profile = await p.profile.findById();
      if (profile) {
        const cfg = DiscoveryConfigSchema.parse(
          (profile as { discoveryConfig?: unknown }).discoveryConfig ?? {},
        );
        if (!cfg.blacklist.includes(symbol)) {
          await p.profile.setDiscoveryConfig({ ...cfg, blacklist: [...cfg.blacklist, symbol] });
        }
      }
    }
    c.set('auditEvent', {
      event: 'force-eject',
      payload: { profileId: scope.profileId, symbol, blocklist },
    });
    return c.json(armReceipt(action), 202);
  });

  app.openapi(lbpPutRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const p = await scopeOf(c, di, asProfileId(profileIdRaw));
    await assertActionSupported(di, p, 'avg-entry-price');
    const scope = p.scope;
    const body = c.req.valid('json');
    const quantity = await balanceQuantityForSymbol(di, p, symbol);
    await p.avgEntryPrices.upsert(symbol, {
      avgEntryPrice: body.avgEntryPrice,
      quantity,
    });
    // Force-set the strategy's running cost basis: a plain tick never
    // converges the ledger into state, so route through the dedicated job.
    await enqueueApplyAvgEntryPrice(di, p, symbol);
    c.set('auditEvent', {
      event: 'set-avg-entry-price',
      payload: { profileId: scope.profileId, symbol },
    });
    return new Response(null, { status: 204 });
  });

  app.openapi(lbpDeleteRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const p = await scopeOf(c, di, asProfileId(profileIdRaw));
    await assertActionSupported(di, p, 'avg-entry-price');
    const scope = p.scope;
    await p.avgEntryPrices.remove(symbol);
    // Clear the strategy's running cost basis. Same job as the set path;
    // with the ledger row now gone the worker reads "absent" and clears state.
    await enqueueApplyAvgEntryPrice(di, p, symbol);
    c.set('auditEvent', {
      event: 'delete-avg-entry-price',
      payload: { profileId: scope.profileId, symbol },
    });
    return new Response(null, { status: 204 });
  });

  // Archive flow is delegated to a worker job because realised P/L computation
  // depends on Binance state (current price, fees) that is not present in the
  // request context. The worker's audit shipper and LiveExecutor own the
  // insert + grid-row delete + Slack notify.
  app.openapi(archiveGridRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const p = await scopeOf(c, di, asProfileId(profileIdRaw));
    await assertActionSupported(di, p, 'archive-grid');
    const scope = p.scope;
    await di.queue.add(
      'archive-grid-trade',
      { userId: scope.operatorId, accountId: scope.accountId, profileId: scope.profileId, symbol },
      { jobId: `archive-grid:${scope.profileId}:${symbol}:${Date.now()}` },
    );
    c.set('auditEvent', {
      event: 'archive-grid-trade',
      payload: { profileId: scope.profileId, symbol },
    });
    return new Response(null, { status: 202 });
  });

  app.openapi(resetGridRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const p = await scopeOf(c, di, asProfileId(profileIdRaw));
    await assertActionSupported(di, p, 'reset-grid');
    const scope = p.scope;
    await di.queue.add(
      'reset-grid-trade',
      { userId: scope.operatorId, accountId: scope.accountId, profileId: scope.profileId, symbol },
      { jobId: `reset-grid:${scope.profileId}:${symbol}:${Date.now()}` },
    );
    c.set('auditEvent', {
      event: 'reset-grid-trade',
      payload: { profileId: scope.profileId, symbol },
    });
    return new Response(null, { status: 204 });
  });

  app.openapi(resetConfigRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const p = await scopeOf(c, di, asProfileId(profileIdRaw));
    const scope = p.scope;
    // Reset clears the per-symbol override on an already-bound symbol. Reuse the
    // bound row's base asset; a not-yet-bound symbol has no override to reset.
    const existing = await p.profileSymbols.findForSymbol(symbol);
    if (existing) {
      await p.profileSymbols.upsert(symbol, existing.baseAsset, { overrideConfig: null });
    }
    c.set('auditEvent', { event: 'reset-config', payload: { profileId: scope.profileId, symbol } });
    return new Response(null, { status: 204 });
  });

  return app;
};
