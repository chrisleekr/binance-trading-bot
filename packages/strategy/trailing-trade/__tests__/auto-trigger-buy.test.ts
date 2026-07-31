// Auto-trigger-buy is a strategy-contract feature (re-arm-after-sell timer
// persisted on TTState), so its coverage lives here against the pure
// tick(), not in a worker test that would only re-exercise the same code.

import { describe, expect, it } from 'vitest';
import type { IndicatorSnapshot, OpenOrder, TickInput } from '@app/strategy-core';
import {
  trailingTrade,
  TTBundleSchema,
  TTConfigSchema,
  TTStateSchema,
  type TTBundle,
  type TTConfig,
  type TTState,
} from '../src/index.js';
import { Decimal } from '@app/money';
import { gridBuyClientOrderId } from '../src/client-order-id.js';

const NOW_MS = 1_700_000_000_000;
// armAutoTriggerBuy delay for the default triggerAfterMinutes (20).
const REARM_DELAY_MS = 20 * 60_000;
// z.uuid() requires an RFC-4122 UUID for the override payload.
const OVERRIDE_ID = '11111111-1111-4111-8111-111111111111';

interface AutoTriggerBuyKnobs {
  readonly enabled?: boolean;
  readonly triggerAfterMinutes?: number;
  readonly rescheduleWhileDisabled?: boolean;
}

interface GridLevel {
  readonly triggerPercentage: string;
  readonly maxPurchaseAmount: string;
}

const cfg = (o?: {
  autoTriggerBuy?: AutoTriggerBuyKnobs;
  buyEnabled?: boolean;
  maxPurchaseAmount?: string;
  gridLevels?: readonly GridLevel[];
  indicatorGate?: Record<string, unknown>;
}): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    buy: {
      enabled: o?.buyEnabled ?? true,
      entrySizing: { mode: 'fixed', amount: o?.maxPurchaseAmount ?? '50' },
      avgEntryPriceRemoveThreshold: '0',
      ...(o?.autoTriggerBuy ? { autoTriggerBuy: o.autoTriggerBuy } : {}),
      ...(o?.gridLevels ? { gridLevels: o.gridLevels } : {}),
      ...(o?.indicatorGate ? { indicatorGate: o.indicatorGate } : {}),
    },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
  });

const state = (o?: {
  avgEntryPrice?: string | null;
  disabledUntilMs?: number | null;
  autoTriggerBuyAtMs?: number | null;
  entryBlocker?: TTState['entryBlocker'];
}): TTState =>
  TTStateSchema.parse({
    schemaVersion: '2.0.0',
    avgEntryPrice: o?.avgEntryPrice ?? null,
    disabledUntilMs: o?.disabledUntilMs ?? null,
    triggers: { override: null },
    autoTriggerBuyAtMs: o?.autoTriggerBuyAtMs ?? null,
    entryBlocker: o?.entryBlocker ?? null,
  });

// Signal-less bundle: the TV gate would veto a buy (technicals-no-signal). The
// auto-trigger consume path must still buy through it.
const noSignalBundle = (): TTBundle =>
  TTBundleSchema.parse({
    technicals: {
      config: {
        useOnlyWithinMin: 2,
        ifExpires: 'do-not-buy',
        intervals: [
          {
            interval: '1m',
            whenStrongBuy: true,
            whenBuy: true,
            whenSell: false,
            whenStrongSell: false,
            whenNeutral: false,
          },
        ],
      },
      signals: [{ interval: '1m', signal: null }],
    },
    override: null,
  });

const triggerSellBundle = (): TTBundle =>
  TTBundleSchema.parse({
    technicals: {
      config: {
        useOnlyWithinMin: 2,
        ifExpires: 'do-not-buy',
        intervals: [
          {
            interval: '1m',
            whenStrongBuy: true,
            whenBuy: true,
            whenSell: false,
            whenStrongSell: false,
            whenNeutral: false,
          },
        ],
      },
      signals: [{ interval: '1m', signal: null }],
    },
    override: { kind: 'trigger-sell', overrideActionId: OVERRIDE_ID },
  });

