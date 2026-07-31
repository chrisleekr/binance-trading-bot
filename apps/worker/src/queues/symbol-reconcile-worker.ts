// `symbol-reconcile` queue consumer: converge one (profile, symbol)'s position
// onto exchange truth.
//
// This queue exists because of a lock, not because of a workload. The code that
// DISCOVERS a missed fill — a cancel whose -2011 probe comes back FILLED, a SELL
// Binance rejects for want of balance — runs inside the tick's
// `chainByKey(`${profileId}:${symbol}`)` critical section, and the fill-adopter
// takes that exact key. Adopting inline would self-await and hang the tick
// forever, so the discovery is deferred here and adopted outside the lock.
//
// Two legs, in order, each independently guarded so one failing does not mask
// the other:
//
//   1. backfill — the cost-basis-correct adoption. `getMyTrades` is the only
//      Binance surface carrying a trade id, which the adopter requires for its
//      `applied_fills` idempotency key, so the fill is folded through the same
//      path a live `executionReport` takes. Re-running it applies nothing twice.
//      It no-ops when the symbol has no adopted-fill baseline at all.
//   2. reconcile — the backstop. It pins `heldQuantity` to the wallet whatever
//      the trade history says, which is what clears the state that started this:
//      a position the state still claims and the wallet no longer holds.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { asAccountId, asProfileId } from '@app/contracts';

import {
  runHeldQuantityReconciliation,
  type ReconcileOrchestratorDeps,
} from 'boot/reconcile-held-quantity.js';
import type { FillBackfiller } from 'executor/fill-backfiller.js';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';
import type { QueueSet } from 'queues/queue-set.js';
import { parseSymbolReconcileJob } from 'queues/job-payloads.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';

export interface SymbolReconcileWorkerDeps {
  readonly logger: Logger;
  /**
   * The active-profile set. It resolves the operator the job payload
   * deliberately omits, and doubles as the liveness gate: a profile that has
   * since been disabled or deleted has no position to converge, so the job
   * completes as a no-op rather than reconciling a profile nobody is trading.
   */
  readonly listActive: () => readonly ActiveProfile[];
  readonly fillBackfiller: FillBackfiller;
  /**
   * The same orchestrator deps the boot pass and the backstop cron hold, so all
   * three converge through one code path. It already serialises every write on
   * the shared `chainByKey`, which is what makes running it from a queue job
   * safe against a concurrent tick on the same (profile, symbol).
   */
  readonly reconcileDeps: ReconcileOrchestratorDeps;
}

export const symbolReconcileHandler =
  (deps: SymbolReconcileWorkerDeps) =>
  async (job: Job): Promise<void> => {
    const data = parseSymbolReconcileJob(job.data);
    if (!data) {
      deps.logger.warn({ jobId: job.id }, 'symbol-reconcile: invalid payload; dropping');
      return;
    }
    const profileId = asProfileId(data.profileId);
    const active = deps.listActive().find((p) => p.profileId === profileId);
    if (!active) {
      deps.logger.info(
        { profileId, symbol: data.symbol, cause: data.cause },
        'symbol-reconcile: profile is no longer active; nothing to converge',
      );
      return;
    }

    // The account id comes from the active set, never from the payload: it is the
    // identifier the isolation boundary is DEFINED by, and the active set loaded
    // it through the scope layer. The payload copy is only ever cross-checked.
    const accountId = active.accountId;
    if (asAccountId(data.accountId) !== accountId) {
      deps.logger.error(
        {
          profileId,
          symbol: data.symbol,
          cause: data.cause,
          payloadAccountId: data.accountId,
          activeAccountId: accountId,
        },
        'symbol-reconcile: payload account does not own this profile; dropping',
      );
      return;
    }

    const base = {
      profileId,
      accountId,
      symbol: data.symbol,
      cause: data.cause,
    };
    deps.logger.info(base, 'symbol-reconcile: converging position onto exchange truth');

    try {
      await deps.fillBackfiller.backfill(active.operatorId, accountId, profileId, data.symbol);
    } catch (err) {
      deps.logger.error(
        { ...base, err: err },
        'symbol-reconcile: trade-history backfill failed; falling through to the wallet reconcile',
      );
    }

    try {
      const tally = await runHeldQuantityReconciliation(deps.reconcileDeps, {
        only: { profileId, symbols: [data.symbol] },
      });
      deps.logger.info({ ...base, tally }, 'symbol-reconcile: complete');
    } catch (err) {
      // Rethrow: unlike the backfill (whose no-op is a legitimate outcome), a
      // failed wallet reconcile means the position is STILL mis-stated. Let
      // BullMQ retry it.
      deps.logger.error({ ...base, err: err }, 'symbol-reconcile: wallet reconcile failed');
      throw err;
    }
  };

export const registerSymbolReconcileWorker = (
  queueSet: QueueSet,
  deps: SymbolReconcileWorkerDeps,
): void => {
  queueSet.registerWorker(QUEUE_NAMES.symbolReconcile, symbolReconcileHandler(deps));
};
