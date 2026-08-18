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
import { profileRepo, withStatementTimeout } from '@app/db';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { compositeCursor, splitCompositeCursor } from 'lib/cursor.js';
import { periodWindow } from 'lib/period-window.js';
import { requireUser } from 'middleware/require-user.js';
import { accountIdOf, scopeOf, userIdOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

/**
 * Per-statement execution budget for the archive page's reads.
 *
 * Far below the 30s the background recovery sweep allows itself: an operator is watching this one, and a read still running after five seconds has already lost the page. The cap is per statement and the transaction issues up to five that can stall on a `view=full` request — the ownership join `profileRepo` mints, then the four reads, all serial — so the worst case one request can hold its pooled connection is five times this, 25 seconds. A `view=rollup` request issues two, and that is what every polling surface asks for. That is the number that has to stay small, because the connection is one of ten the whole api shares.
 *
 * 25s does exceed the 5s pool checkout deadline, so under sustained archive concurrency a waiter can be rejected while the holder is still legitimately working. That is accepted rather than papered over by shrinking the budget: the budget bounds a pathological stall, not the healthy case, where each read returns in roughly a tenth of a second. Sizing it down to make the arithmetic tidier would cap real work on evidence we do not have — there is no production timing for `listForProfileInRange` against a large archive.
 *
 * The budget no longer doubles as a size limit on the archive. `listForProfilePaginated` once sorted the profile's whole archive on every page, because no index carried its `(archived_at DESC, id DESC)` order and the keyset boundary was an OR pair the planner could only apply as a per-row filter; page cost therefore scaled with the archive's total size rather than with `limit`, and past the size where that sort took five seconds the page became a 503 on every load. `trade_archive_profile_archived_id` plus a row-comparison boundary made it an index-ordered read of `limit` rows, so the budget now bounds a pathological stall and nothing else. `listForProfileInRange` is still unpaginated by design — it is the rollup's whole-period source — so it remains the read this cap actually exists for.
 */
const ARCHIVE_READ_BUDGET_MS = 5_000;

/**
 * Map a backfill attempt's outcome to the operator-facing reason. A delisted
 * symbol wins outright: the attempt never got as far as reading trades, so its
 * zero counts say nothing, and it is the only reason a retry cannot change.
 * Then overshoot (sold more than bought), the most specific data problem, then
 * orphan sells; a zero-zero attempt is a bought-not-fully-sold or pre-history
 * open position.
 */
function unreconstructableReason(u: {
  skippedOrphanSells: number;
  droppedOvershoot: number;
  symbolUnavailable: boolean;
}): UnreconstructableReason {
  if (u.symbolUnavailable) return 'symbol-unavailable';
  if (u.droppedOvershoot > 0) return 'overshoot';
  if (u.skippedOrphanSells > 0) return 'orphan-sells';
  return 'open-or-pre-history';
}

const ProfileIdParam = z.object({ profileId: z.uuid() });

/** Delimiter of the token this route emits. Two characters, so it cannot occur inside either half. */
const CURSOR_SEPARATOR = '__';

/**
 * The composite cursor this route emits, and the only shape it accepts: `<archivedAt-iso>__<row id>`.
 *
 * Validating it as a plain ISO timestamp once rejected the route's own `nextCursor` as a 422, so paging past the first page was impossible and the archive silently stopped at 25 rows. The correction is to accept the composite form, NOT to also keep accepting a bare timestamp: a bare cursor carries no row id, and one minted before this route emitted microseconds carries only milliseconds. Either way it cannot address a row inside a shared timestamp, so it would strand the rows below the boundary exactly as the millisecond cursor did — silently, which is the failure mode worth refusing outright. A cursor the route did not emit is a 422 the client recovers from by restarting the walk.
 */
const ArchiveCursor = compositeCursor({ separator: CURSOR_SEPARATOR, allowBareTimestamp: false });

const ArchiveQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(25),
  cursor: ArchiveCursor.optional(),
  // Which reads the page needs. The dashboard's edge verdict and its live-vs-backtest card both want one field, `bySource`, over all time, and both poll it every 60s — under `full` that loaded a page of rows plus two whole-archive coverage scans to build a response they discard. `rollup` asks for the rollup's source read and nothing else; the fields the other reads would have filled are then OMITTED rather than sent empty, because an empty list is a claim about the archive that this response did not check.
  view: z.enum(['full', 'rollup']).default('full'),
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
    // Both are reachable and neither was declared. A malformed `cursor` fails `ArchiveCursor` at the boundary, and the reads run under a statement budget whose expiry answers SERVICE_UNAVAILABLE — a client generated from this document would otherwise treat either as an undeclared protocol error.
    422: {
      description: 'VALIDATION_FAILED',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    503: { description: 'UNAVAILABLE', content: { 'application/json': { schema: ErrorEnvelope } } },
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
    const { limit, cursor, period, tz, view } = c.req.valid('query');

    const { from } = periodWindow(period, tz, new Date());
    // `ArchiveCursor` has already proven both halves and the separator, so the split cannot fail here.
    let cursorObj: { archivedAt: string; id: string } | null = null;
    if (cursor !== undefined) {
      const { timestamp, id } = splitCompositeCursor(cursor, CURSOR_SEPARATOR);
      cursorObj = { archivedAt: timestamp, id };
    }
    // 'a' (all time) returns from=0; the strict `gte 0` predicate keeps the
    // SQL stable across periods so the planner's index pick doesn't shift.
    const fromDate = period === 'a' ? null : from;

    // Resolved before the transaction opens: `userIdOf` throws 401 when the request carries no session, `accountIdOf` throws 404 on a malformed `:accountId`, and a request that was always going to fail on either should not first open a BEGIN and take a pooled connection with it.
    const operatorId = userIdOf(c);
    const accountId = accountIdOf(c);

    // One transaction on one pooled connection, reads issued in sequence. Run concurrently they took a connection each, so three of these page loads in flight held the whole api pool of ten and every other route queued behind them — and until a read carries an execution budget, "queued behind" has no end. The trade is latency: concurrent cost this page its slowest read, serial costs the sum of all four. A page that renders a little later, against a pool one screen can no longer empty.
    // The ownership check is minted inside the transaction so it runs on that same connection. `ProfileNotOwnedError` still surfaces as a 404: drizzle rolls the transaction back and rethrows the original error, not a wrapper.
    // The by-intent rollup is period-scoped (every trade in the window, not just this page), so it reads the full period separately from the paged list. The archive is small enough per profile to read unpaginated.
    // The rollup branch lives INSIDE this callback rather than around it: `withStatementTimeout` refuses a transaction handle, so a second wrapper for the rollup path would either nest a SAVEPOINT whose budget leaks into the rest of the transaction, or open a second pooled connection for the same request.
    const rollupOnly = view === 'rollup';
    const { rows, recoverableSymbols, rawUnreconstructable, periodRows } =
      await withStatementTimeout(di.db, ARCHIVE_READ_BUDGET_MS, async (tx) => {
        const p = await profileRepo(tx, operatorId, accountId, profileId);
        const rows = rollupOnly
          ? undefined
          : await p.tradeArchive.listForProfilePaginated(limit, fromDate, cursorObj);
        const recoverableSymbols = rollupOnly
          ? undefined
          : await p.tradeArchive.listRecoverableSymbols();
        const rawUnreconstructable = rollupOnly
          ? undefined
          : await p.tradeArchive.listUnreconstructableSymbols();
        const periodRows = await p.tradeArchive.listForProfileInRange(fromDate);
        return { rows, recoverableSymbols, rawUnreconstructable, periodRows };
      });
    const unreconstructableSymbols = rawUnreconstructable?.map((u) => ({
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
    const last = rows?.at(-1);
    // `cursorToken`, not `archivedAt.toISOString()`: the row's `archivedAt` has already lost its microseconds to the driver's `Date`, and a boundary emitted at that reduced precision strands every row sharing its millisecond.
    // Undefined rather than null when no page was read: null is this route's "end of stream", which a response that never walked the archive cannot assert.
    const nextCursor =
      rows === undefined
        ? undefined
        : rows.length === limit && last !== undefined
          ? `${last.cursorToken}${CURSOR_SEPARATOR}${last.id}`
          : null;
    return c.json(
      {
        items: rows?.map((r) => ({
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
          // Carried so the UI can say "P/L unavailable" instead of rendering an
          // under-counted `profit` of 0 as a measured break-even.
          missingCostBasis: r.missingCostBasis,
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
