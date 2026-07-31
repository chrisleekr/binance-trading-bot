import { describe, expect, it } from 'vitest';
import type { Candle, TickInput } from '@app/strategy-core';

import { evaluateGridBuy } from '../src/branches/grid-buy.js';
import { trailingTrade } from '../src/index.js';
import { initialTTState, type TTBundle, type TTConfig, type TTState } from '../src/schema.js';

const candle = (low: string): Candle => ({
  openTimeMs: 0,
  closeTimeMs: 0,
  open: low,
  high: low,
  low,
  close: low,
  volume: '1',
  isClosed: true,
});

const FILTERS = {
  minNotional: '5',
  tickSize: '0.01',
  stepSize: '0.0001',
  minQty: '0.0001',
  maxQty: '1000000',
  minPrice: '0',
  maxPrice: '1000000',
};

const makeConfig = (basis: 'immediate' | 'lowest-price'): TTConfig =>
  trailingTrade.configSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '15' },
      avgEntryPriceRemoveThreshold: '0',
      firstBuyTriggerBasis: basis,
      candleLimit: 3,
      gridLevels: [{ triggerPercentage: '1', maxPurchaseAmount: '15' }],
    },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
  }) as TTConfig;

// Window lows [100, 95, 98] → lowest = 95; level-0 trigger 1 → entry fires
// when price <= 95.
const makeInput = (
  config: TTConfig,
  currentPrice: string,
): TickInput<TTConfig, TTState, TTBundle> =>
  ({
    config,
    market: {
      symbol: 'BTCUSDT',
      currentPrice,
      candlesByInterval: { '1h': [candle('100'), candle('95'), candle('98')] },
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

describe('evaluateGridBuy — lowest-price first-buy trigger', () => {
  it('fires the level-0 entry when price reaches the window low', () => {
    const config = makeConfig('lowest-price');
    const result = evaluateGridBuy(makeInput(config, '95'), initialTTState(), 0, true);
    expect(result.kind).toBe('emit');
  });

  it('waits while price is above the window low × trigger', () => {
    const config = makeConfig('lowest-price');
    const result = evaluateGridBuy(makeInput(config, '96'), initialTTState(), 0, true);
    expect(result.kind).toBe('wait');
  });

  it('immediate basis ignores the window and enters from flat', () => {
    const config = makeConfig('immediate');
    const result = evaluateGridBuy(makeInput(config, '96'), initialTTState(), 0, true);
    expect(result.kind).toBe('emit');
  });

  it('noops the lowest-price entry when no grid level 0 is configured', () => {
    // Empty gridLevels with a lowest-price basis: lvl0 is undefined so the
    // trigger cannot be computed and the entry cannot arm.
    const config = trailingTrade.configSchema.parse({
      symbol: 'BTCUSDT',
      candleInterval: '1h',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '15' },
        avgEntryPriceRemoveThreshold: '0',
        firstBuyTriggerBasis: 'lowest-price',
        candleLimit: 3,
        gridLevels: [],
      },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    }) as TTConfig;
    expect(evaluateGridBuy(makeInput(config, '95'), initialTTState(), 0, true).kind).toBe('noop');
  });

  it('noops the lowest-price entry when the interval has no candles', () => {
    // No window → lowestLowInWindow returns null → the entry cannot arm.
    const config = makeConfig('lowest-price');
    const input = makeInput(config, '95');
    const noCandles = {
      ...input,
      market: { ...input.market, candlesByInterval: {} },
    } as unknown as TickInput<TTConfig, TTState, TTBundle>;
    expect(evaluateGridBuy(noCandles, initialTTState(), 0, true).kind).toBe('noop');
  });

  it('noops the lowest-price entry when the current price is unparseable', () => {
    const config = makeConfig('lowest-price');
    expect(evaluateGridBuy(makeInput(config, 'not-a-number'), initialTTState(), 0, true).kind).toBe(
      'noop',
    );
  });

  it('clamps the window to candleLimit when it is below the candle count', () => {
    // candleLimit 2 with 3 candles → count = candleLimit (the clamp arm). The
    // last 2 candles are [95, 98] so the window low is 95 and price 95 fires.
    const config = trailingTrade.configSchema.parse({
      symbol: 'BTCUSDT',
      candleInterval: '1h',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '15' },
        avgEntryPriceRemoveThreshold: '0',
        firstBuyTriggerBasis: 'lowest-price',
        candleLimit: 2,
        gridLevels: [{ triggerPercentage: '1', maxPurchaseAmount: '15' }],
      },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    }) as TTConfig;
    expect(evaluateGridBuy(makeInput(config, '95'), initialTTState(), 0, true).kind).toBe('emit');
  });

  it('skips a malformed candle low and still computes the window low', () => {
    const config = makeConfig('lowest-price');
    const input = makeInput(config, '95');
    const withBadLow = {
      ...input,
      market: {
        ...input.market,
        candlesByInterval: { '1h': [candle('corrupt'), candle('95'), candle('98')] },
      },
    } as unknown as TickInput<TTConfig, TTState, TTBundle>;
    expect(evaluateGridBuy(withBadLow, initialTTState(), 0, true).kind).toBe('emit');
  });
});
