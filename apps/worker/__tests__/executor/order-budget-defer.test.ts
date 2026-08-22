// Block-vs-shed at the executor. Binance meters order placement against a
// per-account ORDERS budget; when it is exhausted, the two order classes want
// opposite behaviour. An EXIT must block and go out late — the REST client's
// `reserve` does that, and this layer must not interfere. A protective-stop
// RE-PRICE must be shed instead: the stop it replaces is still resting, so
// waiting here would only hold this (profile, symbol)'s chain lock and delay the
// next tick's exit check.
//
// The split is driven by `intent.deferrable`, a generic capability flag, never by
// the strategy's `reason` vocabulary — the executor must stay strategy-agnostic.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { Decision, DecisionResult, TickExecutorContext } from '@app/strategy-core';
import type { NotifyProviderRegistry } from '@app/notify';
import type { StrategyRegistry } from '@app/strategy-registry';
import type { OrderRateGovernor } from '@app/binance';
import { asAccountId } from '@app/contracts';

const { placeOrderSpy, cancelOrderSpy } = vi.hoisted(() => ({
  placeOrderSpy: vi.fn(),
  cancelOrderSpy: vi.fn(),
}));

vi.mock('../../src/executor/decisions/place-order.js', () => ({
  placeOrderHandler: placeOrderSpy,
}));
vi.mock('../../src/executor/decisions/cancel-order.js', () => ({
  cancelOrderHandler: cancelOrderSpy,
}));

import { createLiveExecutor } from '../../src/executor/live-executor.js';
import type { ProfileExecutorBindings } from '../../src/executor/live-executor.js';
import type { MetricsSink } from '../../src/metrics/catalog.js';

const CTX: TickExecutorContext = {
  userId: '11111111-1111-4111-8111-111111111111',
  profileId: '22222222-2222-4222-8222-222222222222',
  clock: { nowMs: () => 0 },
  strategyName: 'momentum',
};
const ACCOUNT = asAccountId('a-1');

const rearmPlace: Decision = {
  type: 'place-order',
  intent: {
    symbol: 'MMTUSDT',
    side: 'SELL',
    reason: 'protective-stop',
    clientOrderId: 'coid-ps',
    deferrable: true,
  },
  params: { type: 'STOP_LOSS_LIMIT', stopPrice: '0.2', price: '0.19', quantity: '10' },
};

const supersedeCancel: Decision = {
  type: 'cancel-order',
  orderId: 77,
  reason: 'momentum-protective-stop-superseded',
  symbol: 'MMTUSDT',
};

const exitPlace: Decision = {
  type: 'place-order',
  intent: { symbol: 'MMTUSDT', side: 'SELL', reason: 'exit', clientOrderId: 'coid-exit' },
  params: { type: 'MARKET', quantity: '10' },
};

const setKv: Decision = { type: 'set-kv', key: 'momentum:x', value: 1 };

const mkLogger = () =>
  ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) as unknown as Logger;

/** Only `hasHeadroom` is exercised here; the rest of the governor is unit-tested in @app/binance. */
const governor = (headroom: boolean): OrderRateGovernor =>
  ({ hasHeadroom: vi.fn(() => headroom) }) as unknown as OrderRateGovernor;

const buildExecutor = (bindings: Partial<ProfileExecutorBindings> | null) => {
  const logger = mkLogger();
  const metrics = { record: vi.fn(), forget: vi.fn() } as unknown as MetricsSink;
  const executor = createLiveExecutor({
    redis: {} as unknown as Redis,
    notifyRegistry: {} as unknown as NotifyProviderRegistry,
    strategies: {} as unknown as StrategyRegistry,
    logger,
    metrics,
    resolveProfile: vi.fn(async () => bindings as ProfileExecutorBindings | null),
    notifierGapThrottle: { allow: async () => true, release: async () => undefined },
  });
  return { executor, logger, metrics };
};

beforeEach(() => {
  vi.clearAllMocks();
  placeOrderSpy.mockResolvedValue({ ok: true } satisfies DecisionResult);
  cancelOrderSpy.mockResolvedValue({ ok: true } satisfies DecisionResult);
});