const baseInput = (o?: {
  config?: TTConfig;
  state?: TTState;
  bundle?: TTBundle;
  currentPrice?: string;
  openOrders?: readonly OpenOrder[];
  btcFree?: string;
  indicators?: IndicatorSnapshot;
}): TickInput<TTConfig, TTState, TTBundle> => {
  const c = o?.config ?? cfg();
  return {
    clock: { nowMs: () => NOW_MS },
    rng: { next: () => 0 },
    trigger: { kind: 'tick' },
    profile: {
      id: 'p1',
      userId: 'u1',
      binanceMode: 'test',
      status: 'running',
      strategyVersion: '1.0.0',
    },
    config: c,
    state: o?.state ?? trailingTrade.initialState(c),
    market: {
      symbol: 'BTCUSDT',
      currentPrice: o?.currentPrice ?? '50000.00',
      candlesByInterval: {},
      ...(o?.indicators ? { indicatorsByInterval: { '1h': o.indicators } } : {}),
      symbolInfo: {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        status: 'TRADING',
        filters: {
          minNotional: '10',
          tickSize: '0.01',
          stepSize: '0.0001',
          minQty: '0.0001',
          maxQty: '9000',
          minPrice: '0.01',
          maxPrice: '1000000',
        },
      },
    },
    account: {
      balances: {
        BTC: { asset: 'BTC', free: new Decimal(o?.btcFree ?? '0'), locked: new Decimal(0) },
      },
      readable: true,
    },
    openOrders: o?.openOrders ?? [],
    bundle: o?.bundle ?? noSignalBundle(),
    limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
  };
};

const openBuy = (): OpenOrder => ({
  orderId: 7,
  clientOrderId: 'existing-buy',
  symbol: 'BTCUSDT',
  side: 'BUY',
  type: 'LIMIT',
  status: 'NEW',
  price: '49000',
  origQty: '0.0001',
  executedQty: '0',
  cummulativeQuoteQty: '0',
  transactTimeMs: 0,
  updateTimeMs: 0,
});

describe('@app/strategy-trailing-trade autoTriggerBuy — arming after a sell', () => {
  it('arms autoTriggerBuyAtMs on a stop-loss sell when enabled', () => {
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({ autoTriggerBuy: { enabled: true } }),
        state: state({ avgEntryPrice: '50000.00' }),
        currentPrice: '48000.00',
        btcFree: '0.5',
      }),
    );
    expect(out.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'SELL' } });
    expect(out.nextState.avgEntryPrice).toBeNull();
    expect(out.nextState.autoTriggerBuyAtMs).toBe(NOW_MS + REARM_DELAY_MS);
  });

  it('does not arm autoTriggerBuyAtMs on a sell when disabled', () => {
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({ autoTriggerBuy: { enabled: false } }),
        state: state({ avgEntryPrice: '50000.00' }),
        currentPrice: '48000.00',
        btcFree: '0.5',
      }),
    );
    expect(out.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'SELL' } });
    expect(out.nextState.autoTriggerBuyAtMs).toBeNull();
  });

  it('arms autoTriggerBuyAtMs on a trigger-sell override when enabled', () => {
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({ autoTriggerBuy: { enabled: true } }),
        state: state({ avgEntryPrice: '50000.00' }),
        bundle: triggerSellBundle(),
        btcFree: '0.5',
      }),
    );
    expect(out.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'SELL' } });
    expect(out.nextState.autoTriggerBuyAtMs).toBe(NOW_MS + REARM_DELAY_MS);
  });

  it('honours a custom triggerAfterMinutes when arming', () => {
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({ autoTriggerBuy: { enabled: true, triggerAfterMinutes: 5 } }),
        state: state({ avgEntryPrice: '50000.00' }),
        currentPrice: '48000.00',
        btcFree: '0.5',
      }),
    );
    expect(out.nextState.autoTriggerBuyAtMs).toBe(NOW_MS + 5 * 60_000);
  });
});

