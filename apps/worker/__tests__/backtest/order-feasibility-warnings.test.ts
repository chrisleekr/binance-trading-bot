import type { Candle, SymbolInfo } from '@app/strategy-core';
import { TTConfigSchema, trailingTrade } from '@app/strategy-trailing-trade';
import { describe, expect, it } from 'vitest';

import { orderFeasibilityWarnings } from '../../src/backtest/order-feasibility-warnings.js';

const filters = {
  minNotional: '10',
  tickSize: '0.01',
  stepSize: '0.0001',
  minQty: '0.001',
  maxQty: '9000',
  minPrice: '0.01',
  maxPrice: '1000000',
};
const symbolInfo: SymbolInfo = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters,
};

const candle = (close: string): Candle => ({
  openTimeMs: 0,
  closeTimeMs: 60_000,
  open: close,
  high: close,
  low: close,
  close,
  volume: '1',
  isClosed: true,
});

const cfg = (over: Record<string, unknown>): unknown =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: { enabled: true, entrySizing: { mode: 'fixed', amount: '20' }, ...over },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
  });

const grid60 = cfg({
  gridLevels: [
    { triggerPercentage: '1', maxPurchaseAmount: '20' },
    { triggerPercentage: '0.97', maxPurchaseAmount: '20' },
    { triggerPercentage: '0.95', maxPurchaseAmount: '20' },
  ],
});

const bars = new Map<string, Candle[]>([
  ['BTCUSDT|1h', [candle('100'), candle('150'), candle('120')]],
]);

describe('orderFeasibilityWarnings', () => {
  it('warns when the starting balance cannot fund the full grid', () => {
    const w = orderFeasibilityWarnings(trailingTrade, grid60, [symbolInfo], bars, '1h', '50');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^BTCUSDT: /);
    expect(w[0]).toContain('2 of 3');
  });

  it('is silent when the balance funds the grid and every order clears its minimum', () => {
    expect(
      orderFeasibilityWarnings(trailingTrade, grid60, [symbolInfo], bars, '1h', '100000'),
    ).toEqual([]);
  });

  it('uses the window HIGHEST close for the per-order minimum (worst case for minQty)', () => {
    // amount 0.14 quote: at close 100 → qty 0.0014 ≥ minQty 0.001 (ok), but at the
    // window high 150 → qty 0.0009 < minQty 0.001, so the highest close must flag it.
    const w = orderFeasibilityWarnings(
      trailingTrade,
      cfg({ entrySizing: { mode: 'fixed', amount: '0.14' } }),
      [symbolInfo],
      bars,
      '1h',
      '100000',
    );
    expect(w.join(' ')).toMatch(/minimum order quantity/i);
  });

  it('skips a symbol with no candles', () => {
    expect(
      orderFeasibilityWarnings(trailingTrade, grid60, [symbolInfo], new Map(), '1h', '50'),
    ).toEqual([]);
  });
});
