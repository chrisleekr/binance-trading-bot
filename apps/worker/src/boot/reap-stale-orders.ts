// Boot-time reconciler for local "open" order rows whose `binanceOrderId`
// is not visible in Binance's open-orders endpoint for that symbol.
//
// Why this exists: rows can end up `status: 'NEW'` with `closed_at: null`
// locally while NOT being on the exchange's open book. Known sources:
//
//   1. Dev seed script that injected a synthetic open BUY for UI testing
//      (see memory `project_seed_dummy_transactions.md`). The bot then
//      treated the row as a real outstanding commitment.
//   2. Worker placed an order, exchange accepted it, then crashed before
//      writing the FILLED/CANCELED close — and later the order was
//      cancelled on the Binance UI or by a stale-order policy at the
//      exchange. We never observe the close because the user-stream is
//      bounded.
//   3. Manual DB poking during recovery that left an orphan row.
//   4. A resting LIMIT / STOP_LOSS_LIMIT order FILLED on the exchange but
//      the fill-adopter never saw the executionReport (user-stream gap),
//      so the row stayed NEW and never adopted the fill.
//
// "Absent from open-orders" is ambiguous: it is equally true for a
// cancelled order AND a filled one. The original reaper stamped every
// absent row CANCELED, which recorded case 4's filled buys as
// cancellations — `executedQty 0`, zeroed archive cost basis, fabricated
// P/L on the eventual sell. To disambiguate, the reaper now queries
// `getOrder` for each candidate and acts on the authoritative status:
//
//   - FILLED                  -> reclaim the row to FILLED with the
//                                exchange's executedQty / cummulativeQuoteQty
//                                so the archive cost basis is truthful.
//   - any terminal non-fill    -> reap (close) with the real terminal status.
//   - getOrder -2013 (unknown) -> the order never existed on Binance (dev
//                                seed / manual row): reap as CANCELED.
//   - transient query failure  -> leave the row live; retry next boot rather
//                                than risk stamping a filled order CANCELED.
//   - still non-terminal       -> the absence raced an in-flight place;
//                                leave the row live.
//
// This mirrors the `-2011` cancel-vs-fill reconciliation already proven in
// `executor/decisions/cancel-order.ts`; the gap was that the boot reaper
// never got the same treatment. Unlike that path, the reaper runs outside
// the per-(profile, symbol) chain lock, so a FILLED reclaim here can race a
// concurrent fill-adopter write on the same row. The reclaim is safe anyway:
// `markFilledByBinanceOrderId` is idempotent (a `status <> 'FILLED'` guard
// makes the second write a no-op) and matches by id with no `closed_at`
// guard, so whichever path runs second converges on FILLED — correctness
// rests on that, not on serialization.
//
// Failure modes are per-target: a single symbol's REST throw must not block
// sibling symbols or the rest of the boot. The worker's boot reconciler
// chain follows the same shape (heldQuantity, etc.).

import type { Logger } from 'pino';
import { accountRepoFromScope, profileRepo, toAccountScope, type Database } from '@app/db';
import { BinanceApiError, type BinanceRestClient, type OpenOrderDto } from '@app/binance';
import { isTerminalOrderStatus, type AccountId, type ProfileId, type UserId } from '@app/contracts';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';

export interface ReapStaleOrdersDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly listActive: () => readonly ActiveProfile[];
  readonly resolveBinance: (
    operatorId: UserId,
    accountId: AccountId,
  ) => Promise<{
    getOpenOrders: BinanceRestClient['getOpenOrders'];
    getOrder: BinanceRestClient['getOrder'];
  } | null>;
}

export interface ReapTally {
  readonly checked: number;
  readonly reaped: number;
  /** Candidates that `getOrder` proved FILLED and were reclaimed, not reaped. */
  readonly reclaimed: number;
  readonly failed: number;
}

/** Resolved Binance surface the reaper needs (open-orders diff + per-order status). */
type ReapBinance = NonNullable<Awaited<ReturnType<ReapStaleOrdersDeps['resolveBinance']>>>;

