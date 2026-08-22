// A decision chain from one tick is ordered on purpose: a cancel that clears the
// old resting order comes before the place that replaces it. So the chain's
// failure semantics are what keep the exchange and our `orders` table agreeing.
//
// Two properties are pinned here:
//  1. A failed cancel must stop the chain. If the cancel failed the old order is
//     still resting on Binance; letting the place run mints a second live order
//     while the local row for the first gets stamped CANCELED. Orphan.
//  2. Whatever stops the chain, the decisions behind it must still be REPORTED.
//     The audit payload and override attribution both read the `applied` array;
//     a dropped tail reads as "the strategy never emitted that order".
//
// The handlers are stubbed at their module boundary so the real `applyAll`
// sequencing (the thing under test) runs unmodified.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { Decision, DecisionResult, TickExecutorContext } from '@app/strategy-core';
import type { NotifyProviderRegistry } from '@app/notify';
import type { StrategyRegistry } from '@app/strategy-registry';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';

const { placeOrderSpy, cancelOrderSpy, setKvSpy, emitEventSpy } = vi.hoisted(() => ({
  placeOrderSpy: vi.fn(),
  cancelOrderSpy: vi.fn(),
  setKvSpy: vi.fn(),
  emitEventSpy: vi.fn(),
}));

vi.mock('../../src/executor/decisions/place-order.js', () => ({
  placeOrderHandler: placeOrderSpy,
}));
vi.mock('../../src/executor/decisions/cancel-order.js', () => ({
  cancelOrderHandler: cancelOrderSpy,
}));
vi.mock('../../src/executor/decisions/set-kv.js', () => ({
  setKvHandler: setKvSpy,
}));
vi.mock('../../src/executor/decisions/emit-event.js', () => ({
  emitEventHandler: emitEventSpy,
}));

import { createLiveExecutor } from '../../src/executor/live-executor.js';

const USER = asUserId('u-1');
const ACCOUNT = asAccountId('a-1');
const PROFILE = asProfileId('p-1');

// applyAll is the tick path, so its ctx is the strategyName-required narrowing.
const CTX: TickExecutorContext = {
  userId: USER,
  profileId: PROFILE,
  clock: { nowMs: () => 0 },
  strategyName: 'trailing-trade',
};

const CANCEL: Decision = { type: 'cancel-order', orderId: 42, reason: 'replace-stop' };
const EMIT: Decision = {
  type: 'emit-event',
  eventType: 'symbol-state',
  payload: { any: 'shape' },
};
const PLACE: Decision = {
  type: 'place-order',
  intent: { symbol: 'BTCUSDT', side: 'SELL', reason: 'stop-loss', clientOrderId: 'coid-1' },
  params: { type: 'STOP_LOSS_LIMIT', price: '100', stopPrice: '101', quantity: '1' },
};
const PLACE_2: Decision = {
  type: 'place-order',
  intent: { symbol: 'BTCUSDT', side: 'BUY', reason: 'grid-buy', clientOrderId: 'coid-2' },
  params: { type: 'LIMIT', price: '99', quantity: '1' },
};
const SET_KV: Decision = { type: 'set-kv', key: 'tt:regime', value: 1 };

const buildExecutor = () =>
  createLiveExecutor({
    redis: {} as unknown as Redis,
    notifyRegistry: {} as unknown as NotifyProviderRegistry,
    strategies: {} as unknown as StrategyRegistry,
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger,
    resolveProfile: vi.fn(async () => ({}) as never),
    notifierGapThrottle: { allow: async () => true, release: async () => undefined },
  });

const OK: DecisionResult = { ok: true };

beforeEach(() => {
  vi.clearAllMocks();
  placeOrderSpy.mockResolvedValue(OK);
  cancelOrderSpy.mockResolvedValue(OK);
  setKvSpy.mockResolvedValue(OK);
  emitEventSpy.mockResolvedValue(OK);
});

describe('LiveExecutor.applyAll — emit-event routing', () => {
  it('routes an emit-event decision to the emit-event handler', async () => {
    // The tick-only applyAll path (TickExecutorContext) is the sole route that
    // dispatches emit-event: the base `apply` path excludes it by type. This
    // pins that wiring so a future dispatch refactor cannot silently drop it.
    const applied = await buildExecutor().applyAll(CTX, ACCOUNT, [EMIT]);

    expect(emitEventSpy).toHaveBeenCalledTimes(1);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.result).toEqual(OK);
    expect(applied[0]?.decision).toEqual(EMIT);
  });
});

