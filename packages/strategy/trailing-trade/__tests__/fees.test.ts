// Fee-awareness: the strategy is otherwise fee-blind, so a profit-taking exit
// can fire on a gross gain that is a net loss after the round-trip cost. The
// fees helpers and the trigger-arm fee floor close that gap, and reduce to the
// pre-fee behaviour exactly when fees are unset (golden-replay diff = 0).

import { describe, expect, it } from 'vitest';
import {
  roundTripFeeFraction,
  roundTripFeePercent,
  effectiveForceSellMinProfitPercent,
} from '../src/fees.js';
import { evaluateSellGate } from '../src/branches/sell-gate.js';
import type { TTConfig, TTState, TTBundle } from '../src/schema.js';
import type { TickInput } from '@app/strategy-core';

const cfg = (fees?: Record<string, unknown>, sell: Record<string, unknown> = {}): TTConfig =>
  ({ sell: { forceSellMinProfitPercent: '0', ...sell }, ...(fees ? { fees } : {}) }) as TTConfig;

describe('roundTripFeeFraction', () => {
  it('is zero when fees are absent (raw config from the worker)', () => {
    expect(roundTripFeeFraction(cfg()).toFixed()).toBe('0');
  });

  it('is zero for an explicit 0 or a corrupt taker fee', () => {
    expect(roundTripFeeFraction(cfg({ takerBps: '0' })).toFixed()).toBe('0');
    expect(roundTripFeeFraction(cfg({ takerBps: 'abc' })).toFixed()).toBe('0');
  });

  it('doubles the taker bps into a price fraction (10 bp/leg => 0.002)', () => {
    expect(roundTripFeeFraction(cfg({ takerBps: '10' })).toFixed()).toBe('0.002');
  });
});

describe('roundTripFeePercent', () => {
  it('expresses the round trip in percent units (10 bp/leg => 0.2)', () => {
    expect(roundTripFeePercent(cfg({ takerBps: '10' })).toFixed()).toBe('0.2');
  });
});

describe('effectiveForceSellMinProfitPercent', () => {
  it('returns the configured value verbatim when fees are unset', () => {
    expect(
      effectiveForceSellMinProfitPercent(cfg(undefined, { forceSellMinProfitPercent: '0.3' })),
    ).toBe('0.3');
  });

  it('returns 0 when both the floor and the fee are 0', () => {
    expect(effectiveForceSellMinProfitPercent(cfg())).toBe('0');
  });

  it('lifts the floor to the round-trip fee when the fee is larger', () => {
    // taker 10 bp/leg => 0.2% round trip > configured 0.1%.
    expect(
      effectiveForceSellMinProfitPercent(
        cfg({ takerBps: '10' }, { forceSellMinProfitPercent: '0.1' }),
      ),
    ).toBe('0.2');
  });

  it('keeps the operator floor when it already exceeds the fee', () => {
    expect(
      effectiveForceSellMinProfitPercent(
        cfg({ takerBps: '10' }, { forceSellMinProfitPercent: '0.5' }),
      ),
    ).toBe('0.5');
  });

  it('treats a corrupt floor as 0 (raw config from the worker)', () => {
    // safeDecimal('abc') === null exercises the `?? new Decimal(0)` fallback, so
    // a missing/corrupt forceSellMinProfitPercent on a raw stored row still falls
    // to the fee floor rather than crashing the tick.
    expect(
      effectiveForceSellMinProfitPercent(
        cfg({ takerBps: '10' }, { forceSellMinProfitPercent: 'abc' }),
      ),
    ).toBe('0.2');
  });
});

const SYMBOL_INFO = {
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
} as const;

const armInput = (
  fees: Record<string, unknown> | undefined,
  currentPrice: string,
): TickInput<TTConfig, TTState, TTBundle> =>
  ({
    config: {
      sell: {
        atrTrailing: { enabled: false, period: 14, multiplier: '3' },
        discoveryTimeStopBars: 0,
        stopLossPercentage: '',
        triggerPercentage: '1.05',
        trailingStopPercentage: '',
        forceSellMinProfitPercent: '0',
      },
      buy: {},
      candleInterval: '1h',
      ...(fees ? { fees } : {}),
    },
    market: { symbol: 'BTCUSDT', currentPrice, candlesByInterval: {}, symbolInfo: SYMBOL_INFO },
    openOrders: [],
    bundle: { technicals: {}, override: null },
    profile: { id: 'p1' },
    account: { balances: {}, readable: true },
  }) as unknown as TickInput<TTConfig, TTState, TTBundle>;

const heldState = (): TTState =>
  ({ avgEntryPrice: '100', highSinceBuy: null }) as unknown as TTState;

describe('evaluateSellGate — trigger-arm fee floor', () => {
  // avgEntry 100, gross trigger 1.05 => arms at >= 105. taker 300 bp/leg =>
  // round trip 6% => fee floor lifts the arm to >= 106.
  it('does NOT arm the trail between the gross trigger and the fee floor when fees are set', () => {
    const out = evaluateSellGate(armInput({ takerBps: '300' }, '105.5'), heldState());
    expect(out.kind).toBe('noop');
  });

  it('arms at the same price when fees are unset (proves the floor is what blocks it)', () => {
    const out = evaluateSellGate(armInput(undefined, '105.5'), heldState());
    expect(out.kind).toBe('bump-high');
  });

  it('arms once price clears the fee floor', () => {
    const out = evaluateSellGate(armInput({ takerBps: '300' }, '106.5'), heldState());
    expect(out.kind).toBe('bump-high');
  });
});
