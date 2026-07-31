// held-quantity-reconcile cron.
//
// Periodic backstop for position drift: pins every active (profile, symbol)'s
// `state.heldQuantity` / `avgEntryPrice` to what the wallet and the trade history
// actually say.
//
// The same pass also runs once at boot, but boot alone is not enough: a healthy
// worker does not restart, so a fill the user stream never delivered would leave
// the state claiming a position the operator has already sold with nothing ever
// noticing. The targeted `symbol-reconcile` job repairs the drift the bot can
// DETECT; this cron repairs the drift it cannot, which bounds the worst case to
// one window rather than forever.
//
// `selfReschedulePeriodMs`, not `pattern`: the pass fans out a `getAccount` per
// profile and trade-history reads per symbol, so a slow run must delay the next
// one, never overlap it (two reconciles racing the same symbol would contend on
// the shared chain key and burn Binance weight re-deriving the same answer).

import type { Job } from 'bullmq';
import type { BootContext } from 'boot/boot-context.js';
import { runHeldQuantityReconciliation } from 'boot/reconcile-held-quantity.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import { defineCron, type CronDef } from './define.js';

export const buildHeldQuantityReconcileCron = (ctx: BootContext): CronDef =>
  defineCron({
    name: 'held-quantity-reconcile',
    queue: QUEUE_NAMES.heldQuantityReconcile,
    // 15 minutes. It is a safety net, not a control loop — the stream and the
    // targeted reconcile job are the fast paths — and the fan-out is not free.
    selfReschedulePeriodMs: 900_000,
    handler: async (_job: Job): Promise<void> => {
      const tally = await runHeldQuantityReconciliation(ctx.reconcileDeps);
      ctx.logger.info({ tally }, 'cron held-quantity-reconcile: complete');
    },
  });