describe('LiveExecutor.applyAll — chain short-circuit', () => {
  it('a failed cancel short-circuits the chain', async () => {
    // The exchange refused the cancel: order 42 is still resting and still armed.
    cancelOrderSpy.mockResolvedValue({
      ok: false,
      retryable: false,
      phase: 'rejected',
      reason: 'cancel rejected',
    } satisfies DecisionResult);

    const applied = await buildExecutor().applyAll(CTX, ACCOUNT, [CANCEL, PLACE, SET_KV]);

    // The money assertion: a place must never follow a cancel that did not land.
    expect(placeOrderSpy).not.toHaveBeenCalled();
    expect(applied[0]?.result).toMatchObject({ ok: false, phase: 'rejected' });
  });

  it('pushes a skipped result for every decision after the break', async () => {
    placeOrderSpy.mockResolvedValue({
      ok: false,
      retryable: false,
      phase: 'rejected',
      reason: 'LOT_SIZE',
    } satisfies DecisionResult);

    const applied = await buildExecutor().applyAll(CTX, ACCOUNT, [PLACE, CANCEL, SET_KV]);

    // Every emitted decision is accounted for, so the audit trail and override
    // attribution can tell "not attempted" apart from "never emitted".
    expect(applied).toHaveLength(3);
    expect(applied[1]?.decision).toEqual(CANCEL);
    expect(applied[2]?.decision).toEqual(SET_KV);

    for (const idx of [1, 2]) {
      const result = applied[idx]?.result;
      // `pre-call` + RETRYABLE. Nothing was transmitted, so re-issuing a skipped
      // decision is provably safe — and that pair is exactly what the retry
      // predicate reads. Stamping it non-retryable would silently EAT an operator
      // override whose SELL sat behind a transiently-failed cancel.
      expect(result).toMatchObject({ ok: false, retryable: true, phase: 'pre-call' });
      expect(result?.ok === false && result.reason).toMatch(/skipped/i);
    }

    // Skipped means skipped: the handlers behind the break never ran.
    expect(cancelOrderSpy).not.toHaveBeenCalled();
    expect(setKvSpy).not.toHaveBeenCalled();
  });
});

describe('LiveExecutor.applyAll — repeated-refusal circuit', () => {
  it('executes only the non-order prefix and defers the whole suffix from the first order', async () => {
    const applied = await buildExecutor().applyAll(
      CTX,
      ACCOUNT,
      [EMIT, CANCEL, PLACE, SET_KV],
      undefined,
      undefined,
      { deferRepeatedRefusal: true },
    );

    expect(emitEventSpy).toHaveBeenCalledOnce();
    expect(cancelOrderSpy).not.toHaveBeenCalled();
    expect(placeOrderSpy).not.toHaveBeenCalled();
    expect(setKvSpy).not.toHaveBeenCalled();
    expect(applied[0]?.result).toEqual(OK);
    for (const item of applied.slice(1)) {
      expect(item.result).toMatchObject({
        ok: false,
        retryable: true,
        phase: 'pre-call',
        deferred: true,
      });
      expect(item.result.ok === false && item.result.reason).toMatch(/once per minute/i);
    }
  });

  it('keeps the multi-placement contract fail-closed before circuit deferral', async () => {
    await expect(
      buildExecutor().applyAll(CTX, ACCOUNT, [PLACE, PLACE_2], undefined, undefined, {
        deferRepeatedRefusal: true,
      }),
    ).rejects.toThrow(/more than one|multi.?placement|place-order/i);

    expect(placeOrderSpy).not.toHaveBeenCalled();
  });
});

describe('LiveExecutor.applyAll — multi-placement fail-closed', () => {
  // The retry model re-emits the WHOLE decision array on a failed apply (the tick
  // leaves per-(profile,symbol) state un-advanced). If a tick emits two placements
  // and only the second fails, the re-emit re-transmits the FIRST — a real-money
  // double order. applyAll must reject BEFORE transmitting anything, not log and
  // fall through.
  it('rejects a two-placement tick before transmitting either order', async () => {
    const decisions: Decision[] = [PLACE, PLACE_2];

    await expect(buildExecutor().applyAll(CTX, ACCOUNT, decisions)).rejects.toThrow(
      /more than one|multi.?placement|place-order/i,
    );

    // The money assertion: nothing must reach the exchange when the contract is
    // violated. Falling through would place at least the first order.
    expect(placeOrderSpy).not.toHaveBeenCalled();
  });

  it('applies a single place-order interleaved with a cancel and set-kv', async () => {
    // Exactly one placement is the legal shape every strategy emits — it must
    // pass straight through, not trip the guard.
    const applied = await buildExecutor().applyAll(CTX, ACCOUNT, [CANCEL, PLACE, SET_KV]);

    expect(applied).toHaveLength(3);
    expect(placeOrderSpy).toHaveBeenCalledTimes(1);
    expect(cancelOrderSpy).toHaveBeenCalledTimes(1);
    expect(setKvSpy).toHaveBeenCalledTimes(1);
    expect(applied.every((a) => a.result.ok === true)).toBe(true);
  });
});
