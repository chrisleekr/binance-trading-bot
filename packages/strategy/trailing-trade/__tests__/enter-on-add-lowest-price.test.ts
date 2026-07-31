// Discovery `enterOnAdd` must own the FULL "enter on a discovery add" promise on
// a `lowest-price` first-buy profile (issue #437). The lowest-price basis defers
// the level-0 entry until price returns to the window low; a momentum pick trades
// ABOVE its window low, so without a bypass it waits forever. When the hint is
// armed the window-low wait is skipped and the entry fires at level 0.

import { describe, expect, it } from 'vitest';
import type { Candle, TickInput } from '@app/strategy-core';
import type { TechnicalsBundle } from '@app/contracts';

import { evaluateGridBuy } from '../src/branches/grid-buy.js';
import { trailingTrade } from '../src/index.js';
import {
  initialTTState,
  type TTBundle,
  type TTConfig,
  type TTEntryHintBundle,
  type TTState,
} from '../src/schema.js';

const NOW_MS = 1_700_000_000_000;

const intervalRow = (interval: string) => ({
  interval,
  whenStrongBuy: true,
  whenBuy: true,
  whenSell: false,
  whenStrongSell: false,
  whenNeutral: false,
  mode: 'block' as const,
});

const sig = (
  recommendation: 'STRONG_BUY' | 'SELL' | 'STRONG_SELL',
): TechnicalsBundle['signals'][number]['signal'] => ({
  symbol: 'BTCUSDT',
  recommendation,
  maRecommendation: null,
  oscRecommendation: null,
  receivedAtMs: NOW_MS,
  indicators: null,
});

const tv = (recommendation: 'STRONG_BUY' | 'SELL' | 'STRONG_SELL'): TechnicalsBundle => ({
  config: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [intervalRow('5m')] },
  signals: [{ interval: '5m', signal: sig(recommendation) }],
});

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

// firstBuyTriggerBasis 'lowest-price' with a 5m technicals interval so the entry
// consults the TV gate (no forceTvOpen). STRONG_BUY passes the gate, isolating
// the lowest-price wait as the only thing that could return 'wait'.
const lowestPriceConfig = (): TTConfig =>
  trailingTrade.configSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '15' },
      avgEntryPriceRemoveThreshold: '0',
      firstBuyTriggerBasis: 'lowest-price',
      candleLimit: 3,
      gridLevels: [{ triggerPercentage: '1', maxPurchaseAmount: '15' }],
    },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [intervalRow('5m')] },
  }) as TTConfig;

// Window lows [100, 95, 98] → lowest = 95; level-0 trigger 1 → the lowest-price
// basis would only fire at price <= 95. A momentum pick at 96 trades above it.
const makeInput = (
  config: TTConfig,
  technicals: TechnicalsBundle,
  entryHint: TTEntryHintBundle | undefined,
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
    account: { balances: { USDT: { free: '1000', locked: '0' } }, readable: true },
    bundle: { technicals, override: null, entryHint },
  }) as unknown as TickInput<TTConfig, TTState, TTBundle>;

describe('evaluateGridBuy — enterOnAdd bypasses the lowest-price wait (issue #437)', () => {
  const strongBuy = tv('STRONG_BUY');

  it('hint armed: enters level 0 immediately above the window low (the fix)', () => {
    const result = evaluateGridBuy(
      makeInput(lowestPriceConfig(), strongBuy, { enterOnAdd: true }, '96'),
      initialTTState(),
      NOW_MS,
    );
    expect(result).toMatchObject({ kind: 'emit', level: 0 });
  });

  it('no hint: the lowest-price wait still holds above the window low (unchanged)', () => {
    const result = evaluateGridBuy(
      makeInput(lowestPriceConfig(), strongBuy, undefined, '96'),
      initialTTState(),
      NOW_MS,
    );
    expect(result.kind).toBe('wait');
  });

  it('enterOnAdd=false is not armed: the lowest-price wait still holds (unchanged)', () => {
    const result = evaluateGridBuy(
      makeInput(lowestPriceConfig(), strongBuy, { enterOnAdd: false }, '96'),
      initialTTState(),
      NOW_MS,
    );
    expect(result.kind).toBe('wait');
  });

  it('hint armed but price already at the window low: still enters level 0 (unchanged path)', () => {
    const result = evaluateGridBuy(
      makeInput(lowestPriceConfig(), strongBuy, { enterOnAdd: true }, '95'),
      initialTTState(),
      NOW_MS,
    );
    expect(result).toMatchObject({ kind: 'emit', level: 0 });
  });

  it('hint armed bypasses the wait but the Strong-Sell floor still vetoes a fresh STRONG_SELL', () => {
    const result = evaluateGridBuy(
      makeInput(lowestPriceConfig(), tv('STRONG_SELL'), { enterOnAdd: true }, '96'),
      initialTTState(),
      NOW_MS,
    );
    expect(result).toMatchObject({ kind: 'skip-tv', veto: 'technicals-sell', interval: '5m' });
  });
});
