// stale-order-reap cron.
//
// Closes local `orders` rows whose order has left Binance's book — cancelled by
// the operator on the exchange, expired, or filled during a stream gap.
//
// Runs PERIODICALLY, not only at boot, because a long-lived worker does not
// restart and reconciliation that only happens on restart is not reconciliation.
// An unreaped row stays `status='NEW'`, `closed_at IS NULL`: shown as an open
// order in the UI, counted toward the account's open exposure (which gates
// account deletion), and treated as tracked-live by the orphan detector, which is
// what keeps it from ever being surfaced. The boot pass remains, so a restart
// still converges immediately.
//
// Kept SEPARATE from `held-quantity-reconcile` rather than folded into one
// "converge to exchange truth" cron: they converge different things against
// different Binance endpoints, and a reaper fault (a getOrder 5xx storm) must not
// delay the position convergence, which is the money-critical half.
//
// `selfReschedulePeriodMs`, not `pattern`: the sweep fans out a `getOrder` per
// live row across every profile, so a slow run must delay the next, never overlap
// it.

import type { Job } from 'bullmq';
import type { BootContext } from 'boot/boot-context.js';
import { runStaleOrderReaper } from 'boot/reap-stale-orders.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import { defineCron, type CronDef } from './define.js';

export const buildStaleOrderReapCron = (ctx: BootContext): CronDef =>
  defineCron({
    name: 'stale-order-reap',
    queue: QUEUE_NAMES.staleOrderReap,
    // 15 minutes, matching the held-quantity backstop. A stale row is not
    // time-critical (nothing trades against it) but it lies to the operator, and
    // the sweep is cheap when there is nothing to reap.
    selfReschedulePeriodMs: 900_000,
    handler: async (_job: Job): Promise<void> => {
      const tally = await runStaleOrderReaper({
        db: ctx.db,
        logger: ctx.logger,
        listActive: ctx.listActive,
        resolveBinance: ctx.resolveBinanceClient,
      });
      ctx.logger.info({ tally }, 'cron stale-order-reap: complete');
    },
  });
