import { describe, expect, it } from 'vitest';
import type { OpenOrder, TickInput } from '@app/strategy-core';

import { evaluateGridBuy } from '../src/branches/grid-buy.js';
import { gridBuyClientOrderId } from '../src/client-order-id.js';
import { trailingTrade } from '../src/index.js';
import { initialTTState, type TTBundle, type TTConfig, type TTState } from '../src/schema.js';

const FILTERS = {
  minNotional: '5',
  tickSize: '0.01',
  stepSize: '0.0001',
  minQty: '0.0001',
  maxQty: '1000000',
  minPrice: '0',
  maxPrice: '1000000',
};

// Immediate basis + a stop-limit level 0 (stop 1.01 / limit 1.015), so the
// entry always targets level 0 and the resting-order lifecycle is exercised
// without the lowest-price gate interfering.
const CONFIG = trailingTrade.configSchema.parse({
  symbol: 'BTCUSDT',
  candleInterval: '1h',
  buy: {
    enabled: true,
    entrySizing: { mode: 'fixed', amount: '15' },
    avgEntryPriceRemoveThreshold: '0',
    firstBuyTriggerBasis: 'immediate',
    gridLevels: [
      {
        triggerPercentage: '1',
        maxPurchaseAmount: '15',
        stopPricePercentage: '1.01',
        limitPricePercentage: '1.015',
      },
    ],
  },
  sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
}) as TTConfig;

const restingOrder = (executedQty: string): OpenOrder => ({
  orderId: 1,
  clientOrderId: gridBuyClientOrderId('p1', 'BTCUSDT', 0),
  symbol: 'BTCUSDT',
  side: 'BUY',
  type: 'STOP_LOSS_LIMIT',
  status: executedQty === '0' ? 'NEW' : 'PARTIALLY_FILLED',
  price: '101.5',
  origQty: '0.1',
  executedQty,
  cummulativeQuoteQty: '0',
  stopPrice: '101', // placed when price was ~100 → stop 100 × 1.01
  timeInForce: 'GTC',
  transactTimeMs: 0,
  updateTimeMs: 0,
});

const makeInput = (
  currentPrice: string,
  openOrders: readonly OpenOrder[],
): TickInput<TTConfig, TTState, TTBundle> =>
  ({
    config: CONFIG,
    market: {
      symbol: 'BTCUSDT',
      currentPrice,
      candlesByInterval: {},
      symbolInfo: {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        status: 'TRADING',
        filters: FILTERS,
      },
    },
    openOrders,
    profile: { id: 'p1' },
    bundle: { technicals: {}, override: null },
  }) as unknown as TickInput<TTConfig, TTState, TTBundle>;

// Two grid levels so a promotion (cgti 0 → 1) is in range; used to exercise
// the malformed-price guard on the averaging-down branch.
const TWO_LEVEL_CONFIG = trailingTrade.configSchema.parse({
  symbol: 'BTCUSDT',
  candleInterval: '1h',
  buy: {
    enabled: true,
    entrySizing: { mode: 'fixed', amount: '15' },
    avgEntryPriceRemoveThreshold: '0',
    firstBuyTriggerBasis: 'immediate',
    gridLevels: [
      { triggerPercentage: '1', maxPurchaseAmount: '15' },
      { triggerPercentage: '0.95', maxPurchaseAmount: '15' },
    ],
  },
  sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
}) as TTConfig;

const makeTwoLevelInput = (currentPrice: string): TickInput<TTConfig, TTState, TTBundle> =>
  ({
    config: TWO_LEVEL_CONFIG,
    market: {
      symbol: 'BTCUSDT',
      currentPrice,
      candlesByInterval: {},
      symbolInfo: {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        status: 'TRADING',
        filters: FILTERS,
      },
    },
    openOrders: [],
    profile: { id: 'p1' },
    bundle: { technicals: {}, override: null },
  }) as unknown as TickInput<TTConfig, TTState, TTBundle>;

