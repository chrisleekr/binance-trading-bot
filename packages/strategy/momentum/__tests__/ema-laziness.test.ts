import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '@app/money';
import type { Candle, TickInput } from '@app/strategy-core';

// Spied, not replaced: the EMA passes have no visible effect on a tick that never reads them, so a call count is the only thing that can tell a lazy tick from an eager one.
vi.mock('@app/indicators', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@app/indicators')>();
  return { ...actual, emaWithPrevious: vi.fn(actual.emaWithPrevious) };
});

import { emaWithPrevious } from '@app/indicators';
import {
  initialMomentumState,
  momentum,
  MomentumConfigSchema,
  MOMENTUM_STATE_SCHEMA_VERSION,
  type MomentumBundle,
  type MomentumConfig,
  type MomentumState,
} from '../src/index.js';

const candles: Candle[] = ['12', '10', '8', '9', '10', '11'].map((c, i) => ({
  openTimeMs: i * 3_600_000,
  closeTimeMs: (i + 1) * 3_600_000,
  open: c,
  high: c,
  low: c,
  close: c,
  volume: '1',
  isClosed: true,
}));

const held: MomentumState = {
  ...initialMomentumState(),
  schemaVersion: MOMENTUM_STATE_SCHEMA_VERSION,
  entryPrice: '10',
  highSinceEntry: '11',
  heldQuantity: '1',
};

const tickWith = (entryTrigger: MomentumConfig['entryTrigger'], state: MomentumState): void => {
  const input: TickInput<MomentumConfig, MomentumState, MomentumBundle> = {
    clock: { nowMs: () => 0 },
    rng: { next: () => 0 },
    trigger: { kind: 'tick' },
    profile: {
      id: 'p1',
      userId: 'u1',
      binanceMode: 'test',
      status: 'running',
      strategyVersion: '1.0.0',
    },
    config: MomentumConfigSchema.parse({
      candleInterval: '1h',
      entrySizing: { mode: 'fixed', amount: '140' },
      ema: { fast: 2, slow: 3 },
      trailingStopPct: '0.05',
      entryTrigger,
    }),
    state,
    market: {
      symbol: 'BTCUSDT',
      currentPrice: '11',
      candlesByInterval: { '1h': candles },
      symbolInfo: {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        status: 'TRADING',
        filters: {
          minNotional: '10',
          tickSize: '0.01',
          stepSize: '0.001',
          minQty: '0.001',
          maxQty: '100000',
          minPrice: '0.01',
          maxPrice: '1000000',
        },
      },
      indicatorsByInterval: {},
    },
    account: {
      balances: { USDT: { asset: 'USDT', free: new Decimal('100000'), locked: new Decimal('0') } },
      readable: true,
    },
    openOrders: [],
    bundle: { override: null },
    limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10_000 },
  };
  momentum.tick(input);
};

describe('EMA passes run only for a tick that reads them', () => {
  // Braces matter: vitest runs a function returned from beforeEach as a teardown, and mockClear returns the spy.
  beforeEach(() => {
    vi.mocked(emaWithPrevious).mockClear();
  });

  // The live worker ticks every flat symbol about once a second. These triggers judge the entry without the EMAs, so paying for them there is what pinned its thread.
  it.each([
    'maCluster',
    'exhaustion',
    'trendQuality',
    'breakout',
    'impulse',
    'obvLead',
    'weekendGap',
  ] as const)('a flat %s tick computes no EMA', (trigger) => {
    tickWith(trigger, initialMomentumState());
    expect(emaWithPrevious).not.toHaveBeenCalled();
  });

  // One pass per EMA however many times the tick reads the result: `trend` reads it for the signal and again for the hold log.
  it.each(['trend', 'cross'] as const)('a flat %s tick computes each EMA once', (trigger) => {
    tickWith(trigger, initialMomentumState());
    expect(emaWithPrevious).toHaveBeenCalledTimes(2);
  });

  it('a held tick computes each EMA once, whatever the entry trigger, for the cross-down exit', () => {
    tickWith('maCluster', held);
    expect(emaWithPrevious).toHaveBeenCalledTimes(2);
  });
});
