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
import { Decimal } from '@app/money';
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
}

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

    // Re-create the live adopter's per-order shape: fold each order's full
    // cumulative qty once, keyed by its terminal trade id, so adoption
    // dedupes against the live `applied_fills` row instead of double-
    // counting each partial trade.
    const byOrder = new Map<number, AggregatedOrder>();
    for (const t of trades) {
      const existing = byOrder.get(t.orderId);
      if (existing) {
        existing.cumQty = existing.cumQty.add(t.qty);
        existing.cumQuoteQty = existing.cumQuoteQty.add(t.quoteQty);
        if (t.id > existing.terminalTradeId) existing.terminalTradeId = t.id;
      } else {
        byOrder.set(t.orderId, {
          orderId: t.orderId,
          side: t.isBuyer ? 'BUY' : 'SELL',
          terminalTradeId: t.id,
          cumQty: new Decimal(t.qty),
          cumQuoteQty: new Decimal(t.quoteQty),
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