/**
 * Local rows the reaper is allowed to touch. Binance's order-status
 * vocabulary includes several terminal states (`FILLED`, `CANCELED`,
 * `REJECTED`, `EXPIRED`, `EXPIRED_IN_MATCH`) plus the transient
 * `PENDING_CANCEL`. `listLiveForSymbol` filters only by `closedAt IS
 * NULL`, so a row whose fill-adopter crashed between the status-write
 * and the closedAt-stamp can legitimately appear "live" while already
 * carrying a terminal status. Touching such a row would overwrite the
 * real terminal status and corrupt the audit trail.
 *
 * Allowlist the two statuses where "absent from the exchange" actually
 * proves a desync worth investigating. Everything else is left for the
 * fill-adopter to close on its next run.
 */
const REAPABLE_STATUSES = new Set(['NEW', 'PARTIALLY_FILLED']);

/**
 * Whether the candidate genuinely left the book as a non-fill. Derived from the
 * shared terminal vocabulary rather than a local list so a status the exchange
 * treats as terminal (`EXPIRED_IN_MATCH`, the self-trade-prevention terminator)
 * cannot be terminal for the open-orders cache and still "resting" here — which
 * left the row open forever, holding the live slot and the account's exposure.
 */
const isClosedNotFilled = (status: string): boolean =>
  isTerminalOrderStatus(status) && status.toUpperCase() !== 'FILLED';

/** Binance `getOrder` code for an order id that never existed on the account. */
const ORDER_NOT_EXIST = -2013;

const REAP_REASON = 'reaped-not-on-exchange';

/**
 * Computes the set of local "live" rows that are candidates for
 * reconciliation given the exchange's open-order list for the same
 * symbol. Pure so the diff is exercised in unit tests without touching
 * the DB or REST layer.
 *
 * A local row is a candidate iff:
 *   - its `status` is one of {@link REAPABLE_STATUSES}, AND
 *   - its `binanceOrderId` is absent from the exchange's open-orders set.
 *
 * Candidacy alone does NOT decide CANCELED vs FILLED — the caller queries
 * `getOrder` per candidate to learn the authoritative terminal status.
 */
export const selectReapTargets = (
  liveLocal: readonly { binanceOrderId: bigint; status: string }[],
  exchangeOpenOrders: readonly OpenOrderDto[],
): readonly bigint[] => {
  const onExchange = new Set(exchangeOpenOrders.map((o) => BigInt(o.orderId)));
  return liveLocal
    .filter((row) => REAPABLE_STATUSES.has(row.status))
    .filter((row) => !onExchange.has(row.binanceOrderId))
    .map((row) => row.binanceOrderId);
};

type ReconcileOutcome = 'reclaimed' | 'reaped' | 'skipped';

/**
 * Resolves one candidate that is absent from the open book. Queries the
 * order's authoritative status and routes FILLED -> reclaim, terminal
 * non-fill -> reap, unknown-order -> reap, everything else -> leave live.
 *
 * Exported for unit tests: the disambiguation branches are the whole point
 * of the reaper and must be exercised without a live DB / exchange.
 */
