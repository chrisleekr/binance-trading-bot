// The retry contract's unstated premise: a tick emits AT MOST ONE place-order.
//
// The retry is the UN-ADVANCED STATE — the next tick recomputes and re-emits the
// whole decision array. If a tick emitted two placements and only the second one
// failed, that re-emit would place the FIRST one a second time, a real-money
// double order. Every strategy today (trailing-trade, momentum, rebalance) emits
// at most one, and `applyAll` fails CLOSED — it throws `MultiPlacementError`
// before applying anything rather than transmitting either order. This file
// pins the error TYPE and its fields; the money-safety assertion (nothing
// transmitted) lives in live-executor-apply-all.test.ts.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { Decision, DecisionResult, ExecutorContext } from '@app/strategy-core';
import type { NotifyProviderRegistry } from '@app/notify';
import type { StrategyRegistry } from '@app/strategy-registry';

const { placeOrderSpy } = vi.hoisted(() => ({ placeOrderSpy: vi.fn() }));

vi.mock('../../src/executor/decisions/place-order.js', () => ({
  placeOrderHandler: placeOrderSpy,
}));

import { createLiveExecutor, MultiPlacementError } from '../../src/executor/live-executor.js';

const CTX: ExecutorContext = {
  userId: 'u-1',
  profileId: 'p-1',
  clock: { nowMs: () => 0 },
  strategyName: 'trailing-trade',
};

const place = (clientOrderId: string): Decision => ({
  type: 'place-order',
  intent: { symbol: 'BTCUSDT', side: 'BUY', reason: 'entry', clientOrderId },
  params: { type: 'MARKET', quantity: '1' },
});

const mkLogger = () =>
  ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) as unknown as Logger;

const buildExecutor = () =>
  createLiveExecutor({
    redis: {} as unknown as Redis,
    notifyRegistry: {} as unknown as NotifyProviderRegistry,
    strategies: {} as unknown as StrategyRegistry,
    logger: mkLogger(),
    resolveProfile: vi.fn(async () => ({}) as never),
    notifierGapThrottle: { allow: async () => true },
  });

beforeEach(() => {
  vi.clearAllMocks();
  placeOrderSpy.mockResolvedValue({ ok: true } satisfies DecisionResult);
});

describe('LiveExecutor.applyAll — one placement per tick', () => {
  it('throws MultiPlacementError carrying the profile and placement count', async () => {
    const err = await buildExecutor()
      .applyAll(CTX, 'a-1', [place('coid-1'), place('coid-2')])
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(MultiPlacementError);
    expect(err).toMatchObject({ profileId: 'p-1', placements: 2 });
    // Fail-closed before the loop: neither placement reached its handler.
    expect(placeOrderSpy).not.toHaveBeenCalled();
  });

  it('applies the single-placement tick every strategy actually emits', async () => {
    const applied = await buildExecutor().applyAll(CTX, 'a-1', [place('coid-1')]);
    expect(applied).toHaveLength(1);
    expect(placeOrderSpy).toHaveBeenCalledTimes(1);
  });
});
