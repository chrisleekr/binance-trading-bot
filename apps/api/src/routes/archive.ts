import {
  ArchivePeriod,
  asDecimalString,
  asProfileId,
  coerceArchivedOrders,
  decimalSub,
  deriveExitIntent,
  ErrorEnvelope,
  ProfileArchiveListResponse,
  rollupByExitIntent,
  rollupBySource,
  TradeArchiveBackfillRequest,
  TradeArchiveBackfillResponse,
  UnreconstructableDismissRequest,
  UnreconstructableDismissResponse,
  type UnreconstructableReason,
} from '@app/contracts';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { periodWindow } from 'lib/period-window.js';
import { requireUser } from 'middleware/require-user.js';
import { scopeOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

/**
 * Map a backfill attempt's drop counts to the operator-facing reason. Overshoot
 * (sold more than bought) is the most specific data problem, then orphan sells;
 * a zero-zero attempt is a bought-not-fully-sold or pre-history open position.
 */
function unreconstructableReason(u: {
  skippedOrphanSells: number;
  droppedOvershoot: number;
}): UnreconstructableReason {
  if (u.droppedOvershoot > 0) return 'overshoot';
  if (u.skippedOrphanSells > 0) return 'orphan-sells';
  return 'open-or-pre-history';
}

const ProfileIdParam = z.object({ profileId: z.uuid() });

const ArchiveQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(25),
  cursor: z.iso.datetime().optional(),
  period: ArchivePeriod.default('a'),
  // tz is operator-controlled; default to UTC because the worker doesn't
  // know the operator's timezone — the SPA passes its own. Validate as a
  // real IANA zone so an invalid value 4xx's at the boundary instead of
  // throwing later when periodWindow builds an Intl.DateTimeFormat.
  tz: z
    .string()
    .min(1)
    .max(64)
    .refine(
      (value) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      },
      { message: 'tz must be a valid IANA timezone' },
    )
    .default('UTC'),
});

