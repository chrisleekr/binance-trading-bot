import { and, eq, max } from 'drizzle-orm';
import { appliedFills } from '../schema/applied-fills.js';
import type { ProfileScope } from './_scoped.js';

export interface FillIdentity {
  readonly symbol: string;
  readonly orderId: number;
  readonly tradeId: number;
  readonly side: 'BUY' | 'SELL';
}

/**
 * Records a fill as applied. Returns `true` if the row was newly inserted
 * (first apply); `false` if the (profile, symbol, orderId, tradeId) tuple
 * already existed (replay). The boolean is what fill-adopter routes on:
 * first-apply takes the weighted-average path, replay takes the
 * state-convergence path that reads existing LBP without recomputing.
 */
export async function tryRecord(scope: ProfileScope, identity: FillIdentity): Promise<boolean> {
  const inserted = await scope.db
    .insert(appliedFills)
    .values({
      profileId: scope.profileId,
      symbol: identity.symbol,
      orderId: identity.orderId,
      tradeId: identity.tradeId,
      side: identity.side,
    })
    .onConflictDoNothing({
      target: [
        appliedFills.profileId,
        appliedFills.symbol,
        appliedFills.orderId,
        appliedFills.tradeId,
      ],
    })
    .returning({ orderId: appliedFills.orderId });
  return inserted.length > 0;
}

/**
 * The highest trade id adopted for a (profile, symbol), or `null` when none
 * have been recorded. The user-stream-reconnect fill backfill anchors its
 * `getMyTrades(fromId)` on this, so it only folds trades newer than the
 * last-adopted one and never re-folds an already-adopted order (the live
 * adopter records one row per order at its terminal trade id, so this max
 * is the boundary past which no order has been fully adopted).
 */
export async function maxTradeId(scope: ProfileScope, symbol: string): Promise<number | null> {
  const rows = await scope.db
    .select({ value: max(appliedFills.tradeId) })
    .from(appliedFills)
    .where(and(eq(appliedFills.profileId, scope.profileId), eq(appliedFills.symbol, symbol)));
  return rows[0]?.value ?? null;
}
