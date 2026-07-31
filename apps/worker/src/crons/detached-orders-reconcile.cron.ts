// detached-orders-reconcile cron.
//
// Closes DETACHED order rows — `profile_id NULL`, i.e. their profile was
// deleted — once the exchange says the order has left the book.
//
// `orders.profile_id` is ON DELETE SET NULL: deleting a profile detaches its
// orders instead of cascade-deleting them, because a resting order is real money
// on Binance and must not vanish from the ledger just because the strategy that
// placed it is gone. But nothing then closes the row when the order finally
// fills or is cancelled: it stays `closed_at NULL` forever, counting toward
// `countAccountOpenExposure` (which backs the delete-account guard, so the
// account can never be deleted) and sitting in the tracked-live set (which is
// what stops the orphan detector from surfacing it). An immortal, invisible row.
//
// The live driver is the user-data stream: the event-router routes a detached
// order's terminal executionReport to `fillAdopter.reconcileDetachedFill`. That
// covers every account with at least one active profile — but NOT the case that
// creates detached orders in the first place. Deleting an account's LAST profile
// detaches its orders AND tears down the only stream the account had, so no
// report will ever arrive again, and every other sweep (the boot reaper, the
// orphan cron) enumerates the ACTIVE PROFILE set and is structurally blind to an
// account that has none.
//
// So this cron is driven off the ORDERS TABLE, not off active profiles: the
// account's key pair is enough to ask Binance for the order's true status. It is
// the reason a zero-profile account can still settle its ledger and be deleted.
//
// Ledger-only, exactly like the seam it drives: no cost basis, no strategy state,
// no re-subscription. There is no profile left to adopt into.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { AccountId, UserId } from '@app/contracts';
import { BinanceApiError, type BinanceRestClient } from '@app/binance';
import { repo } from '@app/db';
import type { BootContext } from 'boot/boot-context.js';
import type { DetachedOrderEvent } from 'executor/fill-adopter.js';
import { defineCron, type CronDef } from './define.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';

/** Binance `getOrder` code for an order id that never existed on the account. */
const ORDER_NOT_EXIST = -2013;

/** One still-open detached row, carrying the account + operator to scope against. */
export interface DetachedOrderRow {
  readonly binanceOrderId: bigint;
  readonly accountId: AccountId;
  readonly operatorId: UserId;
  readonly symbol: string;
}

export interface DetachedOrdersReconcileDeps {
  readonly logger: Logger;
  readonly listLiveDetached: () => Promise<readonly DetachedOrderRow[]>;
  readonly resolveBinance: (
    operatorId: UserId,
    accountId: AccountId,
  ) => Promise<{ getOrder: BinanceRestClient['getOrder'] } | null>;
  /**
   * The ledger-only close. Idempotent and account-scoped, and it self-gates on a
   * terminal status — a row still resting on the exchange passes straight through
   * untouched, so this cron never has to duplicate that judgement.
   */
  readonly reconcileDetachedFill: (event: DetachedOrderEvent) => Promise<void>;
  readonly nowMs: () => number;
}

export const detachedOrdersReconcileHandler =
  (deps: DetachedOrdersReconcileDeps) =>
  async (_job: Job): Promise<void> => {
    const rows = await deps.listLiveDetached();
    if (rows.length === 0) {
      // The overwhelmingly common case: no profile has been deleted while holding
      // open orders. Short-circuit BEFORE any Binance call so the steady-state
      // cost of this cron is one indexed query.
      deps.logger.debug('cron detached-orders-reconcile: no detached live orders; skipped');
      return;
    }

    // One client per account: a detached row's account still holds its own key
    // pair (accounts outlive their profiles), which is the whole reason this is
    // reachable without a profile. `null` marks an account whose credentials are
    // gone, so its rows are skipped without re-resolving once per row.
    const clients = new Map<AccountId, { getOrder: BinanceRestClient['getOrder'] } | null>();

    let reconciled = 0;
    for (const row of rows) {
      const base = {
        operatorId: row.operatorId,
        accountId: row.accountId,
        symbol: row.symbol,
        binanceOrderId: row.binanceOrderId.toString(),
      };
      if (!clients.has(row.accountId)) {
        clients.set(
          row.accountId,
          await deps.resolveBinance(row.operatorId, row.accountId).catch(() => null),
        );
      }
      const rest = clients.get(row.accountId) ?? null;
      if (!rest) {
        deps.logger.warn(
          base,
          'cron detached-orders-reconcile: no Binance credentials on the order’s account; cannot settle the row',
        );
        continue;
      }

      let order;
      try {
        order = await rest.getOrder({
          symbol: row.symbol,
          orderId: Number(row.binanceOrderId),
        });
      } catch (err) {
        if (err instanceof BinanceApiError && err.code === ORDER_NOT_EXIST) {
          // The exchange has never heard of this id (a dev-seeded or hand-poked
          // row). It is not real money and never will be, so close it as CANCELED
          // — otherwise it holds its account hostage forever.
          await deps.reconcileDetachedFill({
            ...row,
            orderId: Number(row.binanceOrderId),
            orderStatus: 'CANCELED',
            cumQty: '0',
            cumQuoteQty: '0',
            eventTimeMs: deps.nowMs(),
          });
          reconciled += 1;
          deps.logger.warn(
            base,
            'cron detached-orders-reconcile: detached order unknown to the exchange; closed as CANCELED',
          );
          continue;
        }
        // Transient (network / rate limit / 5xx). Leave the row live and retry next
        // tick rather than guess a terminal status for an order that may be resting.
        deps.logger.warn(
          { ...base, err: err },
          'cron detached-orders-reconcile: order-status query failed; leaving the row live for the next tick',
        );
        continue;
      }

      // A still-resting order (NEW / PARTIALLY_FILLED) passes through untouched:
      // `reconcileDetachedFill` closes only on a terminal status. That row is a
      // real open commitment and SHOULD keep counting toward the account's
      // exposure — the guard it blocks is telling the operator the truth.
      await deps.reconcileDetachedFill({
        ...row,
        orderId: Number(row.binanceOrderId),
        orderStatus: order.status,
        cumQty: order.executedQty,
        cumQuoteQty: order.cummulativeQuoteQty,
        eventTimeMs: order.updateTime,
      });
      reconciled += 1;
    }

    deps.logger.info(
      { detached: rows.length, reconciled },
      'cron detached-orders-reconcile: complete',
    );
  };

export const buildDetachedOrdersReconcileCron = (ctx: BootContext): CronDef =>
  defineCron({
    name: 'detached-orders-reconcile',
    queue: QUEUE_NAMES.detachedOrdersReconcile,
    // Every 10 minutes, offset from `orphan-orders-detect` so the two order-
    // reconciliation sweeps do not contend for the same account's Binance weight
    // in the same second. A detached order is not time-critical: nothing trades
    // against it, it only has to settle before the operator retries the delete.
    pattern: '30 */10 * * * *',
    handler: detachedOrdersReconcileHandler({
      logger: ctx.logger,
      listLiveDetached: () => repo.orders.listLiveDetached(ctx.db),
      resolveBinance: async (operatorId, accountId) => {
        const resolved = await ctx.resolveBinanceWithMode(operatorId, accountId);
        return resolved ? resolved.rest : null;
      },
      reconcileDetachedFill: (event) => ctx.fillAdopter.reconcileDetachedFill(event),
      nowMs: () => Date.now(),
    }),
  });