const route = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/trade-archive',
  tags: ['archive'],
  request: { params: ProfileIdParam, query: ArchiveQuery },
  responses: {
    200: {
      description: 'paginated archive entries',
      content: { 'application/json': { schema: ProfileArchiveListResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const SymbolParam = z.object({ profileId: z.uuid(), symbol: z.string().min(1) });

const backfillRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/symbols/{symbol}/trade-archive-backfill',
  tags: ['archive'],
  request: {
    params: SymbolParam,
    body: { content: { 'application/json': { schema: TradeArchiveBackfillRequest } } },
  },
  responses: {
    202: {
      description: 'backfill scheduled',
      content: { 'application/json': { schema: TradeArchiveBackfillResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const dismissRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/symbols/{symbol}/unreconstructable-dismiss',
  tags: ['archive'],
  request: {
    params: SymbolParam,
    body: { content: { 'application/json': { schema: UnreconstructableDismissRequest } } },
  },
  responses: {
    200: {
      description: 'visibility updated',
      content: { 'application/json': { schema: UnreconstructableDismissResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

/**
 * `GET /profiles/:id/trade-archive` — paginated profile-level archive.
 *
 * Cursor pagination because new archive rows can land while the operator
 * pages through; an offset would re-show or skip entries. The period
 * window uses the same locale-aware helper as the closed-trades widget so
 * day/week/month boundaries match between the two views.
 *
 * `POST /profiles/:id/symbols/:symbol/trade-archive-backfill` enqueues a
 * worker job that reconstructs historic round-trips from Binance `myTrades`.
 * The reconstruction needs Binance trade history (and pins fees) the request
 * context lacks, so it runs on the worker; the route only acknowledges.
 */
export const archiveRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/profiles/*/trade-archive', requireUser());
  app.use('/profiles/*/symbols/*/trade-archive-backfill', requireUser());
  app.use('/profiles/*/symbols/*/unreconstructable-dismiss', requireUser());

  app.openapi(route, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const { limit, cursor, period, tz } = c.req.valid('query');
    const p = await scopeOf(c, di, profileId);

    const { from } = periodWindow(period, tz, new Date());
    // Cursor wire format is `<archivedAt-iso>__<id>`. Older single-iso
    // cursors keep working: missing `id` lets a same-timestamp group
    // surface in full on the next page (no rows are dropped).
    let cursorObj: { archivedAt: Date; id: string } | null = null;
    if (cursor !== undefined) {
      const sep = cursor.indexOf('__');
      if (sep > 0) {
        cursorObj = {
          archivedAt: new Date(cursor.slice(0, sep)),
          id: cursor.slice(sep + 2),
        };
      } else {
        cursorObj = {
          archivedAt: new Date(cursor),
          id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
        };
      }
    }
    // 'a' (all time) returns from=0; the strict `gte 0` predicate keeps the
    // SQL stable across periods so the planner's index pick doesn't shift.
    const fromDate = period === 'a' ? null : from;

    // The four reads are independent and share the one ProfileScope already
    // proven above, so they run concurrently. node-postgres checks out a
    // separate pooled connection per query, so this is real parallelism, not
    // pipelining over one socket. The by-intent rollup is period-scoped (every
    // trade in the window, not just this page), so it reads the full period
    // separately from the paged list. The archive is small enough per profile
    // to read unpaginated.
    const [rows, recoverableSymbols, rawUnreconstructable, periodRows] = await Promise.all([
      p.tradeArchive.listForProfilePaginated(limit, fromDate, cursorObj),
      p.tradeArchive.listRecoverableSymbols(),
      p.tradeArchive.listUnreconstructableSymbols(),
      p.tradeArchive.listForProfileInRange(fromDate),
    ]);
    const unreconstructableSymbols = rawUnreconstructable.map((u) => ({
      symbol: u.symbol,
      reason: unreconstructableReason(u),
      dismissed: u.dismissed,
    }));
    // One projection feeds both rollups: by exit intent (why each trade closed)
    // and by source (auto = discovery vs manual = pinned).
    const rollupItems = periodRows.map((r) => ({
      quoteAsset: r.quoteAsset,
      source: r.source,
      profit: asDecimalString(r.profit),
      feesQuote: asDecimalString(r.feesQuote),
      orders: coerceArchivedOrders(r.orders),
    }));
    const byIntent = rollupByExitIntent(rollupItems);
    const bySource = rollupBySource(rollupItems);
    const last = rows.at(-1);
    const nextCursor =
      rows.length === limit && last !== undefined
        ? `${last.archivedAt.toISOString()}__${last.id}`
        : null;
    return c.json(
      {
        items: rows.map((r) => ({
          id: r.id,
          symbol: r.symbol,
          baseAsset: r.baseAsset,
          quoteAsset: r.quoteAsset,
          totalBuyQuote: asDecimalString(r.totalBuyQuote),
          totalSellQuote: asDecimalString(r.totalSellQuote),
          breakdown: Object.fromEntries(
            Object.entries((r.breakdown ?? {}) as Record<string, string>).map(([k, v]) => [
              k,
              asDecimalString(v),
            ]),
          ),
          fees: Object.fromEntries(
            Object.entries((r.fees ?? {}) as Record<string, string>).map(([k, v]) => [
              k,
              asDecimalString(v),
            ]),
          ),
          feesQuote: asDecimalString(r.feesQuote),
          netProfit: decimalSub(asDecimalString(r.profit), asDecimalString(r.feesQuote)),
          profit: asDecimalString(r.profit),
          profitPercent: asDecimalString(r.profitPercent),
          exitIntent: deriveExitIntent(coerceArchivedOrders(r.orders)),
          archivedAt: r.archivedAt.toISOString(),
        })),
        nextCursor,
        recoverableSymbols,
        unreconstructableSymbols,
        byIntent,
        bySource,
      },
      200,
    );
  });

  app.openapi(backfillRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    // Binance symbols are upper-case and case-sensitive; the Redis symbol-info
    // key and myTrades query are built from the literal string. Normalise here
    // so a direct API caller (the web client already upper-cases) can't enqueue
    // a job that silently finds no trades or throws on a cold cache forever.
    const symbol = c.req.valid('param').symbol.toUpperCase();
    const { from, to } = c.req.valid('json');
    const p = await scopeOf(c, di, profileId);
    const { operatorId, accountId } = p.scope;
    const scheduledAt = new Date();
    await di.queue.add(
      'backfill-trade-archive',
      {
        userId: operatorId,
        accountId,
        profileId,
        symbol,
        fromMs: from !== undefined ? new Date(from).getTime() : null,
        toMs: to !== undefined ? new Date(to).getTime() : null,
      },
      { jobId: `backfill-archive:${profileId}:${symbol}:${scheduledAt.getTime()}` },
    );
    c.set('auditEvent', {
      event: 'backfill-trade-archive',
      payload: { profileId, symbol, from: from ?? null, to: to ?? null },
    });
    return c.json({ scheduledAt: scheduledAt.toISOString() }, 202);
  });

  app.openapi(dismissRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const symbol = c.req.valid('param').symbol.toUpperCase();
    const { dismissed } = c.req.valid('json');
    const p = await scopeOf(c, di, profileId);
    await p.tradeArchive.setUnreconstructableDismissed(symbol, dismissed);
    c.set('auditEvent', {
      event: 'unreconstructable-dismiss',
      payload: { profileId, symbol, dismissed },
    });
    return c.json({ dismissed }, 200);
  });

  return app;
};
