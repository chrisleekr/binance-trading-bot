import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { pino } from 'pino';

import type { AccountId, ProfileId, UserId } from '@app/contracts';

import { symbolReconcileHandler } from '../../src/queues/symbol-reconcile-worker.js';
import type { ReconcileOrchestratorDeps } from '../../src/boot/reconcile-held-quantity.js';
import type { ActiveProfile } from '../../src/profile-manager/profile-manager.js';

const USER = 'u1' as unknown as UserId;
const ACCOUNT = 'a1' as unknown as AccountId;
const PROFILE = 'p1' as unknown as ProfileId;

const ACTIVE = {
  userId: USER,
  operatorId: USER,
  accountId: ACCOUNT,
  profileId: PROFILE,
  symbols: ['ALLOUSDT'],
} as unknown as ActiveProfile;

const job = (data: unknown): Job => ({ id: 'j1', data }) as unknown as Job;

const PAYLOAD = {
  accountId: 'a1',
  profileId: 'p1',
  symbol: 'ALLOUSDT',
  cause: 'cancel-2011-fill',
};

// The orchestrator is exercised in its own suite; here it is a spy so the
// worker's contract (what it calls, in what order, with what narrowing) is
// what is under test.
const runReconcile = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('../../src/boot/reconcile-held-quantity.js', () => ({
  runHeldQuantityReconciliation: runReconcile,
}));

const build = (over: { listActive?: () => readonly ActiveProfile[] } = {}) => {
  const backfill = vi.fn(async () => undefined);
  const reconcileDeps = { marker: 'the-shared-bag' } as unknown as ReconcileOrchestratorDeps;
  const handler = symbolReconcileHandler({
    logger: pino({ level: 'silent' }),
    listActive: over.listActive ?? (() => [ACTIVE]),
    fillBackfiller: { backfill },
    reconcileDeps,
  });
  return { handler, backfill, reconcileDeps };
};

describe('symbolReconcileHandler', () => {
  it('backfills the trade history FIRST, then reconciles the wallet for that one symbol', async () => {
    // Order matters. The backfill is the cost-basis-correct adoption (it carries a
    // real tradeId, so the adopter's applied_fills gate dedups it against the live
    // stream); the wallet reconcile is the backstop that pins heldQuantity to truth
    // whatever the trade history says. Backfill-then-reconcile means a fill with a
    // baseline is adopted properly, and one without a baseline is still cleared.
    runReconcile.mockClear();
    const { handler, backfill, reconcileDeps } = build();
    const order: string[] = [];
    backfill.mockImplementation(async () => {
      order.push('backfill');
    });
    runReconcile.mockImplementation(async () => {
      order.push('reconcile');
      return {};
    });

    await handler(job(PAYLOAD));

    expect(order).toEqual(['backfill', 'reconcile']);
    expect(backfill).toHaveBeenCalledWith(USER, ACCOUNT, PROFILE, 'ALLOUSDT');
    expect(runReconcile).toHaveBeenCalledWith(reconcileDeps, {
      only: { profileId: PROFILE, symbols: ['ALLOUSDT'] },
    });
  });

  it('a retried job simply re-runs both legs — it keeps no memory of what it did', async () => {
    // Scope note: this proves the WORKER's half only. Idempotence itself is the
    // STORE's job (the adopter dedups on applied_fills; the reconcile is a
    // fixpoint), and it is proven in fill-adopter.test.ts ("mutates exactly once
    // when the same fill is delivered twice") — `fillBackfiller` is a spy here, so
    // no dedupe is observable from this suite. What is under test is that the
    // worker does NOT try to remember and skip: BullMQ retries, and the -2011 probe
    // and the -2010 SELL rejection it causes can both enqueue for the same symbol,
    // so re-running both converge-to-truth legs is the correct behaviour.
    runReconcile.mockClear();
    runReconcile.mockImplementation(async () => ({}));
    const { handler, backfill } = build();
    backfill.mockImplementation(async () => undefined);

    await handler(job(PAYLOAD));
    await handler(job(PAYLOAD));

    expect(backfill).toHaveBeenCalledTimes(2);
    expect(backfill).toHaveBeenNthCalledWith(2, USER, ACCOUNT, PROFILE, 'ALLOUSDT');
    expect(runReconcile).toHaveBeenCalledTimes(2);
  });

  it('a profile that is no longer active is a no-op', async () => {
    // The payload deliberately carries no operatorId: resolving it from the active
    // set IS the liveness gate. A profile disabled or deleted between enqueue and
    // run has no position to converge.
    runReconcile.mockClear();
    const { handler, backfill } = build({ listActive: () => [] });

    await handler(job(PAYLOAD));

    expect(backfill).not.toHaveBeenCalled();
    expect(runReconcile).not.toHaveBeenCalled();
  });

  it('takes accountId from the ACTIVE SET, and loudly drops a payload that disagrees', async () => {
    // accountId is the identifier the isolation boundary is DEFINED by. The active
    // set loaded it through the scope layer; the payload is just data that rode a
    // queue. Trusting the payload would make the boundary depend on the message
    // rather than on the proof — and a disagreement is either a live race or a bug,
    // so it is dropped at ERROR rather than silently.
    runReconcile.mockClear();
    const logger = pino({ level: 'silent' });
    const error = vi.spyOn(logger, 'error');
    const backfill = vi.fn(async () => undefined);
    const handler = symbolReconcileHandler({
      logger,
      listActive: () => [ACTIVE],
      fillBackfiller: { backfill },
      reconcileDeps: {} as unknown as ReconcileOrchestratorDeps,
    });

    await handler(job({ ...PAYLOAD, accountId: 'a2-not-the-owner' }));

    expect(backfill).not.toHaveBeenCalled();
    expect(runReconcile).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it('a malformed payload is dropped, not retried forever', async () => {
    runReconcile.mockClear();
    const { handler, backfill } = build();

    await handler(job({ profileId: 'p1', symbol: 'ALLOUSDT', cause: 'not-a-cause' }));

    expect(backfill).not.toHaveBeenCalled();
    expect(runReconcile).not.toHaveBeenCalled();
  });

  it('a failed backfill still runs the wallet reconcile', async () => {
    // The two legs answer different questions. Losing the cost-basis-correct
    // adoption must not also lose the backstop that clears a position the wallet
    // no longer holds — that is the drift the operator actually sees.
    runReconcile.mockClear();
    runReconcile.mockImplementation(async () => ({}));
    const { handler, backfill } = build();
    backfill.mockImplementation(async () => {
      throw new Error('getMyTrades 500');
    });

    await expect(handler(job(PAYLOAD))).resolves.toBeUndefined();

    expect(runReconcile).toHaveBeenCalledOnce();
  });

  it('a failed wallet reconcile THROWS so BullMQ retries it', async () => {
    // Unlike the backfill (whose no-op is a legitimate outcome), a failed reconcile
    // means the position is still mis-stated. Swallowing it would leave the drift
    // to the 15-minute backstop cron.
    runReconcile.mockClear();
    runReconcile.mockImplementation(async () => {
      throw new Error('postgres down');
    });
    const { handler, backfill } = build();
    backfill.mockImplementation(async () => undefined);

    await expect(handler(job(PAYLOAD))).rejects.toThrow('postgres down');
  });
});