describe('@app/strategy-trailing-trade autoTriggerBuy — consuming the timer', () => {
  it('leaves the timer untouched on a normal tick before it is due', () => {
    const future = NOW_MS + 100_000;
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({ autoTriggerBuy: { enabled: true } }),
        state: state({ autoTriggerBuyAtMs: future }),
      }),
    );
    expect(out.decisions[0]?.type).toBe('emit-event');
    expect(out.nextState.autoTriggerBuyAtMs).toBe(future);
  });

  it('emits a first buy and clears the timer once it is due', () => {
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({ autoTriggerBuy: { enabled: true } }),
        state: state({ autoTriggerBuyAtMs: NOW_MS }),
      }),
    );
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'BUY' } });
    expect(out.nextState.autoTriggerBuyAtMs).toBeNull();
    expect(out.logs[0]?.message).toBe('tt-auto-trigger-buy');
    expect(out.metrics).toContainEqual({
      name: 'tt_auto_trigger_buy_emit',
      value: 1,
      tags: { symbol: 'BTCUSDT' },
    });
  });

  it('clears a stale entryBlocker when the re-armed buy fires', () => {
    // A buy emitted via the auto-trigger path is not a buy-gate block; the
    // persisted blocker must clear to null so the worker's prev/next diff fires
    // the "no longer blocked" transition exactly once.
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({ autoTriggerBuy: { enabled: true } }),
        state: state({
          autoTriggerBuyAtMs: NOW_MS,
          entryBlocker: { reason: 'awaiting-trigger-price' },
        }),
      }),
    );
    expect(out.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'BUY' } });
    expect(out.nextState.entryBlocker).toBeNull();
  });

  it('clears a stale entryBlocker on the disabled-profile noop terminal', () => {
    // A disabled profile is not evaluating a buy gate; a frozen "waiting" line
    // must not survive into the disabled terminal.
    const out = trailingTrade.tick(
      baseInput({
        state: state({
          disabledUntilMs: NOW_MS + 100_000,
          entryBlocker: { reason: 'awaiting-trigger-price' },
        }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.entryBlocker).toBeNull();
  });

  it('buys through a Technicals veto — the gate is forced open', () => {
    // noSignalBundle would veto a normal first buy (technicals-no-signal). The
    // re-armed buy must fire regardless.
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({ autoTriggerBuy: { enabled: true } }),
        state: state({ autoTriggerBuyAtMs: NOW_MS - 1 }),
        bundle: noSignalBundle(),
      }),
    );
    expect(out.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'BUY' } });
    expect(out.nextState.autoTriggerBuyAtMs).toBeNull();
  });

  it('clears a stale timer when autoTriggerBuy was switched off after arming', () => {
    // Operator armed the timer (enabled at sell time), then disabled the
    // feature before it came due. The stale timer must be consumed.
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({ autoTriggerBuy: { enabled: false } }),
        state: state({ autoTriggerBuyAtMs: NOW_MS }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.autoTriggerBuyAtMs).toBeNull();
    expect(out.logs[0]).toMatchObject({
      message: 'tt-auto-trigger-buy-skipped',
      context: { reason: 'feature-disabled' },
    });
  });

  it('fires the buy when an expired disable auto-clears on the same tick', () => {
    // disabledUntilMs in the past is cleared by the top-of-tick guard, so
    // the consume branch sees a live profile and emits the re-armed buy.
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({ autoTriggerBuy: { enabled: true } }),
        state: state({ disabledUntilMs: NOW_MS - 1, autoTriggerBuyAtMs: NOW_MS }),
      }),
    );
    expect(out.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'BUY' } });
    expect(out.nextState.autoTriggerBuyAtMs).toBeNull();
    expect(out.nextState.disabledUntilMs).toBeNull();
  });

  it('clears the timer and noops when the buy side is disabled', () => {
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({ autoTriggerBuy: { enabled: true }, buyEnabled: false }),
        state: state({ autoTriggerBuyAtMs: NOW_MS }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.autoTriggerBuyAtMs).toBeNull();
    expect(out.logs[0]).toMatchObject({
      message: 'tt-auto-trigger-buy-skipped',
      context: { reason: 'buy-disabled' },
    });
  });

  it('clears the timer and skips when a position is already held', () => {
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({ autoTriggerBuy: { enabled: true } }),
        state: state({ avgEntryPrice: '49000.00', autoTriggerBuyAtMs: NOW_MS }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.autoTriggerBuyAtMs).toBeNull();
    expect(out.logs[0]).toMatchObject({
      message: 'tt-auto-trigger-buy-skipped',
      context: { reason: 'holding' },
    });
  });

  it('clears the timer and skips when an open BUY already exists', () => {
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({ autoTriggerBuy: { enabled: true } }),
        state: state({ autoTriggerBuyAtMs: NOW_MS }),
        openOrders: [openBuy()],
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.autoTriggerBuyAtMs).toBeNull();
    expect(out.logs[0]).toMatchObject({
      message: 'tt-auto-trigger-buy-skipped',
      context: { reason: 'open-buy' },
    });
  });

  it('clears the timer and skips when the order fails an exchange filter', () => {
    // maxPurchaseAmount below minNotional: computeFirstBuyQuantity rejects.
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({ autoTriggerBuy: { enabled: true }, maxPurchaseAmount: '1' }),
        state: state({ autoTriggerBuyAtMs: NOW_MS }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.autoTriggerBuyAtMs).toBeNull();
    expect(out.logs[0]?.message).toBe('tt-auto-trigger-buy-skipped');
  });
});

