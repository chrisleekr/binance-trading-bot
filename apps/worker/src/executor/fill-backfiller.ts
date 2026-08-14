// Fill-backfiller: recovers fills Binance never replays on the user stream.
//
// On a user-stream (re)subscribe Binance only sends events from that point
// on, so a fill that landed during a disconnect window is gone from the
// stream. The live fill-adopter runs only on `executionReport`s, so that
// fill is never adopted and `avgEntryPrice` / held quantity drift
// permanently (a real money error on every downstream sell threshold).
//
// On a user-stream reconnect the worker calls `backfill` per symbol: it
// pulls the account's own trades via `getMyTrades` and folds any not-yet-
// adopted ones through the same fill-adopter path. The adopter's
// `applied_fills` gate makes this idempotent against the live stream and
// against repeated reconnects.

import type { Logger } from 'pino';
import { Decimal, isPlainDecimalString } from '@app/money';
import { type Database, profileRepo, ProfileNotOwnedError } from '@app/db';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { BinanceRestClient } from '@app/binance';

import type { FillAdopter } from './fill-adopter.js';

// Binance caps a `myTrades` page at 1000. The disconnect-window gap is
// small, so one page anchored past the last-adopted trade covers it.
const MY_TRADES_PAGE_LIMIT = 1000;

export interface FillBackfiller {
  /**
   * Folds account trades newer than the last-adopted one for this
   * (profile, symbol) through the fill-adopter. No-op when no fill has
   * ever been adopted for the symbol (no baseline to extend — the boot
   * reconcilers own initial cost basis) or when the strategy has no
   * position capability. Idempotent.
   */
  backfill(
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
    symbol: string,
  ): Promise<void>;
}

export interface FillBackfillerDeps {
  readonly db: Database;
  /** Per-account signed REST client; `null` when the account or its API key is missing (deletion / pre-onboarding race). */
  readonly resolveBinanceClient: (
    operatorId: UserId,
    accountId: AccountId,
  ) => Promise<BinanceRestClient | null>;
  readonly fillAdopter: FillAdopter;
  readonly logger: Logger;
}

// One order's trades folded into the cumulative shape the live adopter
// produces: the whole order at its terminal (max) trade id.
interface AggregatedOrder {
  readonly orderId: number;
  readonly side: 'BUY' | 'SELL';
  terminalTradeId: number;
  cumQty: Decimal;
  cumQuoteQty: Decimal;
  /**
   * Per-asset commission totals across the order's trades. `null` latches an
   * invalid trade fee so no valid-looking partial subtotal reaches the adopter.
   */
  commissions: Map<string, Decimal> | null;
}

interface ValidatedTrade {
  readonly id: number;
  readonly orderId: number;
  readonly symbol: string;
  readonly qty: string;
  readonly quoteQty: string;
  readonly commission: unknown;
  readonly commissionAsset: unknown;
  readonly isBuyer: boolean;
}

const isNonNegativeDecimal = (value: unknown): value is string => {
  if (typeof value !== 'string' || !isPlainDecimalString(value)) return false;
  const parsed = new Decimal(value);
  return parsed.isFinite() && parsed.gte(0);
};

const validateTrade = (value: unknown, requestedSymbol: string): ValidatedTrade | null => {
  if (typeof value !== 'object' || value === null) return null;
  const trade = value as Record<string, unknown>;
  if (
    trade['symbol'] !== requestedSymbol ||
    !Number.isInteger(trade['id']) ||
    !Number.isInteger(trade['orderId']) ||
    typeof trade['isBuyer'] !== 'boolean' ||
    !isNonNegativeDecimal(trade['qty']) ||
    !isNonNegativeDecimal(trade['quoteQty'])
  ) {
    return null;
  }
  return {
    id: trade['id'] as number,
    orderId: trade['orderId'] as number,
    symbol: requestedSymbol,
    qty: trade['qty'],
    quoteQty: trade['quoteQty'],
    commission: trade['commission'],
    commissionAsset: trade['commissionAsset'],
    isBuyer: trade['isBuyer'],
  };
};

const parseTradeCommission = (
  commission: unknown,
  commissionAsset: unknown,
): { readonly asset: string; readonly charged: Decimal } | null => {
  if (
    typeof commission !== 'string' ||
    typeof commissionAsset !== 'string' ||
    !commissionAsset ||
    !isPlainDecimalString(commission)
  ) {
    return null;
  }
  const charged = new Decimal(commission);
  return charged.isFinite() && charged.gte(0) ? { asset: commissionAsset, charged } : null;
};

/** Fields that define one per-symbol Binance trade for replay validation. */
const isExactTradeReplay = (a: ValidatedTrade, b: ValidatedTrade): boolean =>
  a.symbol === b.symbol &&
  a.orderId === b.orderId &&
  a.isBuyer === b.isBuyer &&
  a.qty === b.qty &&
  a.quoteQty === b.quoteQty &&
  a.commission === b.commission &&
  a.commissionAsset === b.commissionAsset;

