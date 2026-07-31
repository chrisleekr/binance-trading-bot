import { describe, it, expect } from 'vitest';
import type { IndicatorSnapshot, MarketSnapshot } from '@app/strategy-core';
import { evaluateIndicatorGate } from '../src/indicator-gate.js';
import { TTConfigSchema, type TTConfig } from '../src/schema.js';

const baseSnap: IndicatorSnapshot = {
  windowSize: 200,
  lowestLow: '40000',
  highestHigh: '60000',
  sma20: '50000',
  ema20: '50500',
  rsi14: '40',
  lastCandleCloseTimeMs: 1_700_000_000_000,
};

const cfg = (indicatorGate: Record<string, unknown>): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '50' },
      avgEntryPriceRemoveThreshold: '0',
      indicatorGate,
    },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
  });

const market = (
  currentPrice: string,
  snap?: Partial<IndicatorSnapshot> | 'absent',
): MarketSnapshot => ({
  symbol: 'BTCUSDT',
  currentPrice,
  candlesByInterval: {},
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
  ...(snap === 'absent'
    ? {}
    : { indicatorsByInterval: { '1h': { ...baseSnap, ...(snap ?? {}) } } }),
});

describe('evaluateIndicatorGate — disabled knobs', () => {
  it('passes when every knob is at its default (disabled), even with no indicator cache', () => {
    const result = evaluateIndicatorGate(market('50000', 'absent'), cfg({}));
    expect(result.ok).toBe(true);
  });

  it('does not touch the indicator cache when all knobs are off', () => {
    const result = evaluateIndicatorGate(
      market('50000', 'absent'),
      cfg({ rsiMaxBuy: '0', smaBias: 'off', emaBias: 'off' }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('evaluateIndicatorGate — RSI ceiling', () => {
  it('passes when rsi14 is at or below the ceiling', () => {
    expect(
      evaluateIndicatorGate(market('50000', { rsi14: '30' }), cfg({ rsiMaxBuy: '30' })).ok,
    ).toBe(true);
  });

  it('vetoes with indicator-rsi when rsi14 is above the ceiling', () => {
    const result = evaluateIndicatorGate(
      market('50000', { rsi14: '55' }),
      cfg({ rsiMaxBuy: '30' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('indicator-rsi');
    expect(result.context).toMatchObject({ interval: '1h', rsi14: '55', rsiMaxBuy: '30' });
  });

  it('vetoes with indicator-unavailable when rsi14 is null (window too short)', () => {
    const result = evaluateIndicatorGate(
      market('50000', { rsi14: null }),
      cfg({ rsiMaxBuy: '30' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('indicator-unavailable');
  });

  it('vetoes with indicator-unavailable when the interval snapshot is absent', () => {
    const result = evaluateIndicatorGate(market('50000', 'absent'), cfg({ rsiMaxBuy: '30' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('indicator-unavailable');
  });

  it('vetoes with indicator-unavailable when the cached rsi value is not a number', () => {
    const result = evaluateIndicatorGate(
      market('50000', { rsi14: 'corrupt' }),
      cfg({ rsiMaxBuy: '30' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('indicator-unavailable');
  });
});

describe('evaluateIndicatorGate — SMA / EMA bias', () => {
  it('price-below-sma passes when price is strictly below SMA', () => {
    expect(
      evaluateIndicatorGate(
        market('49000', { sma20: '50000' }),
        cfg({ smaBias: 'price-below-sma' }),
      ).ok,
    ).toBe(true);
  });

  it('price-below-sma vetoes with indicator-sma when price is at or above SMA', () => {
    const result = evaluateIndicatorGate(
      market('50000', { sma20: '50000' }),
      cfg({ smaBias: 'price-below-sma' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('indicator-sma');
    expect(result.context).toMatchObject({ sma20: '50000', bias: 'price-below-sma' });
  });

  it('price-above-sma passes when price is strictly above SMA', () => {
    expect(
      evaluateIndicatorGate(
        market('51000', { sma20: '50000' }),
        cfg({ smaBias: 'price-above-sma' }),
      ).ok,
    ).toBe(true);
  });

  it('vetoes with indicator-unavailable when sma20 is a non-numeric (corrupt) value', () => {
    const result = evaluateIndicatorGate(
      market('49000', { sma20: 'corrupt' }),
      cfg({ smaBias: 'price-below-sma' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('indicator-unavailable');
  });

  it('vetoes with indicator-unavailable when sma20 is null', () => {
    const result = evaluateIndicatorGate(
      market('49000', { sma20: null }),
      cfg({ smaBias: 'price-below-sma' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('indicator-unavailable');
  });

  it('price-above-ema vetoes with indicator-ema when price is below EMA', () => {
    const result = evaluateIndicatorGate(
      market('49000', { ema20: '50500' }),
      cfg({ emaBias: 'price-above-ema' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('indicator-ema');
  });

  it('vetoes with indicator-unavailable when ema20 is null', () => {
    const result = evaluateIndicatorGate(
      market('49000', { ema20: null }),
      cfg({ emaBias: 'price-above-ema' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('indicator-unavailable');
  });

  it('price-below-ema passes when price is strictly below EMA', () => {
    expect(
      evaluateIndicatorGate(
        market('50000', { ema20: '50500' }),
        cfg({ emaBias: 'price-below-ema' }),
      ).ok,
    ).toBe(true);
  });
});

describe('evaluateIndicatorGate — combined knobs', () => {
  it('passes only when every armed knob is satisfied', () => {
    const config = cfg({ rsiMaxBuy: '50', smaBias: 'price-below-sma', emaBias: 'price-below-ema' });
    expect(evaluateIndicatorGate(market('49000', { rsi14: '40' }), config).ok).toBe(true);
  });

  it('vetoes on the first failing knob (RSI checked before MA bias)', () => {
    const config = cfg({ rsiMaxBuy: '30', smaBias: 'price-below-sma' });
    const result = evaluateIndicatorGate(market('49000', { rsi14: '60' }), config);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('indicator-rsi');
  });

  it('vetoes with indicator-unavailable when currentPrice is unparseable and a MA knob is armed', () => {
    const result = evaluateIndicatorGate(
      market('not-a-number'),
      cfg({ smaBias: 'price-below-sma' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('indicator-unavailable');
  });
});
