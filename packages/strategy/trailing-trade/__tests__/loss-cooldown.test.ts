// Loss-exit re-entry cooldown (issue #472), tested against the pure tick():
//   - buy.lossCooldownMinutes (default 60): after a LOSS exit (stop-loss, or a
//     force-sell / regime-exit taken below cost) the strategy refuses re-entry
//     while now - state.lastLossExitAt < window, surfacing
//     entryBlocker = { reason: 'loss-cooldown', detail: { minutesLeft } }.
//   - The stamp arms on a grid-stop-loss emit (always a loss) and on a regime
//     exit only when underwater; a profit-take (grid-sell) NEVER stamps, and the
//     technicals force-sell's profit guard means it never reaches a loss either.
//   - The stamp survives a full position close (clearedSellPosition does not
//     reset it) so the gate outlives the flat transition.

import { describe, expect, it } from 'vitest';
import {
  trailingTrade,
  TTBundleSchema,
  TTConfigSchema,
  type TTBundle,
  type TTConfig,
  type TTState,
} from '../src/index.js';
import { clearedSellPosition } from '../src/position-lifecycle.js';
import type { TickInput } from '@app/strategy-core';
import { Decimal } from '@app/money';

const NOW_MS = 1_700_000_000_000;
const MIN_MS = 60_000;

// A first-entry-enabled config: a 1m row that admits BUY-side signals so a
// flat profile would otherwise place a BUY. lossCooldownMinutes defaults to 60;
// callers override it per-case.
const cfg = (o?: { lossCooldownMinutes?: number }): TTConfig => {
  const base = TTConfigSchema.parse({
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
  if (o?.lossCooldownMinutes === undefined) return base;
  return { ...base, buy: { ...base.buy, lossCooldownMinutes: o.lossCooldownMinutes } };
};

// Bundle carrying a present 1m STRONG_BUY signal: enough to pass the entry gate.
const strongBuyBundle = (c: TTConfig, receivedAtMs: number): TTBundle =>
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
            recommendation: 'STRONG_BUY',
            maRecommendation: null,
            oscRecommendation: null,
            receivedAtMs,
            indicators: null,
          },
        },
      ],
    },
    override: null,
  });

const baseInput = (o: {
  config: TTConfig;
  state: TTState;
  bundle: TTBundle;
  nowMs: number;
  currentPrice?: string;
  btcFree?: string;
}): TickInput<TTConfig, TTState, TTBundle> => ({
  clock: { nowMs: () => o.nowMs },
  rng: { next: () => 0 },
  trigger: { kind: 'tick' },
  profile: {
    id: 'p1',
    userId: 'u1',
    binanceMode: 'test',
    status: 'running',
    strategyVersion: '2.0.0',
  },
  config: o.config,
  state: o.state,
  market: {
    symbol: 'BTCUSDT',
    currentPrice: o.currentPrice ?? '100',
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
    balances: {
      BTC: { asset: 'BTC', free: new Decimal(o.btcFree ?? '0'), locked: new Decimal(0) },
      USDT: { asset: 'USDT', free: new Decimal('1000'), locked: new Decimal(0) },
    },
    readable: true,
  },
  openOrders: [],
  bundle: o.bundle,
  limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
});

// A `loss-cooldown` structural view (the reason is not in the static union).
const blockerView = (out: ReturnType<typeof trailingTrade.tick>) =>
  out.nextState.entryBlocker as {
    reason: string;
    detail?: { minutesLeft?: number };
  } | null;