describe('@app/strategy-trailing-trade autoTriggerBuy — grid mode', () => {
  // Level 0 budget = maxPurchaseAmount = 20. At price 50000 that sizes
  // 0.0004 BTC — distinct from the buy-level maxPurchaseAmount '50' legacy
  // entry (0.001), so the quantity proves grid routing.
  const twoLevelGrid: readonly GridLevel[] = [
    { triggerPercentage: '1.0', maxPurchaseAmount: '20' },
    { triggerPercentage: '0.97', maxPurchaseAmount: '30' },
  ];

  it('re-enters at grid level 0 sized by gridLevels[0] when the timer is due', () => {
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({ autoTriggerBuy: { enabled: true }, gridLevels: twoLevelGrid }),
        state: state({ autoTriggerBuyAtMs: NOW_MS }),
      }),
    );
    expect(out.decisions).toHaveLength(1);
    const decision = out.decisions[0];
    expect(decision?.type).toBe('place-order');
    if (decision?.type !== 'place-order') throw new Error('expected place-order');
    expect(decision.intent).toMatchObject({
      side: 'BUY',
      reason: 'grid-buy',
      meta: { gridTradeIndex: 0 },
    });
    expect(decision.params).toMatchObject({ type: 'MARKET', quantity: '0.0004' });
    expect(out.nextState.currentGridTradeIndex).toBe(0);
    expect(out.nextState.autoTriggerBuyAtMs).toBeNull();
    expect(out.logs[0]).toMatchObject({
      message: 'tt-auto-trigger-buy',
      context: { gridLevel: 0 },
    });
    expect(out.metrics).toContainEqual({
      name: 'tt_auto_trigger_buy_emit',
      value: 1,
      tags: { symbol: 'BTCUSDT' },
    });
  });

  it('buys through a Technicals veto in grid mode — the entry TV gate is forced open', () => {
    // noSignalBundle vetoes a normal grid level-0 entry (technicals-no-signal);
    // the re-armed grid entry must fire regardless.
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({ autoTriggerBuy: { enabled: true }, gridLevels: twoLevelGrid }),
        state: state({ autoTriggerBuyAtMs: NOW_MS - 1 }),
        bundle: noSignalBundle(),
      }),
    );
    const decision = out.decisions[0];
    expect(decision?.type).toBe('place-order');
    if (decision?.type !== 'place-order') throw new Error('expected place-order');
    expect(decision.intent).toMatchObject({ reason: 'grid-buy', meta: { gridTradeIndex: 0 } });
    expect(out.nextState.currentGridTradeIndex).toBe(0);
  });

  it('clears the timer and skips when the grid level-0 budget fails an exchange filter', () => {
    // maxPurchaseAmount 0.0001 sizes a sub-stepSize quantity computeFirstBuyQuantity
    // rejects, so the grid entry surfaces a typed filter skip.
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({
          autoTriggerBuy: { enabled: true },
          gridLevels: [{ triggerPercentage: '1.0', maxPurchaseAmount: '0.0001' }],
        }),
        state: state({ autoTriggerBuyAtMs: NOW_MS }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.autoTriggerBuyAtMs).toBeNull();
    expect(out.logs[0]).toMatchObject({
      message: 'tt-auto-trigger-buy-skipped',
      context: { reason: 'min-qty' },
    });
  });

  it('clears the timer and skips when a level-0 BUY is already in flight', () => {
    // An open BUY carrying the level-0 clientOrderId means the grid entry
    // is already resting; the re-arm must not double-emit.
    const inFlight: OpenOrder = {
      ...openBuy(),
      clientOrderId: gridBuyClientOrderId('p1', 'BTCUSDT', 0),
    };
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({ autoTriggerBuy: { enabled: true }, gridLevels: twoLevelGrid }),
        state: state({ autoTriggerBuyAtMs: NOW_MS }),
        openOrders: [inFlight],
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.logs[0]).toMatchObject({
      message: 'tt-auto-trigger-buy-skipped',
      context: { reason: 'open-buy' },
    });
  });

  it('keeps the timer armed when a lowest-price basis has not reached the window low (#369)', () => {
    // autoTriggerBuy + firstBuyTriggerBasis 'lowest-price' (the running RealNet
    // shape). The timer is due but price (60000) is above the window low
    // (48000) × the level-0 trigger, so evaluateGridBuy waits. Before the fix
    // this discarded the timer and mislabelled it 'open-buy'; now the timer is
    // kept so the forced re-entry re-checks next tick.
    const lowestPriceCfg = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      candleInterval: '1h',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
        firstBuyTriggerBasis: 'lowest-price',
        candleLimit: 3,
        autoTriggerBuy: { enabled: true },
        gridLevels: [{ triggerPercentage: '1', maxPurchaseAmount: '50' }],
      },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    }) as TTConfig;
    const candle = (low: string) => ({
      openTimeMs: 0,
      closeTimeMs: 0,
      open: low,
      high: low,
      low,
      close: low,
      volume: '1',
      isClosed: true,
    });
    const base = baseInput({
      config: lowestPriceCfg,
      state: state({ autoTriggerBuyAtMs: NOW_MS }),
      currentPrice: '60000',
    });
    const input = {
      ...base,
      market: {
        ...base.market,
        candlesByInterval: { '1h': [candle('50000'), candle('48000'), candle('49000')] },
      },
    } as TickInput<TTConfig, TTState, TTBundle>;

    const out = trailingTrade.tick(input);

    expect(out.decisions).toEqual([{ type: 'noop' }]);
    // The timer is KEPT (not nulled) so it re-checks next tick.
    expect(out.nextState.autoTriggerBuyAtMs).toBe(NOW_MS);
    expect(out.logs[0]).toMatchObject({ message: 'tt-auto-trigger-buy-waiting' });
  });

  it('clears the timer and skips when the indicator gate vetoes the grid entry', () => {
    // The indicator gate applies to a grid entry even when the TV gate is
    // forced open: rsi14 55 is above the rsiMaxBuy 30 ceiling.
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({
          autoTriggerBuy: { enabled: true },
          gridLevels: twoLevelGrid,
          indicatorGate: { rsiMaxBuy: '30' },
        }),
        state: state({ autoTriggerBuyAtMs: NOW_MS }),
        indicators: {
          windowSize: 200,
          lowestLow: '40000',
          highestHigh: '60000',
          sma20: '50000',
          ema20: '50500',
          rsi14: '55',
          lastCandleCloseTimeMs: NOW_MS,
        },
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.autoTriggerBuyAtMs).toBeNull();
    // The fall-through skip emits at `warn` and spreads the indicator
    // readouts that drove the veto into the log context before the fixed
    // symbol/reason keys — both preserved by autoTriggerSkipTerminal.
    expect(out.logs[0]).toMatchObject({
      level: 'warn',
      message: 'tt-auto-trigger-buy-skipped',
      context: { reason: 'indicator-rsi', rsi14: '55', rsiMaxBuy: '30' },
    });
  });
});

