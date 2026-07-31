import {
  coerceArchivedOrders,
  decimalSub,
  deriveExitIntent,
  type DecimalString,
  type OrderList,
  type OrderResponse,
  type SymbolStateResponse,
  type TradeArchiveList,
} from '@app/contracts';

import { profileKey } from '../../redis.js';
import type { OrderRow } from '../../schema/index.js';
import { ProfileNotOwnedError } from '../_scoped.js';
import type { ProfileScope } from '../_scoped.js';
import * as avgEntryPrices from '../avg-entry-prices.js';
import * as orders from '../orders.js';
import * as profilesMod from '../profiles.js';
import * as symbolStatesMod from '../symbol-states.js';
import * as tradeArchive from '../trade-archive.js';
import type { ProjectionRedis } from './redis-port.js';

/** Map a persisted order row to its wire shape. Shared across projections
 * so every view (live-order, order-history, profile-dashboard) serialises
 * an order identically. */
export const orderToResponse = (row: OrderRow): OrderResponse => ({
  id: row.id,
  symbol: row.symbol,
  side: row.side as 'BUY' | 'SELL',
  intent: row.intent,
  binanceOrderId: row.binanceOrderId.toString(),
  clientOrderId: row.clientOrderId,
  status: row.status,
  raw: row.raw,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  closedAt: row.closedAt ? row.closedAt.toISOString() : null,
});

/**
 * Per-symbol state: the profile's strategy identity + opaque config/state,
 * the avg-entry-price row, live open orders, and the Redis-derived disable
 * (kill-switch) state. The grid ladder is strategy-specific, so `config`
 * and `state` pass through opaquely for the web to revive.
 */
export const getSymbolState = async (
  scope: ProfileScope,
  redis: ProjectionRedis,
  symbol: string,
): Promise<SymbolStateResponse> => {
  const { operatorId, accountId, profileId } = scope;
  const profile = await profilesMod.findById(scope);
  if (!profile) throw new ProfileNotOwnedError(operatorId, accountId, profileId);

  const disableKey = profileKey(scope, 'disableAction', symbol);
  const [lbp, openOrders, disableRaw, disableTtl, symbolState] = await Promise.all([
    avgEntryPrices.findBySymbol(scope, symbol),
    orders.listLiveForSymbol(scope, symbol),
    redis.get(disableKey),
    redis.ttl(disableKey),
    symbolStatesMod.findBySymbol(scope, symbol),
  ]);

  let disable: { ttlSeconds: number; since: string; reason: string } | null = null;
  // ioredis TTL semantics: -2 = key missing, -1 = key without TTL,
  // 0..n = seconds remaining. The kill-switch route always sets EX, so
  // -1 indicates a bug elsewhere — surface the disable with `ttlSeconds:
  // 0` so the operator still sees a banner instead of silent failure.
  if (disableRaw && disableTtl !== -2) {
    const ttlSeconds = disableTtl > 0 ? disableTtl : 0;
    try {
      const parsed = JSON.parse(disableRaw) as { reason?: unknown; since?: unknown };
      // The contract declares `since: z.iso.datetime()`. A malformed string
      // here would round-trip past the API's response validator and break
      // the client; normalise via Date so anything unparseable falls back
      // to "now" instead of poisoning the response shape.
      let since = new Date().toISOString();
      if (typeof parsed.since === 'string') {
        const parsedDate = new Date(parsed.since);
        if (!Number.isNaN(parsedDate.getTime())) {
          since = parsedDate.toISOString();
        }
      }
      const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
      disable = { ttlSeconds, since, reason };
    } catch {
      // The kill-switch route writes JSON; a malformed value here is a bug
      // in another layer, not a reason to crash the read path. Surface as
      // "disabled with no metadata" rather than 5xx.
      disable = { ttlSeconds, since: new Date().toISOString(), reason: '' };
    }
  }

  // Strategy state is per-(profile, symbol): read this symbol's own slice
  // from `symbol_states`. A missing row means the symbol has not ticked yet,
  // which reads as null. `config` is the raw profile config here; the API
  // route layers the per-symbol override on top via mergeConfig.
  return {
    strategy: {
      name: profile.strategyName,
      config: profile.config,
      state: symbolState?.state ?? null,
      // The db projection is strategy-agnostic and cannot read a strategy's
      // capabilities (no strategy-package import). The api boundary fills the
      // real operator-action set from the registry, the same way it replaces
      // `config` with the override-merged config. Empty here is the safe
      // default — it surfaces no panels — if the api ever forgets to fill it.
      operatorActions: [],
    },
    avgEntryPrice: lbp
      ? {
          avgEntryPrice: lbp.avgEntryPrice as DecimalString,
          quantity: lbp.quantity as DecimalString,
          updatedAt: lbp.updatedAt.toISOString(),
        }
      : null,
    openOrders: openOrders.map(orderToResponse),
    disable,
    entryBlocker: readEntryBlocker(symbolState?.state),
    protectiveStopBlocker: readProtectiveStopBlocker(symbolState?.state),
  };
};