describe('LiveExecutor.applyAll — ORDERS budget deferral', () => {
  it('sheds a re-arm pair when the account has no headroom, transmitting neither leg', async () => {
    const orderGovernor = governor(false);
    const { executor, logger, metrics } = buildExecutor({ orderGovernor });

    const applied = await executor.applyAll(CTX, ACCOUNT, [supersedeCancel, rearmPlace]);

    // Nothing reached Binance: the stop already resting is still the protection.
    expect(cancelOrderSpy).not.toHaveBeenCalled();
    expect(placeOrderSpy).not.toHaveBeenCalled();
    // Both legs are RECORDED as deferred rather than dropped — the audit payload
    // reads this array, and a truncated one reads as "never emitted".
    expect(applied).toHaveLength(2);
    for (const a of applied) {
      // `deferred: true` is asserted explicitly, not inferred from the reason
      // string: it is the flag the notifier keys on to stay silent, so a refactor
      // that reworded the reason while dropping the flag would turn the feature's
      // designed steady state into an alert storm without failing a test.
      expect(a.result).toMatchObject({
        ok: false,
        retryable: true,
        phase: 'pre-call',
        deferred: true,
      });
      expect(a.result.ok === false && a.result.reason).toContain('deferred');
    }
    // One, not two: Binance's ORDERS budget is an unfilled order count, so the
    // paired cancel spends nothing and only the placement needs headroom. And
    // the peek must not consume budget.
    expect(orderGovernor.hasHeadroom).toHaveBeenCalledWith(1);
    expect(metrics.record).toHaveBeenCalledWith('order_budget_deferred', 1, {
      profileId: CTX.profileId,
      symbol: 'MMTUSDT',
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('applies the re-arm pair when headroom exists', async () => {
    const { executor, metrics } = buildExecutor({ orderGovernor: governor(true) });

    const applied = await executor.applyAll(CTX, ACCOUNT, [supersedeCancel, rearmPlace]);

    expect(cancelOrderSpy).toHaveBeenCalledTimes(1);
    expect(placeOrderSpy).toHaveBeenCalledTimes(1);
    expect(applied.every((a) => a.result.ok)).toBe(true);
    expect(metrics.record).not.toHaveBeenCalledWith(
      'order_budget_deferred',
      expect.anything(),
      expect.anything(),
    );
  });

  it('never peeks for an exit, so an exhausted budget blocks in the REST client instead', async () => {
    const orderGovernor = governor(false);
    const { executor } = buildExecutor({ orderGovernor });

    const applied = await executor.applyAll(CTX, ACCOUNT, [supersedeCancel, exitPlace]);

    expect(orderGovernor.hasHeadroom).not.toHaveBeenCalled();
    expect(placeOrderSpy).toHaveBeenCalledTimes(1);
    expect(applied.every((a) => a.result.ok)).toBe(true);
  });

  it('runs the non-order decisions of a deferred batch — only orders are budget-bound', async () => {
    const { executor } = buildExecutor({ orderGovernor: governor(false) });

    const applied = await executor.applyAll(CTX, ACCOUNT, [rearmPlace, setKv]);

    expect(placeOrderSpy).not.toHaveBeenCalled();
    expect(applied[1]?.decision).toBe(setKv);
    // It RAN — the stub redis makes it fail, which is a different failure from
    // the deferral the order leg got. What matters is that it was attempted.
    const kvResult = applied[1]?.result;
    expect(kvResult?.ok === false && kvResult.reason).not.toContain('deferred');
  });

  it('applies the re-arm when the account has no governor at all', async () => {
    // The posture when exchangeInfo published no ORDERS rows: unaccounted, not blocked.
    const { executor } = buildExecutor({});

    await executor.applyAll(CTX, ACCOUNT, [supersedeCancel, rearmPlace]);

    expect(placeOrderSpy).toHaveBeenCalledTimes(1);
  });

  it('applies the re-arm when the profile no longer resolves, leaving the refusal to the handlers', async () => {
    const { executor } = buildExecutor(null);

    const applied = await executor.applyAll(CTX, ACCOUNT, [rearmPlace]);

    expect(placeOrderSpy).toHaveBeenCalledTimes(1);
    expect(applied[0]?.result.ok).toBe(true);
  });
});