describe('@app/strategy-trailing-trade autoTriggerBuy — disabled profile when the timer fires', () => {
  it('reschedules the timer when disabled and rescheduleWhileDisabled is on', () => {
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({ autoTriggerBuy: { enabled: true, rescheduleWhileDisabled: true } }),
        state: state({ disabledUntilMs: NOW_MS + 3_600_000, autoTriggerBuyAtMs: NOW_MS }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.autoTriggerBuyAtMs).toBe(NOW_MS + REARM_DELAY_MS);
    expect(out.nextState.disabledUntilMs).toBe(NOW_MS + 3_600_000);
    expect(out.metrics).toContainEqual({
      name: 'tt_auto_trigger_buy_rescheduled',
      value: 1,
      tags: { symbol: 'BTCUSDT' },
    });
  });

  it('leaves the timer armed when disabled and rescheduleWhileDisabled is off', () => {
    // The disabledUntilMs noop guard owns the tick; the timer stays in the
    // past so it fires on the first tick after the profile is re-enabled.
    const out = trailingTrade.tick(
      baseInput({
        config: cfg({ autoTriggerBuy: { enabled: true, rescheduleWhileDisabled: false } }),
        state: state({ disabledUntilMs: NOW_MS + 3_600_000, autoTriggerBuyAtMs: NOW_MS }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.autoTriggerBuyAtMs).toBe(NOW_MS);
    expect(out.logs).toEqual([]);
    expect(out.metrics).toEqual([]);
  });
});