export const reconcileMissingOrder = async (
  deps: ReapStaleOrdersDeps,
  scope: Awaited<ReturnType<typeof profileRepo>>,
  rest: ReapBinance,
  target: {
    operatorId: UserId;
    accountId: AccountId;
    profileId: ProfileId;
    symbol: string;
    binanceOrderId: bigint;
  },
): Promise<ReconcileOutcome> => {
  // Reconciling by Binance order id is account-domain: the id is unique per
  // account and a DETACHED row (its profile deleted) is reachable only this way.
  // `toAccountScope` widens the ownership proof `profileRepo` already made.
  const accountOrders = accountRepoFromScope(toAccountScope(scope.scope)).orders;
  const base = {
    operatorId: target.operatorId,
    profileId: target.profileId,
    symbol: target.symbol,
    binanceOrderId: target.binanceOrderId.toString(),
  };
  let order;
  try {
    order = await rest.getOrder({ symbol: target.symbol, orderId: Number(target.binanceOrderId) });
  } catch (err) {
    if (err instanceof BinanceApiError && err.code === ORDER_NOT_EXIST) {
      // The order never existed on Binance (dev seed, manual DB row, or an
      // id we never actually placed). Genuinely orphaned: reap as CANCELED.
      const closed = await accountOrders.reapWithReason(
        target.binanceOrderId,
        'CANCELED',
        REAP_REASON,
      );
      if (closed > 0) {
        deps.logger.warn(base, 'reapStaleOrders: order unknown to exchange; reaped as CANCELED');
        return 'reaped';
      }
      return 'skipped';
    }
    // Transient query failure (network / rate limit / 5xx). Leave the row
    // live and retry on the next boot rather than risk stamping a filled
    // order CANCELED on a flaky read.
    deps.logger.warn(
      { ...base, err: err },
      'reapStaleOrders: order-status query failed (transient); leaving row live for next boot',
    );
    return 'skipped';
  }

  if (order.status === 'FILLED') {
    // The fill-adopter missed this fill off the user stream. Reclaim the row to
    // FILLED with the exchange's truthful totals. markFilledByBinanceOrderId is
    // idempotent (status<>'FILLED'). A reclaimed SELL carries NO cost-basis
    // stamp: the realised-P/L stamp lives on the user-stream fill path the
    // worker missed, and reconstructing it here is unsafe (the cost-basis ledger
    // may already be reconciled to a post-sell quantity). The archive therefore
    // treats it as missing-cost-basis — it under-counts that exit and surfaces
    // it (recoverable via the myTrades backfill), never a fabricated zero-cost
    // gain.
    const updated = await accountOrders.markFilledByBinanceOrderId(
      target.binanceOrderId,
      { executedQty: order.executedQty, cummulativeQuoteQty: order.cummulativeQuoteQty },
      order.updateTime,
    );
    if (updated > 0) {
      deps.logger.warn(
        { ...base, executedQty: order.executedQty, cummulativeQuoteQty: order.cummulativeQuoteQty },
        'reapStaleOrders: candidate had FILLED on the exchange; reclaimed to FILLED (user-stream missed the fill)',
      );
      return 'reclaimed';
    }
    return 'skipped';
  }

  if (isClosedNotFilled(order.status)) {
    const closed = await accountOrders.reapWithReason(
      target.binanceOrderId,
      order.status,
      REAP_REASON,
    );
    if (closed > 0) {
      deps.logger.warn(
        { ...base, status: order.status },
        'reapStaleOrders: order left the book; reaped',
      );
      return 'reaped';
    }
    return 'skipped';
  }

  // Non-terminal (NEW / PARTIALLY_FILLED / PENDING_CANCEL): the absence from
  // open-orders raced an in-flight state change. Leave the row; the next boot
  // or the user stream resolves it.
  deps.logger.warn(
    { ...base, queried: order.status },
    'reapStaleOrders: candidate still non-terminal; leaving row live',
  );
  return 'skipped';
};

/**
 * Iterates active (profile, symbol) pairs, computes the candidate set,
 * disambiguates each via `getOrder`, and reclaims-or-reaps accordingly.
 * Returns a per-call tally so the boot wiring can log a single summary line.
 */
export const runStaleOrderReaper = async (deps: ReapStaleOrdersDeps): Promise<ReapTally> => {
  let checked = 0;
  let reaped = 0;
  let reclaimed = 0;
  let failed = 0;
  for (const active of deps.listActive()) {
    const rest = await deps.resolveBinance(active.operatorId, active.accountId).catch(() => null);
    if (!rest) continue;
    let scope;
    try {
      scope = await profileRepo(deps.db, active.operatorId, active.accountId, active.profileId);
    } catch (err) {
      deps.logger.warn(
        { err, operatorId: active.operatorId, profileId: active.profileId },
        'reapStaleOrders: profileRepo failed; skipping profile',
      );
      failed += 1;
      continue;
    }
    for (const symbol of active.symbols) {
      checked += 1;
      try {
        const liveLocal = await scope.orders.listLiveForSymbol(symbol);
        if (liveLocal.length === 0) continue;
        const exchangeOpen = await rest.getOpenOrders(symbol);
        const reapIds = selectReapTargets(liveLocal, exchangeOpen);
        for (const id of reapIds) {
          const outcome = await reconcileMissingOrder(deps, scope, rest, {
            operatorId: active.operatorId,
            accountId: active.accountId,
            profileId: active.profileId,
            symbol,
            binanceOrderId: id,
          });
          if (outcome === 'reclaimed') reclaimed += 1;
          else if (outcome === 'reaped') reaped += 1;
        }
      } catch (err) {
        failed += 1;
        deps.logger.warn(
          {
            err,
            operatorId: active.operatorId,
            profileId: active.profileId,
            symbol,
          },
          'reapStaleOrders: per-symbol reap failed; will retry on next boot',
        );
      }
    }
  }
  return { checked, reaped, reclaimed, failed };
};