describe('@app/strategy-trailing-trade loss-exit re-entry cooldown', () => {
  it('blocks re-entry with loss-cooldown while inside the cooldown window', () => {
    const c = cfg({ lossCooldownMinutes: 60 });
    const exitedAt = NOW_MS - 30 * MIN_MS;
    const state = {
      ...trailingTrade.initialState(c),
      lastLossExitAt: exitedAt,
      lastLossExitReason: 'grid-stop-loss',
    } as TTState;

    const out = trailingTrade.tick(
      baseInput({ config: c, state, bundle: strongBuyBundle(c, NOW_MS), nowMs: NOW_MS }),
    );

    const view = blockerView(out);
    expect(view?.reason).toBe('loss-cooldown');
    expect(view?.detail?.minutesLeft).toBeGreaterThanOrEqual(29);
    expect(view?.detail?.minutesLeft).toBeLessThanOrEqual(31);
  });

  it('stamps lastLossExitAt on a grid-stop-loss exit', () => {
    const c = cfg();
    // Held at 100, price drops to 96 ⇒ 100 * 0.97 = 97 stop, 96 <= 97 fires.
    const state = {
      ...trailingTrade.initialState(c),
      avgEntryPrice: '100',
      heldQuantity: '1',
    } as TTState;
    const out = trailingTrade.tick(
      baseInput({
        config: c,
        state,
        bundle: strongBuyBundle(c, NOW_MS),
        nowMs: NOW_MS,
        currentPrice: '96',
        btcFree: '1',
      }),
    );
    // A SELL fired and the loss stamp armed.
    expect(out.decisions.some((dd) => dd.type === 'place-order')).toBe(true);
    expect(out.nextState.lastLossExitAt).toBe(NOW_MS);
    expect(out.nextState.lastLossExitReason).toBe('grid-stop-loss');
    expect(out.nextState.avgEntryPrice).toBeNull();
  });

  it('does NOT stamp on a profit-taking trailing exit (grid-sell)', () => {
    const c = cfg();
    // Armed trailing: highSinceBuy 110, price retraces to 107 (<= 110*0.98=107.8)
    // ⇒ trailing SELL at a PROFIT relative to the 100 entry. Must not stamp.
    const state = {
      ...trailingTrade.initialState(c),
      avgEntryPrice: '100',
      heldQuantity: '1',
      highSinceBuy: '110',
    } as TTState;
    const out = trailingTrade.tick(
      baseInput({
        config: c,
        state,
        bundle: strongBuyBundle(c, NOW_MS),
        nowMs: NOW_MS,
        currentPrice: '107',
        btcFree: '1',
      }),
    );
    expect(out.decisions.some((dd) => dd.type === 'place-order')).toBe(true);
    expect(out.nextState.avgEntryPrice).toBeNull();
    expect(out.nextState.lastLossExitAt).toBeNull();
    expect(out.nextState.lastLossExitReason).toBeNull();
  });

  it('does NOT block re-entry once the cooldown window has lapsed', () => {
    const c = cfg({ lossCooldownMinutes: 60 });
    // Exited 61 minutes ago: window passed, a fresh BUY may fire.
    const state = {
      ...trailingTrade.initialState(c),
      lastLossExitAt: NOW_MS - 61 * MIN_MS,
      lastLossExitReason: 'grid-stop-loss',
    } as TTState;
    const out = trailingTrade.tick(
      baseInput({ config: c, state, bundle: strongBuyBundle(c, NOW_MS), nowMs: NOW_MS }),
    );
    expect(out.decisions.some((dd) => dd.type === 'place-order')).toBe(true);
    expect(out.nextState.entryBlocker).toBeNull();
    // A successful re-entry clears the stamp.
    expect(out.nextState.lastLossExitAt).toBeNull();
    expect(out.nextState.lastLossExitReason).toBeNull();
  });

  it('lossCooldownMinutes=0 applies no cooldown even with a stamp', () => {
    const c = cfg({ lossCooldownMinutes: 0 });
    const state = {
      ...trailingTrade.initialState(c),
      lastLossExitAt: NOW_MS - MIN_MS,
      lastLossExitReason: 'grid-stop-loss',
    } as TTState;
    const out = trailingTrade.tick(
      baseInput({ config: c, state, bundle: strongBuyBundle(c, NOW_MS), nowMs: NOW_MS }),
    );
    expect(out.decisions.some((dd) => dd.type === 'place-order')).toBe(true);
    expect(out.nextState.entryBlocker).toBeNull();
  });

  it('clears the stamp on a successful re-entry', () => {
    const c = cfg({ lossCooldownMinutes: 30 });
    const state = {
      ...trailingTrade.initialState(c),
      lastLossExitAt: NOW_MS - 31 * MIN_MS,
      lastLossExitReason: 'regime-exit',
    } as TTState;
    const out = trailingTrade.tick(
      baseInput({ config: c, state, bundle: strongBuyBundle(c, NOW_MS), nowMs: NOW_MS }),
    );
    // A first buy emitted (avgEntryPrice is set later by the fill-adopter, not at
    // emit), and the loss-exit stamp is cleared so the next cycle starts clean.
    expect(out.decisions.some((dd) => dd.type === 'place-order')).toBe(true);
    expect(out.nextState.lastLossExitAt).toBeNull();
    expect(out.nextState.lastLossExitReason).toBeNull();
  });

  it('holds a due auto-trigger-buy timer while the loss cooldown is active', () => {
    // The re-arm timer is due, but a prior loss exit is still in cooldown: the
    // timer is held (no buy fires) and a tt-loss-cooldown-blocked log is emitted.
    const base = cfg({ lossCooldownMinutes: 60 });
    const c = {
      ...base,
      buy: { ...base.buy, autoTriggerBuy: { ...base.buy.autoTriggerBuy, enabled: true } },
    } as TTConfig;
    const state = {
      ...trailingTrade.initialState(c),
      autoTriggerBuyAtMs: NOW_MS - MIN_MS, // due
      lastLossExitAt: NOW_MS - 10 * MIN_MS, // 10m into a 60m cooldown
      lastLossExitReason: 'grid-stop-loss',
    } as TTState;
    const out = trailingTrade.tick(
      baseInput({ config: c, state, bundle: strongBuyBundle(c, NOW_MS), nowMs: NOW_MS }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.logs.some((l) => l.message === 'tt-loss-cooldown-blocked')).toBe(true);
    // Timer is held, not consumed.
    expect(out.nextState.autoTriggerBuyAtMs).toBe(NOW_MS - MIN_MS);
  });

  it('stamp→block chain: a stop-loss exit suppresses the next in-window entry', () => {
    // Drives the real two-step HMSTR loss-churn sequence rather than hand-setting
    // lastLossExitAt: tick 1 fires the grid-stop-loss (stamps), tick 2 feeds that
    // nextState back in a few minutes later and the otherwise-ready re-buy is
    // blocked by loss-cooldown.
    const c = cfg({ lossCooldownMinutes: 60 });

    // Tick 1: held at 100, price 96 ⇒ stop at 100*0.97=97, 96<=97 fires.
    const held = {
      ...trailingTrade.initialState(c),
      avgEntryPrice: '100',
      heldQuantity: '1',
    } as TTState;
    const out1 = trailingTrade.tick(
      baseInput({
        config: c,
        state: held,
        bundle: strongBuyBundle(c, NOW_MS),
        nowMs: NOW_MS,
        currentPrice: '96',
        btcFree: '1',
      }),
    );
    // The stop-loss SELL fired and the loss cooldown armed.
    const sell = out1.decisions.find((dd) => dd.type === 'place-order');
    expect(sell).toBeDefined();
    expect((sell as { intent: { side: string } }).intent.side).toBe('SELL');
    expect(out1.nextState.lastLossExitAt).toBe(NOW_MS);
    expect(out1.nextState.lastLossExitReason).toBe('grid-stop-loss');
    expect(out1.nextState.avgEntryPrice).toBeNull();

    // Tick 2: now flat, 5 minutes later, entry would otherwise proceed.
    const later = NOW_MS + 5 * MIN_MS;
    const out2 = trailingTrade.tick(
      baseInput({
        config: c,
        state: out1.nextState,
        bundle: strongBuyBundle(c, later),
        nowMs: later,
        currentPrice: '100',
      }),
    );
    const view = blockerView(out2);
    expect(view?.reason).toBe('loss-cooldown');
    // 60 minute window, 5 elapsed ⇒ ~55 left.
    expect(view?.detail?.minutesLeft).toBeGreaterThanOrEqual(54);
    expect(view?.detail?.minutesLeft).toBeLessThanOrEqual(55);
    // The re-buy is suppressed: no place-order this tick.
    expect(out2.decisions.some((dd) => dd.type === 'place-order')).toBe(false);
    // The stamp persists through the blocked tick.
    expect(out2.nextState.lastLossExitAt).toBe(NOW_MS);
    expect(out2.nextState.lastLossExitReason).toBe('grid-stop-loss');
  });

  it('a profitable technicals force-sell does NOT stamp the loss cooldown', () => {
    // Pins the invariant the dead loss-stamp branch depends on: the force-sell
    // evaluator's profit guard means it only ever sells in profit, so its
    // lossExitStamp call returns empty. If someone weakens that guard, this test
    // catches the now-live stamp.
    //
    // Config: 1m interval with whenSell so force-sell can arm, confirm window 0
    // so it emits on the first matching tick (a sub-1h interval otherwise
    // defaults confirmMinutes to 1).
    const base = TTConfigSchema.parse({
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
        forceSellConfirmMinutes: 0,
        forceSellReentryCooldownMinutes: 0,
        intervals: [
          {
            interval: '1m',
            whenStrongBuy: false,
            whenBuy: false,
            whenSell: true,
            whenStrongSell: false,
            whenNeutral: false,
          },
        ],
      },
    });

    // Held in profit at entry 100, current 103: below the 105 sell trigger
    // (100*1.05) so the standard ladder is idle, and above entry so the profit
    // guard passes ⇒ a SELL force-sell signal emits.
    const state = {
      ...trailingTrade.initialState(base),
      avgEntryPrice: '100',
      heldQuantity: '1',
    } as TTState;
    const sellBundle = TTBundleSchema.parse({
      technicals: {
        config: {
          useOnlyWithinMin: base.technicals.useOnlyWithinMin,
          ifExpires: base.technicals.ifExpires,
          intervals: base.technicals.intervals,
        },
        signals: [
          {
            interval: '1m',
            signal: {
              symbol: 'BTCUSDT',
              recommendation: 'SELL',
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
    const out = trailingTrade.tick(
      baseInput({
        config: base,
        state,
        bundle: sellBundle,
        nowMs: NOW_MS,
        currentPrice: '103',
        btcFree: '1',
      }),
    );
    // A force-sell SELL emitted in profit.
    const sell = out.decisions.find((dd) => dd.type === 'place-order');
    expect(sell).toBeDefined();
    expect((sell as { intent: { side: string } }).intent.side).toBe('SELL');
    expect(out.nextState.avgEntryPrice).toBeNull();
    // The profit guard means no loss stamp.
    expect(out.nextState.lastLossExitAt).toBeNull();
    expect(out.nextState.lastLossExitReason).toBeNull();
  });

  it('survives a full position close (clearedSellPosition keeps the stamp)', () => {
    // clearedSellPosition must not reset lastLossExitAt / lastLossExitReason.
    const reset = clearedSellPosition(null) as Record<string, unknown>;
    expect('lastLossExitAt' in reset).toBe(false);
    expect('lastLossExitReason' in reset).toBe(false);
    // entryConfirmCount IS reset on close.
    expect(reset.entryConfirmCount).toBe(0);
  });
});