export const createFillBackfiller = (deps: FillBackfillerDeps): FillBackfiller => {
  const backfill = async (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
    symbol: string,
  ): Promise<void> => {
    let scope;
    try {
      scope = await profileRepo(deps.db, operatorId, accountId, profileId);
    } catch (err) {
      if (err instanceof ProfileNotOwnedError) {
        // A failed ownership proof is either a live race (the profile was deleted
        // between the enqueue and this run) or a wiring bug. Both are worth a
        // line: skipping the backfill silently would hide the second forever.
        deps.logger.warn(
          { operatorId, accountId, profileId, symbol },
          'fill-backfill: ownership proof failed; skipping (profile deleted, or a wiring bug)',
        );
        return;
      }
      throw err;
    }

    // Anchor past the last-adopted trade. The live adopter records one
    // `applied_fills` row per order at its terminal trade id, so this max
    // is the boundary past which no order has been fully adopted; trades
    // at or below it belong to already-adopted orders. `null` means no
    // baseline yet — skip rather than fold ambiguous pre-baseline history
    // (boot reconcilers own initial cost basis).
    //
    // Assumes at most one in-flight order per symbol (the trailing-trade
    // grid places one order at a time). With concurrent same-symbol orders,
    // a never-adopted order whose trades straddle `anchor` could be folded
    // with a partial cumulative qty — out of scope for the current grid.
    const anchor = await scope.appliedFills.maxTradeId(symbol);
    if (anchor === null) return;

    const client = await deps.resolveBinanceClient(operatorId, accountId);
    if (!client) return;

    const trades = await client.getMyTrades({
      symbol,
      fromId: anchor + 1,
      limit: MY_TRADES_PAGE_LIMIT,
    });
    if (trades.length === 0) return;

    // Validate the whole page before adopting anything. Every row must belong
    // to the requested symbol, where trade id is the identity. Exact repeats
    // are harmless reconnect replays; conflicting payloads cannot both be trusted.
    const byTradeId = new Map<number, ValidatedTrade>();
    for (const untrustedTrade of trades as readonly unknown[]) {
      const trade = validateTrade(untrustedTrade, symbol);
      if (!trade) {
        deps.logger.error(
          { profileId, symbol },
          'fill-backfiller: invalid trade row; skipping the untrustworthy batch',
        );
        return;
      }
      const original = byTradeId.get(trade.id);
      if (!original) {
        byTradeId.set(trade.id, trade);
      } else if (!isExactTradeReplay(original, trade)) {
        deps.logger.error(
          { profileId, symbol, tradeId: trade.id },
          'fill-backfiller: conflicting duplicate trade id; skipping the untrustworthy batch',
        );
        return;
      }
    }
    const uniqueTrades = [...byTradeId.values()];

    // Re-create the live adopter's per-order shape: fold each order's full
    // cumulative qty once, keyed by its terminal trade id, so adoption
    // dedupes against the live `applied_fills` row instead of double-
    // counting each partial trade.
    const byOrder = new Map<number, AggregatedOrder>();
    for (const t of uniqueTrades) {
      const parsedCommission = parseTradeCommission(t.commission, t.commissionAsset);
      const existing = byOrder.get(t.orderId);
      if (existing) {
        existing.cumQty = existing.cumQty.add(t.qty);
        existing.cumQuoteQty = existing.cumQuoteQty.add(t.quoteQty);
        if (t.id > existing.terminalTradeId) existing.terminalTradeId = t.id;
        if (existing.commissions !== null) {
          if (parsedCommission === null) {
            existing.commissions = null;
          } else {
            const prior = existing.commissions.get(parsedCommission.asset) ?? new Decimal(0);
            existing.commissions.set(parsedCommission.asset, prior.plus(parsedCommission.charged));
          }
        }
      } else {
        const commissions =
          parsedCommission === null
            ? null
            : new Map([[parsedCommission.asset, parsedCommission.charged]]);
        byOrder.set(t.orderId, {
          orderId: t.orderId,
          side: t.isBuyer ? 'BUY' : 'SELL',
          terminalTradeId: t.id,
          cumQty: new Decimal(t.qty),
          cumQuoteQty: new Decimal(t.quoteQty),
          commissions,
        });
      }
    }

    // Adopt in terminal-trade-id order: resolveFill folds BUY/SELL in
    // execution order, so the cost basis must replay chronologically.
    const orders = [...byOrder.values()].sort((a, b) => a.terminalTradeId - b.terminalTradeId);
    let adopted = 0;
    for (const o of orders) {
      try {
        await deps.fillAdopter.adopt({
          operatorId,
          accountId,
          profileId,
          symbol,
          orderId: o.orderId,
          tradeId: o.terminalTradeId,
          orderStatus: 'FILLED',
          side: o.side,
          cumQty: o.cumQty.toString(),
          cumQuoteQty: o.cumQuoteQty.toString(),
          // Pass the fee through so the recovery path nets a base-asset BUY
          // commission identically to the live user-stream path; a divergence
          // here would leave a backfilled position permanently un-exitable.
          ...(o.commissions
            ? {
                commissions: Object.fromEntries(
                  [...o.commissions].map(([asset, total]) => [asset, total.toString()]),
                ),
              }
            : {}),
        });
        adopted += 1;
      } catch (err) {
        deps.logger.error(
          { profileId, symbol, orderId: o.orderId, err: err },
          'fill-backfiller: adopt threw for a backfilled order; cost basis may stay drifted until the next fill',
        );
      }
    }
    // One summary line regardless of outcome so a wholesale backfill
    // failure (every adopt threw) is alertable, not just N scattered
    // per-order errors.
    deps.logger.info(
      { profileId, symbol, fromTradeId: anchor + 1, orders: orders.length, adopted },
      'fill-backfiller: backfill complete after user-stream reconnect',
    );
  };

  return { backfill };
};