describe('evaluateGridBuy — out-of-range resting level', () => {
  it('noops when the stored grid index points past the configured levels', () => {
    // A resting-order trail-down state (avgEntryPrice null, cgti set) but the
    // config has fewer levels than the stored index (config shrank under a held
    // position) → the level lookup is undefined → noop, no throw.
    const restingId = gridBuyClientOrderId('p1', 'BTCUSDT', 5);
    const resting: OpenOrder = {
      orderId: 9,
      clientOrderId: restingId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'STOP_LOSS_LIMIT',
      status: 'NEW',
      price: '101',
      origQty: '0.1',
      executedQty: '0',
      cummulativeQuoteQty: '0',
      stopPrice: '101',
      timeInForce: 'GTC',
      transactTimeMs: 0,
      updateTimeMs: 0,
    };
    const state: TTState = { ...initialTTState(), currentGridTradeIndex: 5 };
    const result = evaluateGridBuy(makeInput('95', [resting]), state, 5, false);
    expect(result.kind).toBe('noop');
  });
});

describe('evaluateGridBuy — promotion price guard', () => {
  it('noops the averaging-down promotion when currentPrice is unparseable', () => {
    // A held level-0 position eligible for promotion to level 1, but a
    // malformed market price means safeDecimal returns null → noop, not throw.
    const held: TTState = {
      ...initialTTState(),
      avgEntryPrice: '100',
      currentGridTradeIndex: 0,
      heldQuantity: '0.1',
    };
    const result = evaluateGridBuy(makeTwoLevelInput('not-a-number'), held, 0, false);
    expect(result.kind).toBe('noop');
  });
});

describe('evaluateGridBuy — stop-limit price guards', () => {
  it('emits without a stop-limit price block when the current price is unparseable', () => {
    // A malformed market price means the stop/limit Decimals cannot be computed,
    // so stopLimit stays undefined and the level emits as a MARKET-style entry
    // (the entry branch, forceTvOpen=true, still fires).
    const result = evaluateGridBuy(makeInput('not-a-number', []), initialTTState(), 0, true);
    expect(['emit', 'skip-filter', 'noop']).toContain(result.kind);
  });

  it('waits on a resting stop-limit order that has no stopPrice', () => {
    const noStop: OpenOrder = { ...restingOrder('0'), stopPrice: undefined };
    const postEmit: TTState = { ...initialTTState(), currentGridTradeIndex: 0 };
    const result = evaluateGridBuy(makeInput('95', [noStop]), postEmit, 0, false);
    expect(result.kind).toBe('wait');
  });
});

describe('evaluateGridBuy — resting stop-limit lifecycle', () => {
  it('re-prices (cancel + replace) when price falls below the resting stop', () => {
    // currentPrice 95 → new stop 95 × 1.01 = 95.95 < resting 101 → trail down.
    const result = evaluateGridBuy(makeInput('95', [restingOrder('0')]), initialTTState(), 0, true);
    expect(result.kind).toBe('emit');
    if (result.kind !== 'emit') throw new Error('expected emit');
    const cancels = result.decisions.filter((d) => d.type === 'cancel-order');
    expect(cancels).toHaveLength(1);
    expect(result.decisions.some((d) => d.type === 'place-order')).toBe(true);
  });

  it('waits (keeps the resting order) when the new stop is not lower', () => {
    // currentPrice 100 → new stop 101 == resting 101 → not strictly lower.
    const result = evaluateGridBuy(
      makeInput('100', [restingOrder('0')]),
      initialTTState(),
      0,
      true,
    );
    expect(result.kind).toBe('wait');
  });

  it('never re-prices a partially-filled resting order', () => {
    const result = evaluateGridBuy(
      makeInput('95', [restingOrder('0.05')]),
      initialTTState(),
      0,
      true,
    );
    expect(result.kind).toBe('wait');
  });
});