/**
 * Read one blocker record ({ reason, detail? } | null) off the persisted strategy
 * state by key. The projection is strategy-agnostic and treats the state body as
 * opaque, so it reads the well-known convention off the JSONB object and returns
 * null for any state that omits the key or stores it malformed.
 */
const readStateBlocker = (state: unknown, key: string): SymbolStateResponse['entryBlocker'] => {
  if (typeof state !== 'object' || state === null) return null;
  const raw = (state as Record<string, unknown>)[key];
  if (typeof raw !== 'object' || raw === null) return null;
  const reason = (raw as Record<string, unknown>)['reason'];
  if (typeof reason !== 'string') return null;
  const detail = (raw as Record<string, unknown>)['detail'];
  return {
    reason,
    ...(typeof detail === 'object' && detail !== null
      ? { detail: detail as Readonly<Record<string, unknown>> }
      : {}),
  };
};

/** Why the strategy last refused to open a position on this symbol, or null. */
export const readEntryBlocker = (state: unknown): SymbolStateResponse['entryBlocker'] =>
  readStateBlocker(state, 'entryBlocker');

/**
 * Why an OPEN position has no exchange-side protective stop, or null. Read
 * alongside `entryBlocker` because the two answer different questions and the
 * dashboard shows the unprotected-position one louder.
 */
export const readProtectiveStopBlocker = (
  state: unknown,
): SymbolStateResponse['protectiveStopBlocker'] => readStateBlocker(state, 'protectiveStopBlocker');

/** Most-recent order history for one symbol, newest first, capped at `limit`. */
export const getSymbolOrderHistory = async (
  scope: ProfileScope,
  symbol: string,
  limit: number,
): Promise<OrderList> => {
  const rows = await orders.listHistoryForSymbol(scope, symbol, limit);
  return { items: rows.map(orderToResponse) };
};

/** Closed-trade archive rows for one symbol, newest first, capped at `limit`. */
export const getSymbolArchive = async (
  scope: ProfileScope,
  symbol: string,
  limit: number,
): Promise<TradeArchiveList> => {
  const rows = await tradeArchive.listForSymbol(scope, symbol, limit);
  return {
    items: rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      baseAsset: r.baseAsset,
      quoteAsset: r.quoteAsset,
      totalBuyQuote: r.totalBuyQuote as DecimalString,
      totalSellQuote: r.totalSellQuote as DecimalString,
      breakdown: r.breakdown as Record<string, DecimalString>,
      fees: r.fees as Record<string, DecimalString>,
      feesQuote: r.feesQuote as DecimalString,
      netProfit: decimalSub(r.profit, r.feesQuote),
      profit: r.profit as DecimalString,
      profitPercent: r.profitPercent as DecimalString,
      exitIntent: deriveExitIntent(coerceArchivedOrders(r.orders)),
      archivedAt: r.archivedAt.toISOString(),
    })),
  };
};
