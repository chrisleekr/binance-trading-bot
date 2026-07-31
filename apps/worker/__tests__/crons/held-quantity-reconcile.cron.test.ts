import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { pino } from 'pino';

import { buildHeldQuantityReconcileCron } from '../../src/crons/held-quantity-reconcile.cron.js';
import type { BootContext } from '../../src/boot/boot-context.js';
import type { ReconcileOrchestratorDeps } from '../../src/boot/reconcile-held-quantity.js';

const runReconcile = vi.hoisted(() =>
  vi.fn(async () => ({ heldQuantity: {}, avgEntryPriceRevival: {} })),
);
vi.mock('../../src/boot/reconcile-held-quantity.js', () => ({
  runHeldQuantityReconciliation: runReconcile,
}));

const RECONCILE_DEPS = { marker: 'the-shared-bag' } as unknown as ReconcileOrchestratorDeps;

const enqueueSymbolReconcile = vi.fn(async () => undefined);

const ctx = (): BootContext =>
  ({
    logger: pino({ level: 'silent' }),
    reconcileDeps: RECONCILE_DEPS,
    enqueueSymbolReconcile,
  }) as unknown as BootContext;

describe('held-quantity-reconcile cron', () => {
  it('runs the fleet-wide reconcile through the SHARED dep bag', async () => {
    // The boot pass, this cron, and the symbol-reconcile job must converge through
    // one code path: they share the `chainByKey` that serialises their writes
    // against a live tick. A cron that built its own deps would take a DIFFERENT
    // chain instance and the lock would silently stop meaning anything.
    runReconcile.mockClear();
    const def = buildHeldQuantityReconcileCron(ctx());

    await def.handler({} as Job);

    expect(runReconcile).toHaveBeenCalledWith(RECONCILE_DEPS);
    // UNTHROTTLED and queue-free: the cron converges directly. It is rate-limited
    // by its own 15-minute cadence, and it is the backstop the failure-driven
    // enqueue's 60s suppression window relies on — putting it behind that window
    // would make the safety net depend on the thing it is backing up.
    expect(enqueueSymbolReconcile).not.toHaveBeenCalled();
  });

  it('self-reschedules rather than running on a fixed pattern', async () => {
    // A fixed-cadence scheduler mints the next iteration whether or not the last
    // one finished. This pass fans out a getAccount per profile and trade-history
    // reads per symbol, so two overlapping runs would contend on the same chain
    // keys and re-derive the same answer on the account's Binance weight budget.
    const def = buildHeldQuantityReconcileCron(ctx());

    expect(def.selfReschedulePeriodMs).toBe(900_000);
    expect(def.pattern).toBeUndefined();
    expect(def.queue).toBe('held-quantity-reconcile');
  });
});