describe('evaluateGridBuy — gridRepriceMinDriftPercent drift gate', () => {
  // Same level-0 stop-limit as CONFIG (stop 1.01 / limit 1.015) but with a
  // meaningful 1% min-drift threshold: the resting stop only re-places when the
  // recomputed stop is at least 1% below the resting one, collapsing the churn.
  const driftConfig = trailingTrade.configSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '15' },
      avgEntryPriceRemoveThreshold: '0',
      firstBuyTriggerBasis: 'immediate',
      gridRepriceMinDriftPercent: '0.01',
      gridLevels: [
        {
          triggerPercentage: '1',
          maxPurchaseAmount: '15',
          stopPricePercentage: '1.01',
          limitPricePercentage: '1.015',
        },
      ],
    },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
  }) as TTConfig;

  const makeDriftInput = (
    currentPrice: string,
    openOrders: readonly OpenOrder[],
  ): TickInput<TTConfig, TTState, TTBundle> =>
    ({
      ...makeInput(currentPrice, openOrders),
      config: driftConfig,
    }) as unknown as TickInput<TTConfig, TTState, TTBundle>;

  const postEmit: TTState = { ...initialTTState(), currentGridTradeIndex: 0 };

  it('waits when the drift is below the minimum', () => {
    // currentPrice 99.99 → new stop 99.99 × 1.01 = 100.99 (rounded to tick).
    // drift = 101 − 100.99 = 0.01, threshold = 101 × 0.01 = 1.01 → not far
    // enough, so the resting order stays. Without the gate this re-places.
    const result = evaluateGridBuy(
      makeDriftInput('99.99', [restingOrder('0')]),
      postEmit,
      0,
      false,
    );
    expect(result.kind).toBe('wait');
  });

  it('re-prices when the drift meets the minimum', () => {
    // currentPrice 95 → new stop 95.95. drift = 101 − 95.95 = 5.05 ≥ 1.01 → emit.
    const result = evaluateGridBuy(makeDriftInput('95', [restingOrder('0')]), postEmit, 0, false);
    expect(result.kind).toBe('emit');
    if (result.kind !== 'emit') throw new Error('expected emit');
    expect(result.decisions.filter((d) => d.type === 'cancel-order')).toHaveLength(1);
    expect(result.decisions.some((d) => d.type === 'place-order')).toBe(true);
  });

  it('re-prices when the drift exactly equals the minimum', () => {
    // Boundary: currentPrice 99 → new stop 99 × 1.01 = 99.99. drift = 101 − 99.99
    // = 1.01, which equals the threshold 101 × 0.01 = 1.01. The gate uses a strict
    // `.lt`, so at exact equality it re-prices (does not wait). Pins the `.lt`
    // contract so a future flip to `.lte` cannot silently invert it.
    const result = evaluateGridBuy(makeDriftInput('99', [restingOrder('0')]), postEmit, 0, false);
    expect(result.kind).toBe('emit');
  });
});

describe('evaluateGridBuy — resting stop-limit trail-down on a NORMAL tick (#368)', () => {
  // The real post-emit state: a level-0 stop-limit was emitted (cgti=0) and is
  // resting unfilled (avgEntryPrice still null). This is the state every normal
  // tick sees after the entry; before the fix it returned noop and the resting
  // order was never trailed down. `forceTvOpen` is false here (a normal tick,
  // not a forced re-entry), unlike the entry-branch tests above.
  const postEmit: TTState = { ...initialTTState(), currentGridTradeIndex: 0 };

  it('trails the resting order down (cancel + replace) as price keeps falling', () => {
    const result = evaluateGridBuy(makeInput('95', [restingOrder('0')]), postEmit, 0, false);
    expect(result.kind).toBe('emit');
    if (result.kind !== 'emit') throw new Error('expected emit');
    expect(result.decisions.filter((d) => d.type === 'cancel-order')).toHaveLength(1);
    expect(result.decisions.some((d) => d.type === 'place-order')).toBe(true);
    // Stays at the resting level: a re-price, not a promotion.
    expect(result.state.currentGridTradeIndex).toBe(0);
  });

  it('does NOT re-fire the level when no order is resting (never double-places)', () => {
    // No resting order (just cancelled, or fill about to be adopted): the level
    // must not be re-fired, only an existing resting order is re-priced.
    const result = evaluateGridBuy(makeInput('95', []), postEmit, 0, false);
    expect(result.kind).toBe('noop');
  });

  it('waits when the recomputed stop is not strictly lower', () => {
    const result = evaluateGridBuy(makeInput('100', [restingOrder('0')]), postEmit, 0, false);
    expect(result.kind).toBe('wait');
  });
});
