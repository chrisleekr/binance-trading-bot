// Technicals entry-gate hysteresis (issue #472), tested against the pure tick():
//   - technicals.entryConfirmReads (default 1): the non-grid first-entry gate
//     must read ALLOW for this many CONSECUTIVE ticks before the first buy is
//     permitted. Below the threshold the tick blocks with reason
//     'technicals-confirming' { reads, required } and persists the streak in
//     state.entryConfirmCount; a veto read resets the streak to 0.
//   - entryConfirmReads=1 (default) permits on the first allow read — today's
//     behaviour, so the golden replay stays diff-0.

import { describe, expect, it } from 'vitest';
import {
  trailingTrade,
  TTBundleSchema,
  TTConfigSchema,
  type TTBundle,
  type TTConfig,
  type TTState,
} from '../src/index.js';
import type { TickInput } from '@app/strategy-core';
import { Decimal } from '@app/money';

const NOW_MS = 1_700_000_000_000;

const cfg = (entryConfirmReads: number): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '50' },
      avgEntryPriceRemoveThreshold: '0',
    },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    technicals: {
      useOnlyWithinMin: 2,
      ifExpires: 'do-not-buy',
      entryConfirmReads,
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
  });

type Rec = 'STRONG_BUY' | 'BUY' | 'SELL' | 'STRONG_SELL' | 'NEUTRAL';

const bundle = (c: TTConfig, recommendation: Rec): TTBundle =>
  TTBundleSchema.parse({
    technicals: {
      config: {
        useOnlyWithinMin: c.technicals.useOnlyWithinMin,
        ifExpires: c.technicals.ifExpires,
        intervals: c.technicals.intervals,
      },
      signals: [
        {
          interval: '1m',
          signal: {
            symbol: 'BTCUSDT',
            recommendation,
            maRecommendation: null,
            oscRecommendation: null,
            receivedAtMs: NOW_MS,
            indicators: null,
          },
        },
      ],
    },
    override: null,
  });

const input = (
  c: TTConfig,
  state: TTState,
  b: TTBundle,
): TickInput<TTConfig, TTState, TTBundle> => ({
  clock: { nowMs: () => NOW_MS },
  rng: { next: () => 0 },
  trigger: { kind: 'tick' },
  profile: {
    id: 'p1',
    userId: 'u1',
    binanceMode: 'test',
    status: 'running',
    strategyVersion: '2.0.0',
  },
  config: c,
  state,
  market: {
    symbol: 'BTCUSDT',
    currentPrice: '100',
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
  },
  account: {
    balances: { USDT: { asset: 'USDT', free: new Decimal('1000'), locked: new Decimal(0) } },
    readable: true,
  },
  openOrders: [],
  bundle: b,
  limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
});

const blockerView = (out: ReturnType<typeof trailingTrade.tick>) =>
  out.nextState.entryBlocker as {
    reason: string;
    detail?: { reads?: number; required?: number };
  } | null;

const emitted = (out: ReturnType<typeof trailingTrade.tick>): boolean =>
  out.decisions.some((d) => d.type === 'place-order');

describe('@app/strategy-trailing-trade technicals entry-confirm hysteresis', () => {
  it('entryConfirmReads=1 permits a first buy on the first allow read', () => {
    const c = cfg(1);
    const out = trailingTrade.tick(
      input(c, trailingTrade.initialState(c), bundle(c, 'STRONG_BUY')),
    );
    expect(emitted(out)).toBe(true);
    expect(out.nextState.entryConfirmCount).toBe(0);
  });

  it('entryConfirmReads=3 blocks the first two allow reads then permits the third', () => {
    const c = cfg(3);
    // Tick 1: first allow read ⇒ reads 1/3, blocked.
    const out1 = trailingTrade.tick(
      input(c, trailingTrade.initialState(c), bundle(c, 'STRONG_BUY')),
    );
    expect(emitted(out1)).toBe(false);
    expect(blockerView(out1)?.reason).toBe('technicals-confirming');
    expect(blockerView(out1)?.detail).toMatchObject({ reads: 1, required: 3 });
    expect(out1.nextState.entryConfirmCount).toBe(1);

    // Tick 2: second consecutive allow ⇒ reads 2/3, still blocked.
    const out2 = trailingTrade.tick(input(c, out1.nextState, bundle(c, 'STRONG_BUY')));
    expect(emitted(out2)).toBe(false);
    expect(blockerView(out2)?.detail).toMatchObject({ reads: 2, required: 3 });
    expect(out2.nextState.entryConfirmCount).toBe(2);

    // Tick 3: third consecutive allow ⇒ threshold reached, the buy fires.
    const out3 = trailingTrade.tick(input(c, out2.nextState, bundle(c, 'STRONG_BUY')));
    expect(emitted(out3)).toBe(true);
    expect(out3.nextState.entryConfirmCount).toBe(0);
  });

  it('a veto read mid-streak resets the confirm count to 0', () => {
    const c = cfg(3);
    const out1 = trailingTrade.tick(
      input(c, trailingTrade.initialState(c), bundle(c, 'STRONG_BUY')),
    );
    expect(out1.nextState.entryConfirmCount).toBe(1);

    // A SELL read vetoes and resets the streak.
    const out2 = trailingTrade.tick(input(c, out1.nextState, bundle(c, 'SELL')));
    expect(emitted(out2)).toBe(false);
    expect(blockerView(out2)?.reason).toBe('technicals-sell');
    expect(out2.nextState.entryConfirmCount).toBe(0);

    // The next allow read starts the streak over at 1/3.
    const out3 = trailingTrade.tick(input(c, out2.nextState, bundle(c, 'STRONG_BUY')));
    expect(blockerView(out3)?.detail).toMatchObject({ reads: 1, required: 3 });
    expect(out3.nextState.entryConfirmCount).toBe(1);
  });
});
