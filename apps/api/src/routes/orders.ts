import { BinanceApiError, type OrderBookDto, type RecentTradeDto } from '@app/binance';
import {
  asDecimalString,
  asProfileId,
  BINANCE_KLINE_INTERVALS,
  CandleList,
  ErrorEnvelope,
  type OperatorAction,
  OrderBook,
  OrderList,
  RecentTradeList,
  SymbolLogList,
  SymbolStateResponse,
  Ticker24hr,
  TradeArchiveList,
} from '@app/contracts';
import { projections, repo } from '@app/db';
import { mergeConfig } from '@app/strategy-core';
import { stream } from 'hono/streaming';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { HttpError } from 'middleware/error.js';
import { requireUser } from 'middleware/require-user.js';
import { requireOwnedProfile, scopeOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

const ProfileSymbolParam = z.object({
  profileId: z.uuid(),
  symbol: z.string().min(1).max(32),
});
const PaginationQ = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
const TimeRangeQ = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
});
// Binance returns at most 1000 klines per call. The chart window is far
// smaller (240 frames), so this is a generous explicit cap rather than a
// limit the operator can reach.
const BINANCE_KLINE_MAX_ROWS = 1_000;

const CandleQ = TimeRangeQ.extend({
  interval: z.enum(BINANCE_KLINE_INTERVALS),
});
// The audit-log export is a single "export all" button with no date-range
// UI, so `from`/`to` are optional here and default to the full retained
// history in the handler. (Symbol-log and candle routes keep TimeRangeQ,
// where both bounds are required.)
const ProfileLogsQ = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

/**
 * Maps a Binance REST failure onto an HttpError the SPA can act on. 429 is
 * upstream throttling; other 4xx means the request itself was bad (unknown
 * symbol, rejected parameter); 5xx and network errors are an upstream
 * failure. Non-Binance errors rethrow unchanged.
 */
function rethrowAsHttpError(err: unknown): never {
  if (err instanceof BinanceApiError) {
    let code: 'RATE_LIMITED' | 'VALIDATION_FAILED' | 'UPSTREAM_FAILED' = 'UPSTREAM_FAILED';
    if (err.status === 429) code = 'RATE_LIMITED';
    else if (err.status >= 400 && err.status < 500) code = 'VALIDATION_FAILED';
    throw new HttpError(code, err.message);
  }
  throw err;
}

const stateRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/symbols/{symbol}/state',
  tags: ['orders'],
  request: { params: ProfileSymbolParam },
  responses: {
    200: { description: 'state', content: { 'application/json': { schema: SymbolStateResponse } } },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const ordersRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/symbols/{symbol}/orders',
  tags: ['orders'],
  request: { params: ProfileSymbolParam, query: PaginationQ },
  responses: {
    200: { description: 'orders', content: { 'application/json': { schema: OrderList } } },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const archiveRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/symbols/{symbol}/archive',
  tags: ['orders'],
  request: { params: ProfileSymbolParam, query: PaginationQ },
  responses: {
    200: { description: 'archive', content: { 'application/json': { schema: TradeArchiveList } } },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const candlesRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/symbols/{symbol}/candles',
  tags: ['orders'],
  request: { params: ProfileSymbolParam, query: CandleQ },
  responses: {
    200: {
      description: 'candles',
      content: { 'application/json': { schema: CandleList } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const ticker24hrRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/symbols/{symbol}/ticker',
  tags: ['orders'],
  request: { params: ProfileSymbolParam },
  responses: {
    200: { description: 'ticker', content: { 'application/json': { schema: Ticker24hr } } },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

// Binance `/api/v3/trades` row cap. 50 is enough for an at-a-glance recent-
// trades panel; the operator scans the latest fills, not deep history.
const RECENT_TRADES_LIMIT = 50;

const recentTradesRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/symbols/{symbol}/trades',
  tags: ['orders'],
  request: { params: ProfileSymbolParam },
  responses: {
    200: {
      description: 'recent trades',
      content: { 'application/json': { schema: RecentTradeList } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

// Binance `/api/v3/depth` accepts a fixed set of `limit` values. 100 levels
// per side feed the panel's price-grouping: the operator can aggregate the
// raw ladder into coarser buckets and still see real liquidity depth. The
// panel slices the rendered rows down from this regardless of grouping.
const ORDER_BOOK_LIMIT = 100;

const orderBookRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/symbols/{symbol}/depth',
  tags: ['orders'],
  request: { params: ProfileSymbolParam },
  responses: {
    200: { description: 'order book', content: { 'application/json': { schema: OrderBook } } },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const logsRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/symbols/{symbol}/logs',
  tags: ['orders'],
  request: { params: ProfileSymbolParam, query: TimeRangeQ },
  responses: {
    200: { description: 'logs', content: { 'application/json': { schema: SymbolLogList } } },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const ProfileIdParam = z.object({ profileId: z.uuid() });
const ArchiveDeleteParam = z.object({
  profileId: z.uuid(),
  archiveId: z.uuid(),
});

// `/audit-logs/export`, not `/logs/export`: this streams audit_logs, the record
// of what the OPERATOR changed. `/logs/export` now belongs to the action-log
// export, which is what an operator asking to "export the logs" means.
const logsExportRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/audit-logs/export',
  tags: ['orders'],
  request: { params: ProfileIdParam, query: ProfileLogsQ },
  responses: {
    200: { description: 'NDJSON stream of audit_logs' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const archiveDeleteRoute = createRoute({
  method: 'delete',
  path: '/profiles/{profileId}/trade-archive/{archiveId}',
  tags: ['orders'],
  request: { params: ArchiveDeleteParam },
  responses: {
    204: { description: 'deleted' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

export const ordersRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/profiles/*', requireUser());

  app.openapi(stateRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const p = await scopeOf(c, di, asProfileId(profileIdRaw));
    const state = await projections.getSymbolState(p.scope, di.redis.raw(), symbol);
    // Layer the per-symbol override onto the profile config so the panel's
    // predicted thresholds match the worker, which ticks the merged config
    // (mirrors the worker's profile-bindings/tick-context). The db projection
    // stays strategy-agnostic; the strategy-aware merge lives at this boundary.
    const override = await p.profileSymbols.findForSymbol(symbol);
    const config = mergeConfig(state.strategy.config, override?.overrideConfig ?? null);
    // The db projection leaves operatorActions empty (it cannot read strategy
    // capabilities); fill it from the registry so the symbol screen hides any
    // panel whose write the strategy would silently drop. getSymbolState already
    // loaded the profile to build the response but does not expose its name, so
    // re-read it here for the registry lookup (one indexed PK read; the symbol
    // page is not the hot dashboard path). Resolve against the live plugin: a
    // profile pinned to a bumped strategy version still surfaces its actions
    // and only a genuinely-unregistered name yields no panels.
    const profile = await p.profile.findById();
    const resolved = profile
      ? di.strategies.describeForProfile(profile.strategyName, profile.strategyVersion)
      : null;
    const strategy = resolved && resolved.status !== 'unknown' ? resolved.strategy : null;
    const operatorActions = (
      strategy ? [...strategy.capabilities.operatorActions] : []
    ) as OperatorAction[];
    return c.json({ ...state, strategy: { ...state.strategy, config, operatorActions } }, 200);
  });

  app.openapi(ordersRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const { limit } = c.req.valid('query');
    const p = await scopeOf(c, di, asProfileId(profileIdRaw));
    const history = await projections.getSymbolOrderHistory(p.scope, symbol, limit);
    return c.json(history, 200);
  });

  app.openapi(archiveRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const { limit } = c.req.valid('query');
    const p = await scopeOf(c, di, asProfileId(profileIdRaw));
    const archive = await projections.getSymbolArchive(p.scope, symbol, limit);
    return c.json(archive, 200);
  });

  app.openapi(candlesRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const { interval, from, to } = c.req.valid('query');
    const profileId = asProfileId(profileIdRaw);
    const { p } = await requireOwnedProfile(c, di, profileId);
    const mode = (await repo.accounts.binanceModeById(di.db, p.scope.accountId)) ?? 'test';
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (fromMs > toMs) {
      throw new HttpError('VALIDATION_FAILED', 'from must be at or before to');
    }
    // Candles are exchange-global market data, not account-scoped state, so
    // they are read live from Binance's public klines endpoint rather than
    // persisted. The profile is loaded only to authorise the request and to
    // route the call to the testnet or live host.
    let klines;
    try {
      klines = await di.marketData.getKlines(mode, {
        symbol,
        interval,
        startTime: fromMs,
        endTime: toMs,
        limit: BINANCE_KLINE_MAX_ROWS,
      });
    } catch (err) {
      rethrowAsHttpError(err);
    }
    return c.json(
      klines.map((k) => ({
        time: new Date(k.openTimeMs).toISOString(),
        open: asDecimalString(k.open),
        high: asDecimalString(k.high),
        low: asDecimalString(k.low),
        close: asDecimalString(k.close),
        volume: asDecimalString(k.volume),
      })),
      200,
    );
  });

  app.openapi(ticker24hrRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const { p } = await requireOwnedProfile(c, di, asProfileId(profileIdRaw));
    const mode = (await repo.accounts.binanceModeById(di.db, p.scope.accountId)) ?? 'test';
    // 24h stats are exchange-global market data, not account-scoped state —
    // read live from Binance's public ticker endpoint, same as candles. The
    // profile is loaded only to authorise and to pick the testnet/live host.
    let ticker;
    try {
      ticker = await di.marketData.getTicker24hr(mode, symbol);
    } catch (err) {
      rethrowAsHttpError(err);
    }
    return c.json(
      {
        symbol: ticker.symbol,
        lastPrice: asDecimalString(ticker.lastPrice),
        priceChange: asDecimalString(ticker.priceChange),
        priceChangePercent: asDecimalString(ticker.priceChangePercent),
        highPrice: asDecimalString(ticker.highPrice),
        lowPrice: asDecimalString(ticker.lowPrice),
        openPrice: asDecimalString(ticker.openPrice),
        volume: asDecimalString(ticker.volume),
        quoteVolume: asDecimalString(ticker.quoteVolume),
      },
      200,
    );
  });

  app.openapi(recentTradesRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const { p } = await requireOwnedProfile(c, di, asProfileId(profileIdRaw));
    const mode = (await repo.accounts.binanceModeById(di.db, p.scope.accountId)) ?? 'test';
    // Recent trades are exchange-global market data, not account-scoped state
    // — read live from Binance's public trades endpoint, same as candles and
    // the 24h ticker. The profile is loaded only to authorise and to pick the
    // testnet/live host.
    let trades: RecentTradeDto[];
    try {
      trades = await di.marketData.getRecentTrades(mode, symbol, RECENT_TRADES_LIMIT);
    } catch (err) {
      rethrowAsHttpError(err);
    }
    return c.json(
      trades.map((t) => ({
        id: t.id,
        price: asDecimalString(t.price),
        qty: asDecimalString(t.qty),
        quoteQty: asDecimalString(t.quoteQty),
        time: new Date(t.time).toISOString(),
        isBuyerMaker: t.isBuyerMaker,
      })),
      200,
    );
  });

  app.openapi(orderBookRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const { p } = await requireOwnedProfile(c, di, asProfileId(profileIdRaw));
    const mode = (await repo.accounts.binanceModeById(di.db, p.scope.accountId)) ?? 'test';
    // Order-book depth is exchange-global market data, not account-scoped
    // state — read live from Binance's public depth endpoint, same as candles
    // and recent trades. The profile is loaded only to authorise and to pick
    // the testnet/live host.
    let book: OrderBookDto;
    try {
      book = await di.marketData.getDepth(mode, symbol, ORDER_BOOK_LIMIT);
    } catch (err) {
      rethrowAsHttpError(err);
    }
    const toLevels = (rows: readonly (readonly [string, string])[]) =>
      rows.map(([price, qty]) => ({ price: asDecimalString(price), qty: asDecimalString(qty) }));
    return c.json({ bids: toLevels(book.bids), asks: toLevels(book.asks) }, 200);
  });

  app.openapi(logsRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const { from, to } = c.req.valid('query');
    const p = await scopeOf(c, di, asProfileId(profileIdRaw));
    const logs = await projections.getSymbolLogs(p.scope, symbol, new Date(from), new Date(to));
    return c.json(logs, 200);
  });

  app.openapi(logsExportRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const p = await scopeOf(c, di, profileId);
    const { from, to } = c.req.valid('query');
    // The profile row is loaded only for the export filename; `?? 'profile'`
    // covers the impossible race where the row is deleted after scoping.
    const profile = await p.profile.findById();
    const rows = await projections.getProfileAuditLogExport(
      p.scope,
      from ? new Date(from) : new Date(0),
      to ? new Date(to) : new Date(),
    );
    c.header('content-type', 'application/x-ndjson');
    // Without an explicit filename the browser saves the stream as `export`
    // (or `export.json`), mislabelling newline-delimited JSON as JSON.
    // Sanitise the name before interpolating: a stray quote or CR/LF would
    // break (or inject into) the header.
    const safeName = (profile?.name ?? 'profile').replace(/[^A-Za-z0-9._-]/g, '_');
    c.header('content-disposition', `attachment; filename="audit-${safeName}.ndjson"`);
    return stream(c, async (s) => {
      for (const r of rows) {
        await s.write(`${JSON.stringify(r)}\n`);
      }
    });
  });

  app.openapi(archiveDeleteRoute, async (c) => {
    const { profileId: profileIdRaw, archiveId } = c.req.valid('param');
    const p = await scopeOf(c, di, asProfileId(profileIdRaw));
    const ok = await p.tradeArchive.deleteById(archiveId);
    if (!ok) throw new HttpError('NOT_FOUND', 'archive');
    c.set('auditEvent', {
      event: 'delete-archive',
      payload: { profileId: p.scope.profileId, archiveId },
    });
    return new Response(null, { status: 204 });
  });

  return app;
};
